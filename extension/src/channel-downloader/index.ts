/**
 * Auto-downloads all media from the current Telegram channel/chat.
 * Supports both web.telegram.org/a and web.telegram.org/k.
 */
import browser from "webextension-polyfill";
import { detectTelegramVersion, extractAllMediaFromMessage, findMessageRoots } from "@/content-script/catalog";
import { t } from "@/lib/i18n";
import {
  areAllCapsReached,
  dispatchedTotal as dispatchedTotalCount,
  isDurationAllowed,
  isKindCapReached,
  type MediaKind,
  type MediaTypeFlags,
} from "@/lib/limits";
import { gate } from "@/lib/premium";
import { clearCheckpoint, getCheckpoint, saveCheckpoint } from "@/lib/storage";
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

const NO_LIMITS: ChannelDownloadLimits = { video: 0, image: 0, document: 0, total: 0 };

/**
 * Pacing. The point is to walk a whole channel's history without hammering Telegram: one scroll step
 * per ~2s (its history pagination fires on scroll), and downloads run strictly one-at-a-time — the next
 * only starts once the MAIN-world downloader reports the current one finished (or times out).
 */
const SCROLL_STEP_DELAY_MS = 1900;
const BETWEEN_DOWNLOADS_MS = 600;
const DOWNLOAD_TIMEOUT_MS = 600_000; // 10 min — large videos on slow connections need time
const MAX_SCROLL_ROUNDS = 6000; // hard safety cap against an unbounded loop
const STAGNANT_ROUNDS_TO_FINISH = 15; // rounds at top with no new URLs before we call it done

let running = false;
let paused = false;
let stopRequested = false;
let stoppedByUser = false;
let totalFound = 0;
let totalDownloaded = 0;
/** Items handed to the injector for ZIP archiving this run. */
let totalQueuedForZip = 0;
/** Aborts the in-flight wait/fetch when the user presses Stop. */
let runAbort = new AbortController();
let seenUrls = new Set<string>();
let mediaTypes: MediaTypeFlags = { video: true, image: true, document: true };
let limits: ChannelDownloadLimits = { ...NO_LIMITS };
/** How many of each kind this run has dispatched — the counter the caps are checked against (a timed-out download still counts, so a cap can't be blown by retries). */
let dispatchedByKind: Record<MediaKind, number> = { video: 0, image: 0, document: 0 };
let minVideoSecs = 0;
let maxVideoSecs = 0;
let zipMode = false;
/** Split zip into parts of this many files. 0 = one zip for everything. */
let zipBatchSize = 0;
/** Auto-save checkpoint every N dispatched files. 0 = disabled. */
let checkpointEvery = 0;
let channelKey = "";
let zipPartIndex = 0;
/** Zip mode doesn't stream files one by one — it collects the whole list and hands it to the MAIN-world
 *  downloader at the end (or on each batch flush), which fetches + archives them in the page context. See `dispatchDownload`. */
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

