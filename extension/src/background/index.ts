import browser from "webextension-polyfill";
import { refreshPremium } from "@/lib/premium";
import type { ExtensionMessage } from "@/types/messages";
import { clearBadge, updateBadgeFromStorageKey } from "./badge";

browser.runtime.onStartup.addListener(() => void refreshPremium());

browser.runtime.onInstalled.addListener(async (details) => {
  void refreshPremium();
  if (details.reason !== "install") return;
  await browser.tabs.create({ url: "https://web.telegram.org/a" });
});

browser.runtime.onMessage.addListener(async (raw: unknown): Promise<unknown> => {
  const message = raw as ExtensionMessage;

  switch (message.type) {
    case "videoCount":
      return updateBadgeFromStorageKey(message.storageKey);
    case "clearVideoCount":
      return clearBadge();
    case "premium_refresh":
      return refreshPremium();
    case "save_file":
      return browser.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: false,
        conflictAction: "uniquify",
      });
    default:
      return undefined;
  }
});
