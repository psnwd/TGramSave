import browser from "webextension-polyfill";
import { hashTabUrl, hashValue } from "@/lib/md5";
import { waitForSelector } from "@/lib/dom-wait";
import type { DownloadableItem } from "@/types/messages";

export type TelegramVersion = "a" | "k";

interface VersionConfig {
  /** Every chat-message bubble that may contain downloadable media — verified straight from the original extension's bootstrap (content-script.js:78662-78665), not guessed. */
  messageWrapperClass: string;
  /** The media viewer (opened by clicking into a message's media) — used to page through a lazily-loaded album. */
  mediaViewer: {
    containerSelector: string;
    nextButtonSelector: string;
  };
}

const VERSION_CONFIG: Record<TelegramVersion, VersionConfig> = {
  a: {
    messageWrapperClass: "message-content-wrapper",
    mediaViewer: {
      containerSelector: ".MediaViewerSlide--active",
      nextButtonSelector: ".MediaViewerActions .Button.smaller.round",
    },
  },
  k: {
    messageWrapperClass: "bubble-content-wrapper",
    mediaViewer: {
      containerSelector: ".media-viewer-movers",
      nextButtonSelector: ".media-viewer-buttons .btn-icon",
    },
  },
};

export function detectTelegramVersion(): TelegramVersion {
  return window.location.href.includes("web.telegram.org/a") ? "a" : "k";
}

const REST_SHADOW = "0 2px 4px rgba(0,0,0,.35), 0 0 0 2px rgba(159,232,112,.55)";
const HOVER_SHADOW = "0 4px 10px rgba(0,0,0,.4), 0 0 0 2px rgba(159,232,112,.9)";

/**
 * Every visual property here is set via inline `style.xxx`, not a class +
 * stylesheet. That's deliberate: inline styles always win over the host
 * page's own CSS regardless of specificity/cascade order, which an injected
 * `<style>` block does not reliably guarantee against Telegram's own rules
 * — a class-based version of this button was invisible in practice.
 */
function styleDownloadButton(button: HTMLButtonElement): void {
  button.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "gap:6px",
    "background:#9fe870",
    "color:#0e0f0c",
    "border:2px solid #0e0f0c",
    "border-radius:9999px",
    "padding:9px 18px",
    "margin:6px 0",
    "font-size:13px",
    "font-weight:800",
    "letter-spacing:.3px",
    "text-transform:uppercase",
    "font-family:inherit",
    "line-height:1.3",
    "cursor:pointer",
    `box-shadow:${REST_SHADOW}`,
    "transition:transform .12s ease, box-shadow .12s ease, background-color .12s ease",
  ].join(";");
  attachHoverEffect(button);
}

/** Inline-style hover state — the same reasoning as styleDownloadButton: CSS `:hover` rules in an injected stylesheet aren't guaranteed to win, so drive it from JS instead. */
function attachHoverEffect(button: HTMLButtonElement): void {
  button.addEventListener("mouseenter", () => {
    button.style.transform = "scale(1.05)";
    button.style.boxShadow = HOVER_SHADOW;
    button.style.backgroundColor = "#b9f797";
  });
  button.addEventListener("mouseleave", () => {
    button.style.transform = "scale(1)";
    button.style.boxShadow = REST_SHADOW;
    button.style.backgroundColor = "#9fe870";
  });
}

/**
 * Reloading/updating the extension while this tab is still open kills the old content script's
 * `chrome.*` handle — every `browser.storage`/`browser.runtime` call then throws "Extension context
 * invalidated", forever, since `scan()` reruns every 3s. Downloading itself is unaffected (it runs
 * page-side in content-script-inject, no extension APIs involved), but once we've seen this error once
 * there's nothing left to do until the page is refreshed — stop trying instead of spamming the console.
 */
let contextInvalidated = false;
export function isContextInvalidated(): boolean {
  return contextInvalidated;
}

/** Persists a discovered item into this chat's cataloged video list (read by the popup's Batch Download tab) and refreshes the toolbar badge. */
async function catalogItem(item: DownloadableItem): Promise<void> {
  if (contextInvalidated) return;
  try {
    const storageKey = `${hashTabUrl(window.location.href)}_video_list`;
    const stored = await browser.storage.local.get(storageKey);
    const list = (stored[storageKey] as Record<string, DownloadableItem> | undefined) ?? {};
    list[item.videoId] = item;
    await browser.storage.local.set({ [storageKey]: list });
    await browser.runtime.sendMessage({ type: "videoCount", storageKey }).catch(() => undefined);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Extension context invalidated")) {
      contextInvalidated = true;
      console.warn("[tgdl] extension was reloaded/updated — refresh this page to restore the media list/badge. Inline download buttons still work.");
    } else {
      console.error("[tgdl] failed to catalog item:", err);
    }
  }
}