/** Chat id from the URL hash (`#-100123_456` → `-100123`), stable across message selection. */
function getChannelKey(): string {
  return (window.location.hash.replace(/^#/, "").split("_")[0] ?? "").trim();
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
  return dispatchedTotalCount(dispatchedByKind);
}

/** This kind can't take any more (its own cap, or the total cap, is full). */
function kindCapReached(kind: MediaKind): boolean {
  return isKindCapReached(limits, dispatchedByKind, kind);
}

/** Nothing left this run can do — the total cap is full, or every *selected* kind has hit its own cap. */
function allCapsReached(): boolean {
  return areAllCapsReached(limits, dispatchedByKind, mediaTypes);
}

/** Returns false for videos outside the configured duration range; unknown duration is included. */
function isWithinDurationFilter(item: DownloadableItem): boolean {
  if (kindOf(item) !== "video") return true;
  return isDurationAllowed(item.durationSecs, minVideoSecs, maxVideoSecs);
}

/** Why (if at all) the scroll-and-download loop should stop this round. */
function loopFinishReason(
  atTop: boolean,
  stagnantAtTop: number,
): "channel.status.limit" | "channel.status.reachedStart" | null {
  if (allCapsReached()) return "channel.status.limit";
  if (atTop && stagnantAtTop >= STAGNANT_ROUNDS_TO_FINISH) return "channel.status.reachedStart";
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
function waitForInjectorDownload(downloadId: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const eventName = `${downloadId}_video_download_progress`;
    const errorEvent = "tgdl_download_error";
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener(eventName, onProgress);
      document.removeEventListener(errorEvent, onError);
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve(ok);
    };
    const onProgress = (e: Event) => {
      if (((e as CustomEvent<{ progress: number }>).detail?.progress ?? 0) >= 100) finish(true);
    };
    const onError = (e: Event) => {
      if ((e as CustomEvent<{ downloadId?: string }>).detail?.downloadId === downloadId) finish(false);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), DOWNLOAD_TIMEOUT_MS);
    document.addEventListener(eventName, onProgress);
    document.addEventListener(errorEvent, onError);
    if (signal.aborted) finish(false);
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function flushZipBatch(folderName: string): void {
  if (zipBatch.length === 0) return;
  zipPartIndex++;
  const suffix = zipBatchSize > 0 ? `_part${zipPartIndex}` : "";
  dispatchToInjector({
    type: "batch",
    items: zipBatch,
    zip: true,
    zipName: `${folderName.replaceAll("/", "_")}${suffix}.zip`,
  });
  sendStatus(t("channel.status.zip", { part: zipPartIndex }));
  zipBatch = [];
}

let _zipFolderName = "";

function maybeSaveCheckpoint(): void {
  if (!checkpointEvery || !channelKey) return;
  const dispatched = dispatchedTotal();
  if (dispatched > 0 && dispatched % checkpointEvery === 0) {
    void saveCheckpoint({ channelKey, seenUrls: [...seenUrls], totalFound, totalDownloaded, savedAt: Date.now() });
  }
}

async function dispatchDownload(item: DownloadableItem): Promise<void> {
  if (zipMode) {
    zipBatch.push(item);
    totalQueuedForZip++;
    sendStatus(t("channel.status.queued", { kind: item.kind ?? "media" }));
    if (zipBatchSize > 0 && zipBatch.length >= zipBatchSize) flushZipBatch(_zipFolderName);
    maybeSaveCheckpoint();
    return;
  }
  dispatchToInjector({ type: "single", item });
  sendStatus(
    t("channel.status.downloading", {
      n: totalDownloaded + 1,
      total: totalFound,
      kind: item.kind ?? "media",
    }),
  );
  const ok = await waitForInjectorDownload(item.downloadId, runAbort.signal);
  if (ok) totalDownloaded++;
  else if (stopRequested) {
    sendStatus(t("channel.status.stopping"));
    return;
  } else sendStatus(t("channel.status.timeout"));
  maybeSaveCheckpoint();
}

/** Download (or, in zip mode, queue) every not-yet-seen media item currently on screen, one at a time,
 *  honouring the per-type and total caps. */
async function processVisibleBatch(): Promise<void> {
  for (const item of collectNewMedia()) {
    if (stopRequested || paused) return;
    const kind = kindOf(item);

    seenUrls.add(item.videoUrl); // mark now — a paused batch resumes cleanly (see collectNewMedia)
    if (kindCapReached(kind)) continue;
    if (!isWithinDurationFilter(item)) continue; // outside min/max video length — skip silently

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
    sendStatus(t("channel.status.already"));
    return;
  }

  running = true;
  paused = false;
  stopRequested = false;
  stoppedByUser = false;
  runAbort = new AbortController();
  seenUrls = new Set();
  totalFound = 0;
  totalDownloaded = 0;
  totalQueuedForZip = 0;
  mediaTypes = {
    video: options.video !== false,
    image: options.image !== false,
    document: options.document !== false,
  };
  limits = normalizeLimits(options.limits);
  dispatchedByKind = { video: 0, image: 0, document: 0 };
  minVideoSecs = options.minVideoSecs ?? 0;
  maxVideoSecs = options.maxVideoSecs ?? 0;
  zipMode = options.zip === true;
  zipBatchSize = options.zipBatchSize ?? 0;
  zipPartIndex = 0;
  zipBatch = [];
  checkpointEvery = options.checkpointEvery ?? 0;
  channelKey = getChannelKey();

  if (options.resume && channelKey) {
    const cp = await getCheckpoint(channelKey);
    if (cp) {
      seenUrls = new Set(cp.seenUrls);
      totalFound = cp.totalFound;
      totalDownloaded = cp.totalDownloaded;
      sendStatus(t("channel.status.checkpoint", { n: totalDownloaded }));
    }
  }
  const saveFolder = options.folder ?? "";

  const channelTitle = safeName(getChannelTitle() || "tg_channel");
  const folderName = (saveFolder ? `${safeName(saveFolder)}/` : "") + channelTitle;
  _zipFolderName = folderName;

  sendStatus(t("channel.status.starting"), { folder: folderName });

  getScrollContainer().scrollTop = Number.MAX_SAFE_INTEGER; // start at the newest message
  await sleep(1500);

  // Walk history upward: collect what's on screen, download it (one at a time), step up ~one screenful,
  // let Telegram page in older messages, repeat. Stops on a cap, on reaching the channel start, or on Stop.
  // Re-acquire the scroller each round: Telegram's React can unmount and remount the scroll container,
  // leaving a stale ref with scrollTop === 0 forever, which triggers a false "Reached start" early exit.
  let stagnantAtTop = 0;
  let finishMessage: "channel.status.limit" | "channel.status.reachedStart" | null = null;

  for (let round = 0; round < MAX_SCROLL_ROUNDS && !stopRequested; round++) {
    if (paused) {
      await sleep(300);
      continue;
    }

    const scroller = getScrollContainer();
    const seenBefore = seenUrls.size; // use seenUrls, not totalFound — duration-filtered items add to seenUrls but don't increment totalFound, causing false stagnation
    await processVisibleBatch();
    if (paused) continue;

    const atTop = scroller.scrollTop <= 4;
    stagnantAtTop = atTop && seenUrls.size === seenBefore ? stagnantAtTop + 1 : 0;

    const finishReason = loopFinishReason(atTop, stagnantAtTop);
    if (finishReason) {
      finishMessage = finishReason;
      break;
    }

    scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * 0.85);
    await sleep(SCROLL_STEP_DELAY_MS);
  }

  finalizeZipIfNeeded(folderName);

  const wasStopped = stoppedByUser || stopRequested;
  running = false;
  paused = false;
  stopRequested = false;
  lastPeekCount = -1; // let the scroll watcher push a fresh count again now that the run is over

  if (wasStopped) {
    // Keep the checkpoint so Resume can continue where this run stopped.
    sendStatus(t("channel.status.stopped"), { done: true });
  } else {
    if (channelKey) void clearCheckpoint(channelKey);
    if (zipMode) {
      sendStatus(t("channel.status.doneZip", { n: totalQueuedForZip, parts: zipPartIndex }), { done: true });
    } else {
      const suffix = finishMessage ? ` · ${t(finishMessage)}` : "";
      sendStatus(`${t("channel.status.doneDownloads", { n: totalDownloaded })}${suffix}`, { done: true });
    }
  }
}

function finalizeZipIfNeeded(folderName: string): void {
  if (!zipMode || zipBatch.length === 0) return;
  // If batching was on, flush remaining items as the last part; otherwise flush as the single zip.
  flushZipBatch(folderName);
}

/**
 * Registers the channel feature's page listeners. Called once by the single isolated content-script
 * entry so catalog/heavy modules are bundled once, and `save_file` has exactly one owner.
 */
export function registerChannelDownloader(): void {
  document.addEventListener("tgdl_zip_status", (e) => {
    sendStatus((e as CustomEvent<{ message: string }>).detail.message);
  });

  // Route all saves through background so chrome.downloads.download({saveAs:false}) bypasses
  // the browser's "Ask where to save each file" setting. Covers both channel and popup downloads.
  document.addEventListener("tgdl_save_file", (e) => {
    const { url, filename } = (e as CustomEvent<{ url: string; filename: string }>).detail;
    // Tell the MAIN-world downloader we exist, so it doesn't also fire the <a download> fallback.
    document.dispatchEvent(new CustomEvent("tgdl_save_file_ack", { detail: { url } }));
    void browser.runtime.sendMessage({ type: "save_file", url, filename });
  });

  browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (response: unknown) => void): true => {
    const message = raw as ExtensionMessage;

    switch (message.type) {
      case "channel_dl_start":
        void gate("channel").then((ok) => {
          if (ok) void runChannelDownload(message.options);
          else sendStatus(t("channel.status.premium"), { done: true });
          sendResponse({ ok });
        });
        return true;
      case "channel_dl_stop":
        stoppedByUser = true;
        stopRequested = true;
        runAbort.abort();
        document.dispatchEvent(new CustomEvent("tgdl_cancel_all"));
        if (running) sendStatus(t("channel.status.stopping"));
        else sendStatus(t("channel.status.stoppedByUser"), { done: true });
        sendResponse({ ok: true });
        break;
      case "channel_dl_pause":
        paused = true;
        sendStatus(t("channel.status.paused"));
        sendResponse({ ok: true });
        break;
      case "channel_dl_resume":
        paused = false;
        sendStatus(t("channel.status.resuming"));
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
          channelKey: getChannelKey(),
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
        sendResponse({ ok: true });
        break;
      default:
        // Not a channel message: don't keep the port open. `false` is the runtime contract, but the
        // polyfill's callback type only models `true`, hence the cast.
        return false as unknown as true;
    }
    return true;
  });
}

