/**
 * Auto-downloads all media from the current Telegram channel/chat.
 * Supports both web.telegram.org/a and web.telegram.org/k.
 */
import browser from "webextension-polyfill";
import { detectTelegramVersion, extractAllMediaFromMessage, findMessageRoots } from "@/content-script/catalog";
import type {
  ChannelDlCheckPageResponse,
  ChannelDlPeekResponse,
  ChannelDlStatusResponse,
  ChannelDownloadLimits,
  ChannelDownloadOptions,
  DownloadableItem,
  ExtensionMessage,
  VideoDownloadEventDetail,
} from "@/types/messages";

type MediaKind = "video" | "image" | "document";
type MediaTypeFlags = Record<MediaKind, boolean>;
const MEDIA_KINDS: readonly MediaKind[] = ["video", "image", "document"];
const NO_LIMITS: ChannelDownloadLimits = { video: 0, image: 0, document: 0, total: 0 };

/**
 * Pacing. The point is to walk a whole channel's history without hammering Telegram: one scroll step
 * per ~2s (its history pagination fires on scroll), and downloads run strictly one-at-a-time — the next
 * only starts once the MAIN-world downloader reports the current one finished (or times out).
 */
const SCROLL_STEP_DELAY_MS = 1900;
const BETWEEN_DOWNLOADS_MS = 600;
const DOWNLOAD_TIMEOUT_MS = 150_000;
const MAX_SCROLL_ROUNDS = 6000; // hard safety cap against an unbounded loop
const STAGNANT_ROUNDS_TO_FINISH = 6; // rounds sat at the top with nothing new before we call it done

let running = false;
let paused = false;
let stopRequested = false;
let totalFound = 0;
let totalDownloaded = 0;
let seenUrls = new Set<string>();
let mediaTypes: MediaTypeFlags = { video: true, image: true, document: true };
let limits: ChannelDownloadLimits = { ...NO_LIMITS };
/** How many of each kind this run has dispatched — the counter the caps are checked against (a timed-out download still counts, so a cap can't be blown by retries). */
let dispatchedByKind: Record<MediaKind, number> = { video: 0, image: 0, document: 0 };
let zipMode = false;
/** Zip mode doesn't stream files one by one — it collects the whole list and hands it to the MAIN-world
 *  downloader at the end, which fetches + archives them in the page context. See `dispatchDownload`. */
let zipBatch: DownloadableItem[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeName(str: string): string {
  return (str || "tg_channel")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .substring(0, 60);
}

/**
 * The message list's own scroll viewport. Telegram renames its layout classes freely (that's what broke
 * the inline buttons), so don't trust a fixed selector list: walk up from a real message element until
 * an ancestor is actually vertically scrollable, and only fall back to known selectors / the document.
 */
function getScrollContainer(): HTMLElement {
  let node = (findMessageRoots(detectTelegramVersion())[0] as HTMLElement | undefined) ?? null;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if (node.scrollHeight > node.clientHeight + 40 && (overflowY === "auto" || overflowY === "scroll")) return node;
    node = node.parentElement;
  }
  for (const sel of [".messages-container", ".MessageList", ".bubbles", ".scrollable-y", ".chat .scrollable"]) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && el.scrollHeight > el.clientHeight) return el;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

function getChannelTitle(): string {
  return (
    document
      .querySelector(".chat-info .peer-title, .chat-title, .MiddleHeader .title, .TopBar .user-title, .peer-title")
      ?.textContent?.trim() ?? ""
  );
}

function kindOf(item: DownloadableItem): MediaKind {
  return item.kind === "image" || item.kind === "document" ? item.kind : "video";
}

/**
 * Best-effort document extraction for a message root. Telegram Web mostly downloads file attachments via
 * an in-page JS click with no stable URL, so this only catches the cases that *do* expose one — a real
 * `href` on the download control, or a `progressive/document…` link. Empty result is expected & fine.
 */
