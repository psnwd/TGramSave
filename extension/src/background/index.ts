import browser from "webextension-polyfill";
import { sanitizeDownloadPath } from "@/lib/names";
import { refreshPremium } from "@/lib/premium";
import { pruneCatalogStorage } from "@/lib/storage";
import { isAllowedTelegramUrl } from "@/lib/urls";
import type { ExtensionMessage } from "@/types/messages";
import { clearBadge, updateBadgeFromStorageKey } from "./badge";

browser.runtime.onStartup.addListener(() => {
  void refreshPremium();
  void pruneCatalogStorage();
});

browser.runtime.onInstalled.addListener(async (details) => {
  void refreshPremium();
  void pruneCatalogStorage();
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
    case "save_file": {
      if (!isAllowedTelegramUrl(message.url)) {
        console.warn("[tgdl] refused save_file for a non-Telegram URL:", message.url);
        return undefined;
      }
      return browser.downloads.download({
        url: message.url,
        filename: sanitizeDownloadPath(message.filename),
        saveAs: false,
        conflictAction: "uniquify",
      });
    }
    default:
      return undefined;
  }
});
