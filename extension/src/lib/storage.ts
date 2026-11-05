import browser from "webextension-polyfill";
import type { ChannelDownloadLimits, DownloadableItem } from "@/types/messages";

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
  /** Bumped whenever the stored shape changes; `getSettings` migrates old values in place. */
  schemaVersion: number;
  /** Locale code or `system` to follow the browser. */
  language: string;
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

export const SETTINGS_SCHEMA_VERSION = 2;

const DEFAULT_SETTINGS: DownloadSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  language: "system",
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

const asBool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
const asCount = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const asTheme = (value: unknown): ThemePreference =>
  value === "light" || value === "dark" || value === "system" ? value : DEFAULT_SETTINGS.theme;

/** Deep-merges defaults (nested channel options used to be lost when a partial shape was stored) and clamps numbers. */
function migrateSettings(raw: Partial<DownloadSettings> | undefined): DownloadSettings {
  const stored = raw ?? {};
  const limits = { ...DEFAULT_SETTINGS.channelLimits, ...(stored.channelLimits ?? {}) };
  const duration = { ...DEFAULT_SETTINGS.channelVideoDuration, ...(stored.channelVideoDuration ?? {}) };

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    language: typeof stored.language === "string" ? stored.language : DEFAULT_SETTINGS.language,
    defaultFolder: typeof stored.defaultFolder === "string" ? stored.defaultFolder : DEFAULT_SETTINGS.defaultFolder,
    video: asBool(stored.video, DEFAULT_SETTINGS.video),
    image: asBool(stored.image, DEFAULT_SETTINGS.image),
    document: asBool(stored.document, DEFAULT_SETTINGS.document),
    showInlineButtons: asBool(stored.showInlineButtons, DEFAULT_SETTINGS.showInlineButtons),
    zipByDefault: asBool(stored.zipByDefault, DEFAULT_SETTINGS.zipByDefault),
    theme: asTheme(stored.theme),
    downloadWebm: asBool(stored.downloadWebm, DEFAULT_SETTINGS.downloadWebm),
    buttonsOnPreviews: asBool(stored.buttonsOnPreviews, DEFAULT_SETTINGS.buttonsOnPreviews),
    channelLimits: {
      video: asCount(limits.video),
      image: asCount(limits.image),
      document: asCount(limits.document),
      total: asCount(limits.total),
    },
    channelVideoDuration: { min: asCount(duration.min), max: asCount(duration.max) },
    channelZipBatchSize: asCount(stored.channelZipBatchSize),
    channelCheckpointEvery: asCount(stored.channelCheckpointEvery),
  };
}

export async function getSettings(): Promise<DownloadSettings> {
  const stored = (await browser.storage.local.get("settings")).settings as Partial<DownloadSettings> | undefined;
  const settings = migrateSettings(stored);
  if (stored?.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    await browser.storage.local.set({ settings });
  }
  return settings;
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

/** Per-chat and global caps so a long browsing session cannot fill `storage.local` (which has no `unlimitedStorage`). */
export const MAX_ITEMS_PER_CHAT = 400;
export const MAX_CATALOG_CHATS = 20;
export const MAX_STORED_THUMBNAILS = 150;

/**
 * Keeps the newest `MAX_ITEMS_PER_CHAT` entries (object insertion order) and drops thumbnails beyond
 * `MAX_STORED_THUMBNAILS`. Returns true when it changed anything.
 */
export function trimCatalogList(list: Record<string, DownloadableItem>): boolean {
  let changed = false;
  const ids = Object.keys(list);

  if (ids.length > MAX_ITEMS_PER_CHAT) {
    for (const id of ids.slice(0, ids.length - MAX_ITEMS_PER_CHAT)) {
      delete list[id];
      changed = true;
    }
  }

  let thumbnails = Object.values(list).filter((item) => item.thumbnailDataUrl).length;
  if (thumbnails > MAX_STORED_THUMBNAILS) {
    for (const item of Object.values(list)) {
      if (thumbnails <= MAX_STORED_THUMBNAILS) break;
      if (item.thumbnailDataUrl) {
        delete item.thumbnailDataUrl;
        thumbnails--;
        changed = true;
      }
    }
  }

  return changed;
}

/** Best-effort startup cleanup for every chat list plus old chat keys. Never throws. */
export async function pruneCatalogStorage(): Promise<void> {
  try {
    const all = await browser.storage.local.get(null);
    const keys = Object.keys(all).filter((key) => key.endsWith("_video_list"));

    for (const key of keys) {
      const list = all[key] as Record<string, DownloadableItem> | undefined;
      if (!list || typeof list !== "object") continue;
      if (trimCatalogList(list)) await browser.storage.local.set({ [key]: list });
    }

    if (keys.length > MAX_CATALOG_CHATS) {
      await browser.storage.local.remove(keys.slice(0, keys.length - MAX_CATALOG_CHATS));
    }
  } catch (err) {
    console.warn("[tgdl] catalog storage prune failed:", err);
  }
}
