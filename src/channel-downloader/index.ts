/**
 * Auto-downloads all media from the current Telegram channel/chat.
 * Supports both web.telegram.org/a and web.telegram.org/k.
 */
import browser from "webextension-polyfill";
import { buildZip, toBlob, uniqueZipEntryName } from "@/lib/zip";
import type {
  ChannelDlCheckPageResponse,
  ChannelDlPeekResponse,
  ChannelDlStatusResponse,
  ChannelDownloadOptions,
  ExtensionMessage,
} from "@/types/messages";

type MediaItem = { src: string; type: "video" | "image" | "document"; mid: string; ext: string };
type MediaTypeFlags = { video: boolean; image: boolean; document: boolean };

let running = false;
let paused = false;
let stopRequested = false;
let totalFound = 0;
let totalDownloaded = 0;
let seenUrls = new Set<string>();
let mediaTypes: MediaTypeFlags = { video: true, image: true, document: true };
let zipMode = false;
let zipFiles: Record<string, Uint8Array> = {};
let zipUsedNames = new Set<string>();

function detectVersion(): "a" | "k" {
  return window.location.href.includes("web.telegram.org/k") ? "k" : "a";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeName(str: string): string {
  return (str || "tg_channel")
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .substring(0, 60);
}

function getScrollContainer(): Element {
  const selectors = [
    ".messages-layout .scrollable",
    ".chat .bubbles",
    "#column-center .scrollable-y",
    ".bubbles.can-scroll",
    ".messages-container",
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return document.documentElement;
}

async function scrollToTop(): Promise<void> {
  const el = getScrollContainer();
  el.scrollTop = 0;
  await sleep(1500);
  for (let i = 0; i < 30; i++) {
    if (el.scrollTop < 100) break;
    el.scrollTop = 0;
    await sleep(500);
  }
}

function scrollDown(container: Element, amount = 800): void {
  container.scrollBy({ top: amount, behavior: "smooth" });
}

function isAtBottom(container: Element): boolean {
  return container.scrollTop + container.clientHeight >= container.scrollHeight - 80;
}

function getChannelTitle(): string {
  return (
    document.querySelector(".chat-info .peer-title, .chat-title, .MiddleHeader .title, .TopBar .user-title, .peer-title")
      ?.textContent?.trim() ?? ""
  );
}

function getMessageElements(version: "a" | "k"): NodeListOf<Element> {
  return version === "a"
    ? document.querySelectorAll(".Message, .message-list-item, .message")
    : document.querySelectorAll(".bubbles-group > .bubbles-group-item, .bubbles-group-item, .bubble");
}

/** Shared selector/extraction logic behind both the real collection pass and the non-destructive peek/re-scan. */
function extractItemsFromMessage(msg: Element, version: "a" | "k", types: MediaTypeFlags): MediaItem[] {
  const items: MediaItem[] = [];
  const mid = msg.getAttribute("data-message-id") ?? msg.getAttribute("data-mid") ?? msg.id;
  if (!mid) return items;

  if (types.video) {
    msg.querySelectorAll("video.full-media, video.media-video").forEach((v) => {
      const src = v.getAttribute("src");
      if (src) items.push({ src, type: "video", mid, ext: "mp4" });
    });
    if (version === "a") {
      const docContainer = msg.querySelector(".document");
      const docSrc = docContainer?.getAttribute("data-src") ?? "";
      if (docSrc) items.push({ src: docSrc, type: "video", mid, ext: "mp4" });
    }
  }

  if (types.image) {
    msg.querySelectorAll("img.full-media, img.media-photo").forEach((img) => {
      const src = img.getAttribute("src");
      if (src && !src.startsWith("blob:")) items.push({ src, type: "image", mid, ext: "jpg" });
    });
  }

  if (types.document && version === "a") {
    msg.querySelectorAll("a.document-download, .download-button").forEach((a) => {
      const href = a.getAttribute("href") ?? a.getAttribute("data-href") ?? "";
      if (href) {
        const ext = href.split(".").pop()?.split("?")[0] || "bin";
        items.push({ src: href, type: "document", mid, ext });
      }
    });
  }

  return items;
}

function collectVisibleMedia(version: "a" | "k"): MediaItem[] {
  const items: MediaItem[] = [];
  getMessageElements(version).forEach((msg) => {
    for (const item of extractItemsFromMessage(msg, version, mediaTypes)) {
      if (seenUrls.has(item.src)) continue;
      seenUrls.add(item.src);
      totalFound++;
      items.push(item);
    }
  });
  return items;
}

/** Read-only count of what's currently visible — used for the popup's "Found" preview before Start is ever clicked, and for manual re-scan. */
function countVisibleMedia(version: "a" | "k", types: MediaTypeFlags): number {
  const seen = new Set<string>();
  let count = 0;
  getMessageElements(version).forEach((msg) => {
    for (const item of extractItemsFromMessage(msg, version, types)) {
      if (seen.has(item.src)) continue;
      seen.add(item.src);
      count++;
    }
  });
  return count;
}

async function dispatchDownload(item: MediaItem, folderName: string): Promise<void> {
  const filename = `${folderName}/${item.type}_${item.mid}_${Date.now()}.${item.ext}`;

  if (zipMode) {
    try {
      const res = await fetch(item.src);
      const data = new Uint8Array(await res.arrayBuffer());
      zipFiles[uniqueZipEntryName(filename, zipUsedNames)] = data;
      totalDownloaded++;
      sendStatus(`Zipping: ${item.type} #${item.mid}`);
    } catch {
      sendStatus(`⚠ Failed to fetch ${item.type} #${item.mid}`);
    }
    return;
  }

  void browser.runtime.sendMessage({ type: "channel_dl_item", src: item.src, filename, mid: item.mid });
  totalDownloaded++;
  sendStatus(`Downloading: ${item.type} #${item.mid}`);
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
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
  zipMode = options.zip === true;
  zipFiles = {};
  zipUsedNames = new Set();
  const version = detectVersion();
  const saveFolder = options.folder ?? "";

  const channelTitle = safeName(getChannelTitle() || "tg_channel");
  const folderName = (saveFolder ? `${safeName(saveFolder)}/` : "") + channelTitle;

  sendStatus("Starting channel download…", { folder: folderName });

  await scrollToTop();
  await sleep(2000);

  const container = getScrollContainer();
  let noNewRounds = 0;
  const MAX_NO_NEW = 8;

  while (!stopRequested) {
    if (paused) {
      await sleep(300);
      continue;
    }

    const prevFound = totalFound;
    const items = collectVisibleMedia(version);

    for (const item of items) {
      if (stopRequested || paused) break;
      await dispatchDownload(item, folderName);
      await sleep(300);
    }
    if (paused) continue;

    noNewRounds = totalFound === prevFound ? noNewRounds + 1 : 0;

    if (isAtBottom(container)) {
      sendStatus("Reached end of channel", { done: true });
      break;
    }
    if (noNewRounds >= MAX_NO_NEW) {
      sendStatus("No new media found, finishing", { done: true });
      break;
    }

    scrollDown(container);
    await sleep(1200);
  }

  await finalizeZipIfNeeded(folderName);

  running = false;
  paused = false;
  stopRequested = false;
  sendStatus(`Done! ${totalDownloaded} file(s) downloaded`, { done: true });
}

async function finalizeZipIfNeeded(folderName: string): Promise<void> {
  if (!zipMode || Object.keys(zipFiles).length === 0) return;

  sendStatus(`Zipping ${totalDownloaded} file(s)…`);
  try {
    const zipped = await buildZip(zipFiles);
    triggerBlobDownload(toBlob(zipped), `${folderName.replaceAll("/", "_")}.zip`);
  } catch {
    sendStatus("⚠ Failed to build zip archive");
  }
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
        version: detectVersion(),
        channelTitle: getChannelTitle(),
      };
      sendResponse(response);
      break;
    }
    case "channel_dl_peek": {
      const response: ChannelDlPeekResponse = { found: countVisibleMedia(detectVersion(), message.mediaTypes) };
      sendResponse(response);
      break;
    }
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