/**
 * `mid` (message id) is stable across re-renders; `src` (often `blob:...`) is not — Telegram can hand a
 * message's `<video>`/`<img>` a freshly-generated blob URL on remount (scroll, re-render, etc.) without
 * the message itself changing. Hashing `src` into the id therefore minted a *new* id every time that
 * happened, silently piling up duplicate entries in storage for what was really the same item. Keying on
 * `mid` + the item's position within the message is stable across those churns; a hash of `src` is only
 * the fallback for the rare case there's no `mid` to anchor to at all (e.g. a standalone media-viewer read).
 */
function idFor(src: string, mid: string | undefined, index: number): string {
  return mid ? `${mid}_${index}` : hashValue(src).slice(0, 12);
}

const THUMB_SIZE = 64;

/**
 * Captures pixels straight off the already-rendered <video>/<img> element via
 * canvas, while still in the Telegram page's own context — its `src` is
 * often a `blob:` URL that's only valid *here*, not from the popup's
 * `chrome-extension://` origin, which is why loading `videoUrl` directly in
 * the popup mostly failed. A `data:` URL has no such restriction.
 */
function captureThumbnail(el: HTMLVideoElement | HTMLImageElement): string | undefined {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(el, 0, 0, THUMB_SIZE, THUMB_SIZE);
    return canvas.toDataURL("image/jpeg", 0.6);
  } catch {
    // Cross-origin source without CORS headers taints the canvas — toDataURL
    // throws. Nothing to do but skip the thumbnail for this item.
    return undefined;
  }
}

/** Telegram shows inline `data:image/svg+xml...` placeholder icons (loading spinners, reaction hearts,
 *  broken-image glyphs) before real media mounts — these aren't downloadable (fetching a `data:` URI
 *  from the page's own MAIN-world script is blocked by Telegram's CSP) and aren't real content anyway. */
function isRealMediaSrc(src: string | null | undefined): src is string {
  return Boolean(src) && !src!.startsWith("data:");
}

/** Sender/chat/channel avatars (`<img class="Avatar__media avatar-media ...">` next to message bubbles,
 *  in the header, etc.) aren't message content — never treat them as a downloadable item. */
function isAvatarElement(el: Element): boolean {
  return Boolean(el.closest('[class*="avatar" i]'));
}

/**
 * GIFs and video stickers are served by Telegram as silent looping WebM video, not "real" video content.
 * (`video.loop` looked like a reliable signal for this — real video messages are never `loop` — but
 * Telegram Web turned out to also loop ordinary video previews before playback, so that check misfired
 * and hid real videos entirely. Back to the weaker but safe signals: `webm` in the URL/type, or a known
 * sticker/GIF/emoji wrapper class — false negatives here are far less bad than hiding real videos.)
 */
function isWebmOrSticker(el: HTMLVideoElement | HTMLImageElement): boolean {
  if (el.tagName === "VIDEO") {
    const video = el as HTMLVideoElement;
    const candidates = [
      video.getAttribute("src"),
      video.currentSrc,
      ...Array.from(video.querySelectorAll("source")).flatMap((s) => [s.getAttribute("src"), s.getAttribute("type")]),
    ];
    if (candidates.some((c) => c?.toLowerCase().includes("webm"))) return true;
  }
  return Boolean(el.closest('[class*="sticker" i], [class*="gif" i], [class*="emoji" i]'));
}

/** Builds a `DownloadableItem` for one specific media element (used both for a single-media message and for each element inside a grouped/album message). `index` is this element's position among its message's media elements — see `idFor`. */
function buildItemFromElement(el: HTMLVideoElement | HTMLImageElement, wrapper: Element, allowWebm: boolean, index = 0): DownloadableItem | undefined {
  const src = el.getAttribute("src");
  if (!isRealMediaSrc(src)) return undefined;
  if (isAvatarElement(el)) return undefined;
  if (!allowWebm && isWebmOrSticker(el)) return undefined;

  const thumbnailDataUrl = captureThumbnail(el);

  // Telegram often shows a video message as just a poster <img> + a duration
  // badge until the real <video> element mounts (on scroll-into-view/play) —
  // checking the tag alone misses that, so every video looked like an
  // "image" and got the image's label. Look for a duration badge near this
  // specific element (its own container), not anywhere in the whole wrapper
  // — a wrapper can hold several album items, each with its own badge.
  const itemContainer = el.closest('[class*="album-item" i], [class*="Album" i]') ?? el.parentElement ?? el;
  const hasDurationBadge = itemContainer.querySelector('[class*="video-time" i], [class*="video-duration" i]');
  const looksLikeVideo = el.tagName === "VIDEO" || Boolean(hasDurationBadge);

  // `closest()` walks up to the nearest [data-mid]/[data-message-id] ancestor
  // — for grouped/album messages that ancestor is often shared by several
  // *different* media items, which made every item in a group collide onto
  // the same id and overwrite each other in storage (only the last one
  // survived). The src itself is always unique per item, so fold a short
  // hash of it into the id regardless of whether a shared mid was found.
  const mid = wrapper.closest("[data-mid], [data-message-id]")?.getAttribute("data-mid")
    ?? wrapper.closest("[data-mid], [data-message-id]")?.getAttribute("data-message-id")
    ?? undefined;

  const id = idFor(src, mid, index);
  return {
    videoUrl: src,
    videoId: id,
    page: "content",
    downloadId: id,
    kind: looksLikeVideo ? "video" : "image",
    thumbnailDataUrl,
  };
}