function extractDocsFromMessage(root: Element): DownloadableItem[] {
  const out: DownloadableItem[] = [];
  const anchors = root.querySelectorAll<HTMLAnchorElement>(
    'a[href*="progressive/document"], a[href][download], .File a[href], .document a[href], a.media-document[href]',
  );
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("data:") || href === "#") continue;
    out.push({ videoUrl: href, videoId: href, page: "channel", downloadId: href, kind: "document" });
  }
  return out;
}

/** Every downloadable media item currently in the DOM, via the same extraction the inline buttons use.
 *  `withThumbnail` stays off — the channel flow never renders a thumbnail, and the canvas capture is the
 *  costly part of extraction (matters for the scroll-driven recount, which runs on every scroll idle). */
function scanVisibleMedia(types: MediaTypeFlags): DownloadableItem[] {
  const out: DownloadableItem[] = [];
  for (const root of findMessageRoots(detectTelegramVersion())) {
    for (const { item } of extractAllMediaFromMessage(root, false, false)) {
      if (types[kindOf(item)]) out.push(item);
    }
    if (types.document) out.push(...extractDocsFromMessage(root));
  }
  return out;
}

/** Coerce whatever the popup sent into 4 non-negative integers (0 = no limit). */
function normalizeLimits(raw: ChannelDownloadLimits | undefined): ChannelDownloadLimits {
  const clean = (n: unknown) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 0);
  return raw
    ? { video: clean(raw.video), image: clean(raw.image), document: clean(raw.document), total: clean(raw.total) }
    : { ...NO_LIMITS };
}

function dispatchedTotal(): number {
  return dispatchedByKind.video + dispatchedByKind.image + dispatchedByKind.document;
}

/** This kind can't take any more (its own cap, or the total cap, is full). */
function kindCapReached(kind: MediaKind): boolean {
  if (limits.total > 0 && dispatchedTotal() >= limits.total) return true;
  return limits[kind] > 0 && dispatchedByKind[kind] >= limits[kind];
}

/** Nothing left this run can do — the total cap is full, or every *selected* kind has hit its own cap. */
function allCapsReached(): boolean {
  if (limits.total > 0 && dispatchedTotal() >= limits.total) return true;
  const selected = MEDIA_KINDS.filter((k) => mediaTypes[k]);
  return selected.length > 0 && selected.every((k) => limits[k] > 0 && dispatchedByKind[k] >= limits[k]);
}

/** Why (if at all) the scroll-and-download loop should stop this round. */
function loopFinishReason(atTop: boolean, stagnantAtTop: number): string | null {
  if (allCapsReached()) return "Download limit reached";
  if (atTop && stagnantAtTop >= STAGNANT_ROUNDS_TO_FINISH) return "Reached start of channel";
  return null;
}

/**
 * Media on screen that hasn't been handled yet. Deliberately does *not* mark items seen — the caller
 * does that only right before it actually dispatches each one, so anything left unprocessed when the
 * user pauses/stops mid-batch is picked up again on the next pass instead of being silently skipped.
 */
function collectNewMedia(): DownloadableItem[] {
  return scanVisibleMedia(mediaTypes).filter((item) => !seenUrls.has(item.videoUrl));
}

/** Read-only count of what's currently visible — the popup's "Found" preview before Start, and manual re-scan. */
function countVisibleMedia(types: MediaTypeFlags): number {
  const seen = new Set<string>();
  for (const item of scanVisibleMedia(types)) seen.add(item.videoUrl);
  return seen.size;
}

/* ─── live "currently visible" count while the popup's Channel tab is open ──────────────────────────
 * The popup opens a watch (`channel_dl_watch`) on mount and closes it (`channel_dl_unwatch`) on unmount,
 * so this does zero work when nobody's looking. While watching: a passive scroll listener, trailing-
 * debounced, recounts only after scrolling settles and only pushes a message when the number changed. */
let peekWatching = false;
let peekTypes: MediaTypeFlags = { video: true, image: true, document: true };
let peekScroller: HTMLElement | undefined;
let peekDebounce: ReturnType<typeof setTimeout> | undefined;
let lastPeekCount = -1;

