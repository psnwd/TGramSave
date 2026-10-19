import browser from "webextension-polyfill";
import type { ChannelDownloadLimits } from "@/types/messages";

export interface DownloadCheckpoint {
  channelKey: string;
  seenUrls: string[];
  totalFound: number;
  totalDownloaded: number;
  savedAt: number;
}

export async function getCheckpoint(channelKey: string): Promise<DownloadCheckpoint | null> {
  const key = `chkpt_${channelKey}`;
  const stored = await browser.storage.local.get(key);
  return (stored[key] as DownloadCheckpoint | undefined) ?? null;
}

export async function saveCheckpoint(cp: DownloadCheckpoint): Promise<void> {
  await browser.storage.local.set({ [`chkpt_${cp.channelKey}`]: cp });
}

export async function clearCheckpoint(channelKey: string): Promise<void> {
  await browser.storage.local.remove(`chkpt_${channelKey}`);
}

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
  /** Show buttons on channel/group preview and invite images (join cards, "channel photo changed" service messages, similar-channels strips). Off by default: those aren't message content. */
  buttonsOnPreviews: boolean;
  /** Channel tab: per-type + total caps on one download run. `0` = no limit. Remembered between popup sessions. */
  channelLimits: ChannelDownloadLimits;
  /** Channel tab: video duration filter in seconds. `0` = no filter. */
  channelVideoDuration: { min: number; max: number };
  /** Channel tab: split zip into parts of this many files. `0` = one zip for everything. */
  channelZipBatchSize: number;
  /** Channel tab: auto-save a resume checkpoint every N dispatched files. `0` = disabled. */
  channelCheckpointEvery: number;
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
  buttonsOnPreviews: false,
  channelLimits: { video: 0, image: 0, document: 0, total: 0 },
  channelVideoDuration: { min: 0, max: 0 },
  channelZipBatchSize: 0,
  channelCheckpointEvery: 0,
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