function extractMediaFromMessage(wrapper: Element, allowWebm = true): DownloadableItem | undefined {
  const video = wrapper.querySelector("video");
  const img = wrapper.querySelector("img");
  const el = video ?? img;
  return el ? buildItemFromElement(el, wrapper, allowWebm) : undefined;
}

/**
 * Grouped/album messages ("clusters") render several `<video>`/`<img>` elements inside one message
 * wrapper — the old single-`querySelector` extraction only ever saw the first one, so a 4-photo album
 * only ever surfaced a button for photo #1. Finds every media element in the wrapper, deduped so a
 * video's own poster `<img>` (nested inside the same container) isn't double-counted as a second item.
 */
function extractAllMediaFromMessage(wrapper: Element, allowWebm: boolean): Array<{ el: HTMLVideoElement | HTMLImageElement; item: DownloadableItem }> {
  const videos = Array.from(wrapper.querySelectorAll("video"));
  const imgs = Array.from(wrapper.querySelectorAll("img")).filter(
    (img) => !videos.some((video) => video.parentElement?.contains(img)),
  );

  const results: Array<{ el: HTMLVideoElement | HTMLImageElement; item: DownloadableItem }> = [];
  [...videos, ...imgs].forEach((el, index) => {
    const item = buildItemFromElement(el, wrapper, allowWebm, index);
    if (item) results.push({ el, item });
  });
  return results;
}

/**
 * Tracks the item each injected button currently downloads, keyed by its anchor element (a container
 * div for the single-media case, or the overlay button itself for a cluster item). Telegram often
 * renders a message as just a poster `<img>` (no `<video>` yet) until it scrolls into view/plays, so the
 * first scan can only guess "image"; once the real `<video>` mounts on a later scan, we must upgrade the
 * button's label *and* the src it actually downloads in place, not just skip the wrapper forever.
 */
const itemByContainer = new WeakMap<HTMLElement, DownloadableItem>();

/** Cluster media elements that already have their own overlay download button — skip re-adding one every scan tick. */
const processedClusterElements = new WeakSet<Element>();

function injectSingleInlineButton(wrapper: Element, item: DownloadableItem, onDownload: (item: DownloadableItem) => void): void {
  const existingContainer = wrapper.querySelector<HTMLElement>(".tgdl-inline-download");
  if (existingContainer) {
    const previous = itemByContainer.get(existingContainer);
    if (previous && (previous.kind !== item.kind || previous.videoUrl !== item.videoUrl)) {
      itemByContainer.set(existingContainer, item);
      void catalogItem(item);
      const button = existingContainer.querySelector("button");
      if (button) button.textContent = item.kind === "image" ? "⬇ Download Image" : "⬇ Download Video";
    }
    return;
  }

  void catalogItem(item);

  const container = document.createElement("div");
  container.className = "tgdl-inline-download";
  container.style.cssText = "display:flex;width:100%;box-sizing:border-box;padding:4px 0;";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "downloadvideo";
  button.textContent = item.kind === "image" ? "⬇ Download Image" : "⬇ Download Video";
  button.title = "Download";
  styleDownloadButton(button);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onDownload(itemByContainer.get(container) ?? item);
  });

  itemByContainer.set(container, item);
  container.appendChild(button);
  wrapper.appendChild(container);
}