function pushPeekCount(): void {
  if (!peekWatching || running) return;
  const count = countVisibleMedia(peekTypes);
  if (count === lastPeekCount) return;
  lastPeekCount = count;
  void browser.runtime.sendMessage({ type: "channel_dl_found", found: count }).catch(() => undefined);
}

function onPeekScroll(): void {
  if (peekDebounce) clearTimeout(peekDebounce);
  peekDebounce = setTimeout(pushPeekCount, 450);
}

function startPeekWatch(types: MediaTypeFlags): void {
  peekTypes = types;
  lastPeekCount = -1;
  if (!peekWatching) {
    peekWatching = true;
    peekScroller = getScrollContainer();
    peekScroller.addEventListener("scroll", onPeekScroll, { passive: true });
  }
  pushPeekCount(); // immediate value for the new/updated watch
}

function stopPeekWatch(): void {
  peekWatching = false;
  peekScroller?.removeEventListener("scroll", onPeekScroll);
  peekScroller = undefined;
  if (peekDebounce) {
    clearTimeout(peekDebounce);
    peekDebounce = undefined;
  }
}

/**
 * Channel media `src`es are the same virtual `web.telegram.org/{a,k}/progressive/…` (and sometimes
 * `blob:`) URLs the inline buttons handle — only the *page's own* service worker can turn them into real
 * bytes with the logged-in Telegram session. Handing the bare URL to `chrome.downloads` from the
 * background worker (what this used to do) fetched it with no session and saved the SPA's HTML shell as
 * `video_….htm` ("Site wasn't available"). So route every item through the exact channel the inline
 * buttons use: a `video_download` CustomEvent that content-script-inject picks up in the page's MAIN
 * world, where it does the range-chunked fetch, reassembly and save.
 */
function dispatchToInjector(detail: VideoDownloadEventDetail): void {
  document.dispatchEvent(new CustomEvent<VideoDownloadEventDetail>("video_download", { detail }));
}

/**
 * Resolves when content-script-inject reports this download finished (progress ≥ 100) — or on timeout.
 * The injector emits `<downloadId>_video_download_progress` CustomEvents on `document` as it fetches;
 * gating the next dispatch on this keeps channel downloads strictly sequential and gentle on the CDN.
 */
function waitForInjectorDownload(downloadId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const eventName = `${downloadId}_video_download_progress`;
    const finish = (ok: boolean) => {
      document.removeEventListener(eventName, onProgress);
      clearTimeout(timer);
      resolve(ok);
    };
    const onProgress = (e: Event) => {
      if (((e as CustomEvent<{ progress: number }>).detail?.progress ?? 0) >= 100) finish(true);
    };
    const timer = setTimeout(() => finish(false), DOWNLOAD_TIMEOUT_MS);
    document.addEventListener(eventName, onProgress);
  });
}

async function dispatchDownload(item: DownloadableItem): Promise<void> {
  if (zipMode) {
    zipBatch.push(item);
    sendStatus(`Queued for zip: ${item.kind ?? "media"} ${item.videoId}`);
    return;
  }
  dispatchToInjector({ type: "single", item });
  sendStatus(`Downloading ${totalDownloaded + 1}/${totalFound}: ${item.kind ?? "media"}`);
  const ok = await waitForInjectorDownload(item.downloadId);
  if (ok) totalDownloaded++;
  else sendStatus(`⚠ Timed out on ${item.videoId} — moving on`);
}

/** Download (or, in zip mode, queue) every not-yet-seen media item currently on screen, one at a time,
 *  honouring the per-type and total caps. */
async function processVisibleBatch(): Promise<void> {
  for (const item of collectNewMedia()) {
    if (stopRequested || paused) return;
    const kind = kindOf(item);

    seenUrls.add(item.videoUrl); // mark now — a paused batch resumes cleanly (see collectNewMedia)
    if (kindCapReached(kind)) continue; // over this kind's (or the total) cap — skip, stay marked seen

    totalFound++;
    dispatchedByKind[kind]++;
    await dispatchDownload(item);
    if (!zipMode) await sleep(BETWEEN_DOWNLOADS_MS);
  }
}

