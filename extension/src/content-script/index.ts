import browser from "webextension-polyfill";
import { registerChannelDownloader } from "@/channel-downloader";
import { initI18n, setLocale } from "@/lib/i18n";
import { gate } from "@/lib/premium";
import { type DownloadSettings, getSettings } from "@/lib/storage";
import type { DownloadableItem, ExtensionMessage, VideoDownloadEventDetail } from "@/types/messages";
import {
  clearCatalogSuppression,
  detectTelegramVersion,
  injectMessageDownloadButtons,
  injectSharedMediaPanelButtons,
  isContextInvalidated,
  suppressCatalogIds,
} from "./catalog";

const version = detectTelegramVersion();

// Start with the browser language; `scan()` applies the saved preference once settings are read.
initI18n("system");
// One isolated-world entry owns both features: catalog/button scanning and the channel runner.
registerChannelDownloader();

/**
 * Scans are triggered by DOM mutations/scrolls (see the observer below), not a fixed tick, so re-reading
 * settings on every scan would still be a needless round-trip. Read once, then drop the cache whenever
 * `settings` actually changes so a Settings-tab toggle takes effect on the next scan.
 */
let cachedSettings: DownloadSettings | undefined;
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) cachedSettings = undefined;
});

/** Every inline-button, shared-media and popup download funnels through here, so this is the one Premium gate. */
function dispatchDownload(detail: VideoDownloadEventDetail): void {
  const batch = detail.type === "batch" && (detail.items.length > 1 || !!detail.zip);
  void gate(batch ? "batch" : "single")
    .then((ok) => {
      if (ok) document.dispatchEvent(new CustomEvent<VideoDownloadEventDetail>("video_download", { detail }));
    })
    .catch(() => undefined);
}

/** content-script-inject.ts (page/main world, no chrome.* access) reports progress via a plain DOM CustomEvent per download id — relay it to the popup. */
function trackPopupProgress(downloadId: string): void {
  const eventName = `${downloadId}_video_download_progress`;
  const cleanup = () => {
    document.removeEventListener(eventName, handler);
    document.removeEventListener("tgdl_download_error", onError);
  };
  const handler = (event: Event) => {
    const { progress } = (event as CustomEvent<{ progress: number }>).detail;
    void browser.runtime.sendMessage({ type: "downloadProgress", downloadId, progress }).catch(() => undefined);
    if (progress >= 100) cleanup();
  };
  const onError = (event: Event) => {
    if ((event as CustomEvent<{ downloadId?: string }>).detail?.downloadId === downloadId) cleanup();
  };
  document.addEventListener(eventName, handler);
  document.addEventListener("tgdl_download_error", onError);
}

/** content-script-inject reports failures in the MAIN world; relay them to the popup so a failed row is visible. */
document.addEventListener("tgdl_download_error", (event) => {
  const detail = (event as CustomEvent<{ downloadId?: string; message?: string }>).detail;
  if (!detail?.downloadId) return;
  void browser.runtime
    .sendMessage({ type: "downloadError", downloadId: detail.downloadId, message: detail.message ?? "Download failed" })
    .catch(() => undefined);
});

/**
 * The old implementation ran a full DOM scan every 3 seconds for the life of the tab. Observing actual
 * media/message mutations, debouncing bursts, rescanning after scrolling settles, and pausing while the
 * tab is hidden keeps buttons responsive without the constant CPU cost. A slow reconciliation timer
 * catches changes that don't add nodes; it is not the primary trigger.
 */
let scanTimer: ReturnType<typeof setTimeout> | undefined;
let scanObserver: MutationObserver | undefined;
let fallbackInterval: ReturnType<typeof setInterval> | undefined;
let scanInFlight = false;
let scanningStopped = false;

const MEDIA_NODE_SELECTOR =
  "video, img, .Message, .bubble, [data-mid], [data-message-id], .MessageList, .bubbles, .message-content-wrapper";