/** Grouped/album message: one small overlay ⬇ button per thumbnail, plus a "Download all" button for the whole group. */
function injectClusterButtons(
  wrapper: HTMLElement,
  found: Array<{ el: HTMLVideoElement | HTMLImageElement; item: DownloadableItem }>,
  onDownload: (item: DownloadableItem) => void,
  onDownloadAll: (items: DownloadableItem[]) => void,
): void {
  for (const { el, item } of found) {
    void catalogItem(item);
    if (processedClusterElements.has(el)) continue;
    processedClusterElements.add(el);

    const anchor = el.parentElement ?? el;
    if (getComputedStyle(anchor).position === "static") anchor.style.position = "relative";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "downloadvideo tgdl-item-download";
    button.textContent = "⬇";
    button.title = item.kind === "image" ? "Download Image" : "Download Video";
    styleDownloadButton(button);
    button.style.cssText += "position:absolute;bottom:4px;right:4px;padding:2px 8px;margin:0;z-index:5;";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onDownload(itemByContainer.get(button) ?? item);
    });

    itemByContainer.set(button, item);
    anchor.appendChild(button);
  }

  if (!wrapper.querySelector(".tgdl-cluster-download-all")) {
    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.className = "downloadvideo tgdl-cluster-download-all";
    allButton.textContent = `⬇ Download all (${found.length})`;
    allButton.title = "Download every item in this message";
    styleDownloadButton(allButton);
    allButton.style.cssText += "display:flex;width:100%;box-sizing:border-box;margin:6px 0;";
    allButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onDownloadAll(found.map((f) => f.item));
    });
    wrapper.appendChild(allButton);
  }
}

/**
 * Injects download controls below/over every media message that doesn't already have them. Single-media
 * messages get one full-width button below the bubble; grouped/album messages ("clusters" — multiple
 * photos/videos in one message) get a small overlay button per item plus a "Download all" button, since
 * a single button could previously only ever reach the first item in the group.
 */
export function injectMessageDownloadButtons(
  version: TelegramVersion,
  onDownload: (item: DownloadableItem) => void,
  onDownloadAll: (items: DownloadableItem[]) => void,
  allowWebm: boolean,
): void {
  const { messageWrapperClass } = VERSION_CONFIG[version];
  for (const wrapper of Array.from(document.getElementsByClassName(messageWrapperClass))) {
    const found = extractAllMediaFromMessage(wrapper, allowWebm);
    if (found.length === 0) continue;

    if (found.length === 1) {
      injectSingleInlineButton(wrapper, found[0]!.item, onDownload);
    } else {
      injectClusterButtons(wrapper as HTMLElement, found, onDownload, onDownloadAll);
    }
  }
}

/**
 * Clicks through a lazily-loaded media album (opened via the viewer) so every
 * item gets rendered into the DOM at least once and cataloged. Bounded to
 * avoid an infinite loop if the "next" button never disables/disappears.
 */
export async function catalogMediaAlbum(version: TelegramVersion, openViewerButton: HTMLElement, maxItems = 200): Promise<void> {
  const { containerSelector, nextButtonSelector } = VERSION_CONFIG[version].mediaViewer;
  openViewerButton.click();
  await new Promise((r) => setTimeout(r, 2000));

  for (let i = 0; i < maxItems; i++) {
    const container = document.querySelector(containerSelector);
    if (!container) break;

    const item = extractMediaFromMessage(container);
    if (item) await catalogItem(item);

    const nextButton = document.querySelectorAll(nextButtonSelector)[1] as HTMLElement | undefined;
    if (!nextButton) break;
    nextButton.click();
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** a-version only: injects "Download all Media/Stories" + per-item buttons into the right-hand Shared Media panel. */
export async function injectSharedMediaPanelButtons(
  onDownload: (items: DownloadableItem[]) => void,
  onDownloadOne: (item: DownloadableItem) => void,
  allowWebm: boolean,
): Promise<void> {
  const slides = await waitForSelector("#RightColumn .shared-media .Transition_slide-active");
  const slide = slides[0];
  if (!slide || (!slide.className.includes("media-list") && !slide.className.includes("stories-list"))) return;

  const items = await waitForSelector("#RightColumn .shared-media .Transition_slide-active .scroll-item");
  const panel = document.querySelector(".shared-media-transition")?.parentElement;
  if (!panel) return;

  if (!panel.querySelector(".tgdl-panel-download-all")) {
    const bulkButton = document.createElement("button");
    bulkButton.type = "button";
    bulkButton.className = "tgdl-panel-download-all downloadvideo";
    bulkButton.textContent = "⬇ Download all";
    styleDownloadButton(bulkButton);
    bulkButton.style.margin = "6px";
    bulkButton.addEventListener("click", () => {
      const found = items.map((item) => extractMediaFromMessage(item, allowWebm)).filter((x): x is DownloadableItem => Boolean(x));
      onDownload(found);
    });
    panel.appendChild(bulkButton);
  }

  for (const item of items) {
    if (item.querySelector(".tgdl-panel-download-one")) continue;
    const media = extractMediaFromMessage(item, allowWebm);
    if (!media) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "tgdl-panel-download-one downloadvideo";
    button.textContent = "⬇";
    styleDownloadButton(button);
    button.style.position = "absolute";
    button.style.bottom = "4px";
    button.style.right = "4px";
    button.style.padding = "2px 8px";
    if (getComputedStyle(item).position === "static") {
      (item as HTMLElement).style.position = "relative";
    }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onDownloadOne(media);
    });
    item.appendChild(button);
  }
}
