import browser from "webextension-polyfill";
import {
  detectTelegramVersion,
  injectMessageDownloadButtons,
  injectSharedMediaPanelButtons,
  isContextInvalidated,
} from "./catalog";
import { getSettings } from "@/lib/storage";
import type { DownloadableItem, ExtensionMessage, VideoDownloadEventDetail } from "@/types/messages";

const version = detectTelegramVersion();

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

async function scan(): Promise<void> {
  if (isContextInvalidated()) {
    if (scanIntervalId !== undefined) clearInterval(scanIntervalId);
    return;
  }

  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    if (err instanceof Error && err.message.includes("Extension context invalidated")) {
      if (scanIntervalId !== undefined) clearInterval(scanIntervalId);
      console.warn("[tgdl] extension was reloaded/updated — refresh this page to restore the inline download buttons.");
      return;
    }
    throw err;
  }

  if (!settings.showInlineButtons) return;

  injectMessageDownloadButtons(
    version,
    (item) => dispatchDownload({ type: "single", item }),
    (items) => dispatchDownload({ type: "batch", items }),
    settings.downloadWebm,
  );
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
        item: { videoUrl: message.videoUrl, videoId: message.videoId, page: message.page, downloadId: message.downloadId },
      });
      return;
    case "batchDownloadPopup":
      message.items.forEach((i) => trackPopupProgress(i.downloadId));
      dispatchDownload({
        type: "batch",
        items: message.items.map(
          (i): DownloadableItem => ({ videoUrl: i.videoUrl, videoId: i.videoId, page: i.page, downloadId: i.downloadId }),
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