function stopScanning(): void {
  scanningStopped = true;
  if (scanTimer !== undefined) clearTimeout(scanTimer);
  scanTimer = undefined;
  scanObserver?.disconnect();
  scanObserver = undefined;
  if (fallbackInterval !== undefined) clearInterval(fallbackInterval);
  fallbackInterval = undefined;
}

function scheduleScan(delay = 300): void {
  if (scanningStopped || document.hidden) return;
  if (scanTimer !== undefined) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanTimer = undefined;
    void scan();
  }, delay);
}

function mutationTouchesMedia(record: MutationRecord): boolean {
  if (record.type === "attributes") {
    return record.target instanceof Element && record.target.matches("video, img");
  }
  for (const node of [...record.addedNodes, ...record.removedNodes]) {
    if (!(node instanceof Element)) continue;
    if (node.matches(MEDIA_NODE_SELECTOR) || node.querySelector(MEDIA_NODE_SELECTOR)) return true;
  }
  return false;
}

/**
 * Telegram ships DOM changes with no notice, and a stale selector fails *silently* — no error, just
 * zero buttons (exactly how the a-client `no-avatars` regression went unnoticed). Count consecutive
 * scans that found message roots but extracted no media at all, and after a few of those, log one
 * warning so the breakage is visible and reportable instead of invisible.
 */
let barrenScans = 0;
let domChangeWarned = false;
const BARREN_SCANS_BEFORE_WARNING = 4;

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
    console.error("[tgdl] could not read settings — stopping the scan loop:", err);
    return null;
  }
}

async function scan(): Promise<void> {
  if (scanInFlight || scanningStopped) return;
  scanInFlight = true;

  try {
    if (isContextInvalidated()) {
      stopScanning();
      return;
    }

    const settings = await resolveSettings();
    if (!settings) {
      stopScanning();
      return;
    }
    setLocale(settings.language);

    // Cataloguing and button injection are deliberately independent: users who turn inline buttons off
    // still expect the popup's media list (and Force Download) to work.
    const { roots, mediaFound } = injectMessageDownloadButtons(
      version,
      (item) => dispatchDownload({ type: "single", item }),
      (items) => dispatchDownload({ type: "batch", items }),
      settings.downloadWebm,
      settings.buttonsOnPreviews,
      settings.showInlineButtons,
    );

    noteScanResult(roots, mediaFound);

    if (version === "a" && settings.showInlineButtons) {
      void injectSharedMediaPanelButtons(
        (items) => dispatchDownload({ type: "batch", items }),
        (item) => dispatchDownload({ type: "single", item }),
        settings.downloadWebm,
      );
    }
  } finally {
    scanInFlight = false;
  }
}

// Don't gate this behind window "load" — Telegram is a heavy SPA and its own
// `load` event can fire well before (or well after) the chat/message DOM this
// scan depends on actually exists, making button injection unreliable.
scanObserver = new MutationObserver((records) => {
  if (records.some(mutationTouchesMedia)) scheduleScan();
});
scanObserver.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src"],
});

// Lazy media mounts as the user scrolls; wait for the scroll to settle, then scan once.
document.addEventListener("scroll", () => scheduleScan(500), { passive: true, capture: true });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleScan(0);
});
// Slow safety net for changes that don't add/remove nodes.
fallbackInterval = setInterval(() => scheduleScan(0), 20_000);

void scan();

// Switching chats is a fresh catalog; a previous "Clear All" should not hide the new chat's media.
window.addEventListener("hashchange", () => {
  clearCatalogSuppression();
  scheduleScan(0);
});

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
    case "catalog_suppress":
      suppressCatalogIds(message.ids);
      return;
    case "cancelDownloads":
      document.dispatchEvent(new CustomEvent("tgdl_cancel_all"));
      return;
    case "forceDownloadPopup":
      clearCatalogSuppression();
      void scan();
      return;
    default:
      return;
  }
});