function sendStatus(message: string, extra: { folder?: string; done?: boolean } = {}): void {
  const status: ExtensionMessage = {
    type: "channel_dl_status",
    message,
    found: totalFound,
    downloaded: totalDownloaded,
    running,
    paused,
    ...extra,
  };
  void browser.runtime.sendMessage(status).catch(() => undefined);
  updateFloatingPanel(message);
}

async function runChannelDownload(options: Partial<ChannelDownloadOptions> = {}): Promise<void> {
  if (running) {
    sendStatus("Already running");
    return;
  }

  running = true;
  paused = false;
  stopRequested = false;
  seenUrls = new Set();
  totalFound = 0;
  totalDownloaded = 0;
  mediaTypes = {
    video: options.video !== false,
    image: options.image !== false,
    document: options.document !== false,
  };
  limits = normalizeLimits(options.limits);
  dispatchedByKind = { video: 0, image: 0, document: 0 };
  zipMode = options.zip === true;
  zipBatch = [];
  const saveFolder = options.folder ?? "";

  const channelTitle = safeName(getChannelTitle() || "tg_channel");
  const folderName = (saveFolder ? `${safeName(saveFolder)}/` : "") + channelTitle;

  sendStatus("Starting — jumping to newest message…", { folder: folderName });

  const scroller = getScrollContainer();
  scroller.scrollTop = scroller.scrollHeight; // start at the newest message
  await sleep(1500);

  // Walk history upward: collect what's on screen, download it (one at a time), step up ~one screenful,
  // let Telegram page in older messages, repeat. Stops on a cap, on reaching the channel start, or on Stop.
  let stagnantAtTop = 0;

  for (let round = 0; round < MAX_SCROLL_ROUNDS && !stopRequested; round++) {
    if (paused) {
      await sleep(300);
      continue;
    }

    const foundBefore = totalFound;
    await processVisibleBatch();
    if (paused) continue;

    const atTop = scroller.scrollTop <= 4;
    stagnantAtTop = atTop && totalFound === foundBefore ? stagnantAtTop + 1 : 0;

    const finishReason = loopFinishReason(atTop, stagnantAtTop);
    if (finishReason) {
      sendStatus(finishReason, { done: true });
      break;
    }

    scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * 0.85);
    await sleep(SCROLL_STEP_DELAY_MS);
  }

  finalizeZipIfNeeded(folderName);

  running = false;
  paused = false;
  stopRequested = false;
  lastPeekCount = -1; // let the scroll watcher push a fresh count again now that the run is over
  sendStatus(`Done! ${totalDownloaded} file(s) downloaded`, { done: true });
}

function finalizeZipIfNeeded(folderName: string): void {
  if (!zipMode || zipBatch.length === 0) return;

  sendStatus(`Zipping ${zipBatch.length} file(s)…`);
  // Same MAIN-world downloader as the single path — it fetches every item's bytes in the page context,
  // builds the archive there, and triggers one download.
  dispatchToInjector({
    type: "batch",
    items: zipBatch,
    zip: true,
    zipName: `${folderName.replaceAll("/", "_")}.zip`,
  });
}

browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (response: unknown) => void): true => {
  const message = raw as ExtensionMessage;

  switch (message.type) {
    case "channel_dl_start":
      void runChannelDownload(message.options);
      sendResponse({ ok: true });
      break;
    case "channel_dl_stop":
      stopRequested = true;
      running = false;
      paused = false;
      sendStatus("Stopped by user", { done: true });
      sendResponse({ ok: true });
      break;
    case "channel_dl_pause":
      paused = true;
      sendStatus("Paused");
      sendResponse({ ok: true });
      break;
    case "channel_dl_resume":
      paused = false;
      sendStatus("Resuming…");
      sendResponse({ ok: true });
      break;
    case "channel_dl_get_status": {
      const response: ChannelDlStatusResponse = { running, paused, found: totalFound, downloaded: totalDownloaded };
      sendResponse(response);
      break;
    }
    case "channel_dl_check_page": {
      const response: ChannelDlCheckPageResponse = {
        onTg: window.location.href.includes("web.telegram.org"),
        version: detectTelegramVersion(),
        channelTitle: getChannelTitle(),
      };
      sendResponse(response);
      break;
    }
    case "channel_dl_peek": {
      const response: ChannelDlPeekResponse = { found: countVisibleMedia(message.mediaTypes) };
      sendResponse(response);
      break;
    }
    case "channel_dl_watch":
      startPeekWatch(message.mediaTypes);
      sendResponse({ ok: true });
      break;
    case "channel_dl_unwatch":
      stopPeekWatch();
      sendResponse({ ok: true });
      break;
    case "channel_dl_open_panel":
      injectFloatingPanel();
      break;
    default:
      break;
  }
  return true;
});

