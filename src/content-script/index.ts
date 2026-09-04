import browser from "webextension-polyfill";
import { type DownloadSettings, getSettings } from "@/lib/storage";
import type { DownloadableItem, ExtensionMessage, VideoDownloadEventDetail } from "@/types/messages";
import {
  detectTelegramVersion,
  injectMessageDownloadButtons,
  injectSharedMediaPanelButtons,
  isContextInvalidated,
} from "./catalog";

const version = detectTelegramVersion();

/**
 * `scan()` runs every 3s for the life of the tab; re-reading settings from `chrome.storage` on every
 * tick is a needless round-trip. Read once, then drop the cache whenever `settings` actually changes
 * so a Settings-tab toggle still takes effect on the next scan.
 */
let cachedSettings: DownloadSettings | undefined;
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) cachedSettings = undefined;
});

function dispatchDownload(detail: VideoDownloadEventDetail): void {
  document.dispatchEvent(new CustomEvent<VideoDownloadEventDetail>("video_download", { detail }));
}

/** content-script-inject.ts (page/main world, no chrome.* access) reports progress via a plain DOM CustomEvent per download id — relay it to the popup. */
function trackPopupProgress(downloadId: string): void {
  const eventName = `${downloadId}_video_download_progress`;
  const handler = (event: Event) => {
    const { progress } = (event as CustomEvent<{ progress: number }>).detail;
    void browser.runtime.sendMessage({ type: "downloadProgress", downloadId, progress }).catch(() => undefined);
    if (progress >= 100) document.removeEventListener(eventName, handler);
  };
  document.addEventListener(eventName, handler);
}

function injectCustomFonts(): void {
  const fontFace = (family: string, url: string) =>
    `@font-face { font-family: ${family}; src: url(${url}) format("truetype"); font-weight: 400; font-style: normal; }`;

  const style = document.createElement("style");
  style.textContent = [
    fontFace("element-icons", browser.runtime.getURL("fonts/element-icons.woff")),
    fontFace("element-icons", browser.runtime.getURL("fonts/element-icons.ttf")),
    fontFace("SourceHanSansSC-bold", browser.runtime.getURL("fonts/Bold.woff2")),
  ].join("\n");
  document.head.appendChild(style);
}

let scanIntervalId: ReturnType<typeof setInterval> | undefined;

/**
 * Telegram ships DOM changes with no notice, and a stale selector fails *silently* — no error, just
 * zero buttons (exactly how the a-client `no-avatars` regression went unnoticed). Count consecutive
 * scans that found message roots but extracted no media at all, and after a few seconds of that,
 * log one warning so the breakage is visible and reportable instead of invisible.
 */
let barrenScans = 0;
let domChangeWarned = false;
const BARREN_SCANS_BEFORE_WARNING = 4; // 4 * 3s ≈ 12s — long enough to rule out a still-loading chat.

function noteScanResult(roots: number, mediaFound: number): void {
  if (roots <= 3 || mediaFound > 0) {
    barrenScans = 0;
    return;
  }
  barrenScans += 1;
  if (barrenScans < BARREN_SCANS_BEFORE_WARNING || domChangeWarned) return;
  domChangeWarned = true;
  console.warn(
    "[tgdl] scanned %d message elements but extracted 0 downloadable media — Telegram Web's DOM " +
      "may have changed and the extension's selectors need updating. Please file an issue.",
    roots,
  );
}

/** Cached settings, refetched once after any change. Returns null if the extension context is gone (the caller then stops the scan loop). */
async function resolveSettings(): Promise<DownloadSettings | null> {
  if (cachedSettings !== undefined) return cachedSettings;
  try {
    cachedSettings = await getSettings();
    return cachedSettings;
  } catch (err) {
    if (err instanceof Error && err.message.includes("Extension context invalidated")) {
      console.warn("[tgdl] extension was reloaded/updated — refresh this page to restore the inline download buttons.");
      return null;
    }
    throw err;
  }
}

async function scan(): Promise<void> {
  if (isContextInvalidated()) {
    if (scanIntervalId !== undefined) clearInterval(scanIntervalId);
    return;
  }

  const settings = await resolveSettings();
  if (!settings) {
    if (scanIntervalId !== undefined) clearInterval(scanIntervalId);
    return;
  }

  if (!settings.showInlineButtons) return;

  const { roots, mediaFound } = injectMessageDownloadButtons(
    version,
    (item) => dispatchDownload({ type: "single", item }),
    (items) => dispatchDownload({ type: "batch", items }),
    settings.downloadWebm,
    settings.buttonsOnPreviews,
  );

  noteScanResult(roots, mediaFound);

  if (version === "a") {
    void injectSharedMediaPanelButtons(
      (items) => dispatchDownload({ type: "batch", items }),
      (item) => dispatchDownload({ type: "single", item }),
      settings.downloadWebm,
    );
  }
}

// Don't gate this behind window "load" — Telegram is a heavy SPA and its own
// `load` event can fire well before (or well after) the chat/message DOM this
// scan depends on actually exists, making button injection unreliable.
void scan();
scanIntervalId = setInterval(() => void scan(), 3000);

window.addEventListener("load", injectCustomFonts);

browser.runtime.onMessage.addListener((raw: unknown): undefined => {
  const message = raw as ExtensionMessage;

  switch (message.type) {
    case "singleDownloadPopup":
      trackPopupProgress(message.downloadId);
      dispatchDownload({
        type: "single",
        item: {
          videoUrl: message.videoUrl,
          videoId: message.videoId,
          page: message.page,
          downloadId: message.downloadId,
        },
      });
      return;
    case "batchDownloadPopup":
      for (const i of message.items) trackPopupProgress(i.downloadId);
      dispatchDownload({
        type: "batch",
        items: message.items.map(
          (i): DownloadableItem => ({
            videoUrl: i.videoUrl,
            videoId: i.videoId,
            page: i.page,
            downloadId: i.downloadId,
          }),
        ),
        zip: message.zip,
        zipName: message.zipName,
      });
      return;
    case "forceDownloadPopup":
      void scan();
      return;
    default:
      return;
  }
});
