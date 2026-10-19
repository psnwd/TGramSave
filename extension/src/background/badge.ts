import browser from "webextension-polyfill";

/** Reads the `${message}` storage key (a per-chat video list) and shows its item count on the toolbar badge. */
export async function updateBadgeFromStorageKey(storageKey: string): Promise<void> {
  const stored = await browser.storage.local.get(storageKey);
  const list = stored[storageKey];
  const count = Array.isArray(list) ? list.length : Object.keys(list ?? {}).length;
  await browser.action.setBadgeText({ text: count > 0 ? String(count) : "" });
}

export async function clearBadge(): Promise<void> {
  await browser.action.setBadgeText({ text: "0" });
}
