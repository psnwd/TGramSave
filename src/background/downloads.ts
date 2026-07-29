import browser from "webextension-polyfill";

/** Relays a single channel-download-tab item to the real chrome.downloads API. */
export async function downloadChannelItem(item: { src: string; filename: string; mid: string }): Promise<{ ok: boolean }> {
  if (!item.src || !item.filename) return { ok: false };
  try {
    await browser.downloads.download({
      url: item.src,
      filename: item.filename,
      conflictAction: "uniquify",
      saveAs: false,
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