/* ─── floating in-page control panel ────────────────────────────────────── */

function injectFloatingPanel(): void {
  if (document.getElementById("tgdl-channel-panel")) return;

  const panel = document.createElement("div");
  panel.id = "tgdl-channel-panel";
  panel.innerHTML = `
    <div id="tgdl-panel-header">
      <span>📥 Channel DL</span>
      <button id="tgdl-panel-close" title="Close">✕</button>
    </div>
    <div id="tgdl-panel-body">
      <div class="tgdl-row">
        <label>Save folder (optional)</label>
        <input id="tgdl-folder" type="text" placeholder="e.g. TelegramMedia" />
      </div>
      <div class="tgdl-row tgdl-types">
        <label><input type="checkbox" id="tgdl-chk-video" checked /> Videos</label>
        <label><input type="checkbox" id="tgdl-chk-image" checked /> Images</label>
        <label><input type="checkbox" id="tgdl-chk-doc" /> Documents</label>
      </div>
      <div class="tgdl-row tgdl-btns">
        <button id="tgdl-start-btn">▶ Start</button>
        <button id="tgdl-pause-btn" disabled>⏸ Pause</button>
        <button id="tgdl-stop-btn" disabled>■ Stop</button>
      </div>
      <div id="tgdl-progress">
        <span id="tgdl-status-text">Ready</span>
        <div id="tgdl-counts">
          Found: <b id="tgdl-found">0</b> &nbsp;|&nbsp; Downloaded: <b id="tgdl-dled">0</b>
        </div>
      </div>
    </div>
  `;

  const style = document.createElement("style");
  style.textContent = `
    #tgdl-channel-panel { position: fixed; bottom: 80px; right: 16px; width: 280px; background: #1e1e2e; color: #cdd6f4; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.45); font-family: sans-serif; font-size: 13px; z-index: 99999; user-select: none; }
    #tgdl-panel-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px 8px; font-weight: 700; font-size: 14px; border-bottom: 1px solid #313244; cursor: move; }
    #tgdl-panel-close { background: none; border: none; color: #f38ba8; font-size: 16px; cursor: pointer; line-height: 1; }
    #tgdl-panel-body { padding: 12px 14px; }
    .tgdl-row { margin-bottom: 10px; }
    .tgdl-row label { display: block; margin-bottom: 4px; font-size: 11px; color: #a6adc8; }
    #tgdl-folder { width: 100%; box-sizing: border-box; padding: 5px 8px; background: #313244; border: 1px solid #45475a; border-radius: 6px; color: #cdd6f4; font-size: 12px; outline: none; }
    .tgdl-types { display: flex; gap: 10px; }
    .tgdl-types label { color: #cdd6f4; font-size: 12px; display: flex; align-items: center; gap: 4px; }
    .tgdl-btns { display: flex; gap: 8px; }
    .tgdl-btns button { flex: 1; padding: 7px 0; border: none; border-radius: 7px; font-size: 12px; font-weight: 700; cursor: pointer; }
    #tgdl-start-btn { background: #a6e3a1; color: #1e1e2e; }
    #tgdl-start-btn:disabled { background: #45475a; color: #6c7086; cursor: not-allowed; }
    #tgdl-pause-btn { background: #f9e2af; color: #1e1e2e; }
    #tgdl-pause-btn:disabled { background: #45475a; color: #6c7086; cursor: not-allowed; }
    #tgdl-stop-btn { background: #f38ba8; color: #1e1e2e; }
    #tgdl-stop-btn:disabled { background: #45475a; color: #6c7086; cursor: not-allowed; }
    #tgdl-progress { margin-top: 8px; padding: 8px 10px; background: #181825; border-radius: 8px; }
    #tgdl-status-text { display: block; margin-bottom: 4px; color: #89b4fa; font-size: 11px; word-break: break-all; }
    #tgdl-counts { color: #a6adc8; font-size: 11px; }
    #tgdl-counts b { color: #cba6f7; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  let dragX = 0;
  let dragY = 0;
  let dragging = false;
  const header = panel.querySelector<HTMLElement>("#tgdl-panel-header")!;
  header.addEventListener("mousedown", (e) => {
    dragging = true;
    dragX = e.clientX - panel.getBoundingClientRect().left;
    dragY = e.clientY - panel.getBoundingClientRect().top;
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panel.style.left = `${e.clientX - dragX}px`;
    panel.style.top = `${e.clientY - dragY}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  });
  document.addEventListener("mouseup", () => {
    dragging = false;
  });

  panel.querySelector("#tgdl-panel-close")!.addEventListener("click", () => panel.remove());

  panel.querySelector("#tgdl-start-btn")!.addEventListener("click", () => {
    const folder = panel.querySelector<HTMLInputElement>("#tgdl-folder")!.value.trim();
    const video = panel.querySelector<HTMLInputElement>("#tgdl-chk-video")!.checked;
    const image = panel.querySelector<HTMLInputElement>("#tgdl-chk-image")!.checked;
    const doc = panel.querySelector<HTMLInputElement>("#tgdl-chk-doc")!.checked;
    if (!video && !image && !doc) {
      panel.querySelector("#tgdl-status-text")!.textContent = "⚠ Select at least one media type";
      return;
    }
    panel.querySelector<HTMLButtonElement>("#tgdl-start-btn")!.disabled = true;
    panel.querySelector<HTMLButtonElement>("#tgdl-pause-btn")!.disabled = false;
    panel.querySelector<HTMLButtonElement>("#tgdl-stop-btn")!.disabled = false;
    void runChannelDownload({ folder, video, image, document: doc, zip: false });
  });

  panel.querySelector("#tgdl-pause-btn")!.addEventListener("click", () => {
    const btn = panel.querySelector<HTMLButtonElement>("#tgdl-pause-btn")!;
    if (paused) {
      paused = false;
      btn.textContent = "⏸ Pause";
    } else {
      paused = true;
      btn.textContent = "▶ Resume";
    }
  });

  panel.querySelector("#tgdl-stop-btn")!.addEventListener("click", () => {
    stopRequested = true;
    paused = false;
    panel.querySelector<HTMLButtonElement>("#tgdl-pause-btn")!.disabled = true;
    panel.querySelector<HTMLButtonElement>("#tgdl-stop-btn")!.disabled = true;
    panel.querySelector<HTMLButtonElement>("#tgdl-start-btn")!.disabled = false;
    panel.querySelector("#tgdl-status-text")!.textContent = "Stopping…";
  });
}

function updateFloatingPanel(message: string): void {
  const panel = document.getElementById("tgdl-channel-panel");
  if (!panel) return;
  panel.querySelector("#tgdl-status-text")!.textContent = message;
  panel.querySelector("#tgdl-found")!.textContent = String(totalFound);
  panel.querySelector("#tgdl-dled")!.textContent = String(totalDownloaded);
  if (!running) {
    const startBtn = panel.querySelector<HTMLButtonElement>("#tgdl-start-btn");
    const pauseBtn = panel.querySelector<HTMLButtonElement>("#tgdl-pause-btn");
    const stopBtn = panel.querySelector<HTMLButtonElement>("#tgdl-stop-btn");
    if (startBtn) startBtn.disabled = false;
    if (pauseBtn) {
      pauseBtn.disabled = true;
      pauseBtn.textContent = "⏸ Pause";
    }
    if (stopBtn) stopBtn.disabled = true;
  }
}
