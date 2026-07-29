import browser from "webextension-polyfill";

export type ThemePreference = "light" | "dark" | "system";

export type DownloadSettings = {
  defaultFolder: string;
  video: boolean;
  image: boolean;
  document: boolean;
  showInlineButtons: boolean;
  zipByDefault: boolean;
  theme: ThemePreference;
  /** GIFs and animated stickers are served as WebM video — off by default since users rarely want to "download" those. */
  downloadWebm: boolean;
};

const DEFAULT_SETTINGS: DownloadSettings = {
  defaultFolder: "",
  video: true,
  image: true,
  document: false,
  showInlineButtons: true,
  zipByDefault: false,
  theme: "system",
  downloadWebm: false,
};

export async function getSettings(): Promise<DownloadSettings> {
  const stored = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<DownloadSettings> | undefined) };
}

export async function setSettings(settings: DownloadSettings): Promise<void> {
  await browser.storage.local.set({ settings });
}

export async function getVideoList(tabUrlHash: string): Promise<unknown[]> {
  const key = `${tabUrlHash}_video_list`;
  const stored = await browser.storage.local.get(key);
  return (stored[key] as unknown[] | undefined) ?? [];
}

export async function clearVideoList(tabUrlHash: string): Promise<void> {
  await browser.storage.local.set({ [`${tabUrlHash}_video_list`]: {} });
}