/* ─── floating in-page control panel ────────────────────────────────────── */

function injectFloatingPanel(): void {
  if (document.getElementById("tgdl-channel-panel")) return;

  const panel = document.createElement("div");
  panel.id = "tgdl-channel-panel";
  panel.innerHTML = `
    <div id="tgdl-panel-header">
      <span>${t("channel.panel.title")}</span>
      <button id="tgdl-panel-close" title="Close">✕</button>
    </div>
    <div id="tgdl-panel-body">
      <div class="tgdl-row">
        <label>${t("channel.panel.saveFolder")}</label>
        <input id="tgdl-folder" type="text" placeholder="${t("channel.saveFolderPlaceholder")}" />
      </div>
      <div class="tgdl-row tgdl-types">
        <label><input type="checkbox" id="tgdl-chk-video" checked /> ${t("channel.videos")}</label>
        <label><input type="checkbox" id="tgdl-chk-image" checked /> ${t("channel.images")}</label>
        <label><input type="checkbox" id="tgdl-chk-doc" /> ${t("channel.documents")}</label>
      </div>
      <div class="tgdl-row tgdl-btns">
        <button id="tgdl-start-btn">${t("channel.panel.start")}</button>
        <button id="tgdl-pause-btn" disabled>${t("channel.panel.pause")}</button>
        <button id="tgdl-stop-btn" disabled>${t("channel.panel.stop")}</button>
      </div>
      <div id="tgdl-progress">
        <span id="tgdl-status-text">${t("channel.panel.ready")}</span>
        <div id="tgdl-counts">
          ${t("channel.panel.found")} <b id="tgdl-found">0</b> &nbsp;|&nbsp; ${t("channel.panel.downloaded")} <b id="tgdl-dled">0</b>
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
      panel.querySelector("#tgdl-status-text")!.textContent = t("channel.selectMediaType");
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
      btn.textContent = t("channel.panel.pause");
    } else {
      paused = true;
      btn.textContent = t("channel.resume");
    }
  });

  panel.querySelector("#tgdl-stop-btn")!.addEventListener("click", () => {
    stopRequested = true;
    paused = false;
    panel.querySelector<HTMLButtonElement>("#tgdl-pause-btn")!.disabled = true;
    panel.querySelector<HTMLButtonElement>("#tgdl-stop-btn")!.disabled = true;
    panel.querySelector<HTMLButtonElement>("#tgdl-start-btn")!.disabled = false;
    panel.querySelector("#tgdl-status-text")!.textContent = t("channel.panel.stopping");
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
      pauseBtn.textContent = t("channel.panel.pause");
    }
    if (stopBtn) stopBtn.disabled = true;
  }
}
