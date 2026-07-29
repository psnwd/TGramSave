import browser from "webextension-polyfill";
import type { ExtensionMessage } from "@/types/messages";

export function sendToBackground<T = unknown>(message: ExtensionMessage): Promise<T> {
  return browser.runtime.sendMessage(message) as Promise<T>;
}

export async function getActiveTelegramTab(): Promise<browser.Tabs.Tab | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.includes("web.telegram.org") ? tab : undefined;
}

export async function sendToActiveTab<T = unknown>(message: ExtensionMessage): Promise<T | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return undefined;
  return browser.tabs.sendMessage(tab.id, message) as Promise<T>;
}

export function onMessage(handler: (message: ExtensionMessage) => void): () => void {
  const listener = (raw: unknown) => handler(raw as ExtensionMessage);
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
