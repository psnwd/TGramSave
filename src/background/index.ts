import browser from "webextension-polyfill";
import { downloadChannelItem } from "./downloads";
import { clearBadge, updateBadgeFromStorageKey } from "./badge";
import type { ExtensionMessage } from "@/types/messages";

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  await browser.tabs.create({ url: "https://web.telegram.org/a" });
});

browser.runtime.onMessage.addListener(async (raw: unknown): Promise<unknown> => {
  const message = raw as ExtensionMessage;

  switch (message.type) {
    case "channel_dl_item":
      return downloadChannelItem(message);
    case "videoCount":
      return updateBadgeFromStorageKey(message.storageKey);
    case "clearVideoCount":
      return clearBadge();
    default:
      return undefined;
  }
});
