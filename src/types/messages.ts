/** Every `type`-discriminated message passed via chrome.runtime.sendMessage / chrome.tabs.sendMessage in this extension. */
export type ExtensionMessage =
  // content-script -> background (toolbar badge)
  | { type: "videoCount"; storageKey: string }
  | { type: "clearVideoCount" }
  // content-script -> popup (relayed download progress, only for page:"popup" items)
  | { type: "downloadProgress"; downloadId: string; progress: number }
  // popup <-> content-script ("Download" tab, single/batch/force)
  | {
      type: "singleDownloadPopup";
      videoUrl: string;
      videoId: string;
      page: string;
      downloadId: string;
    }
  | {
      type: "batchDownloadPopup";
      items: Array<{ videoUrl: string; videoId: string; page: string; downloadId: string }>;
      /** Zip every item into one archive and trigger a single download instead of one download per item. */
      zip?: boolean;
      zipName?: string;
    }
  | { type: "forceDownloadPopup" }
  // popup <-> content-script/channel-downloader ("📡 Channel" tab)
  | { type: "channel_dl_start"; options: ChannelDownloadOptions }
  | { type: "channel_dl_stop" }
  | { type: "channel_dl_pause" }
  | { type: "channel_dl_resume" }
  | { type: "channel_dl_get_status" }
  | { type: "channel_dl_check_page" }
  | { type: "channel_dl_open_panel" }
  /** Counts media currently visible in the DOM without starting a download run — lets the popup show a real count (and offers a manual re-scan) instead of a stale "Found: 0" before Start is ever clicked. */
  | { type: "channel_dl_peek"; mediaTypes: { video: boolean; image: boolean; document: boolean } }
  /** popup -> content: while the Channel tab is open, attach a throttled scroll listener that re-counts visible media and pushes `channel_dl_found` when it changes. Re-send with new `mediaTypes` when the checkboxes change. */
  | { type: "channel_dl_watch"; mediaTypes: { video: boolean; image: boolean; document: boolean } }
  /** popup -> content: detach the scroll listener (Channel tab closed / popup unmounted). */
  | { type: "channel_dl_unwatch" }
  /** content -> popup: updated "currently visible" count from the scroll watcher. */
  | { type: "channel_dl_found"; found: number }
  | ({
      type: "channel_dl_status";
      message: string;
      found: number;
      downloaded: number;
      running: boolean;
      paused: boolean;
    } & ChannelDlStatusExtra);

export interface ChannelDownloadOptions {
  folder: string;
  video: boolean;
  image: boolean;
  document: boolean;
  /** Zip every downloaded item into one archive instead of downloading each file individually. */
  zip: boolean;
  /** Per-type caps and an overall cap on how many files a run downloads. `0` on any field means "no limit". */
  limits: ChannelDownloadLimits;
}

export interface ChannelDownloadLimits {
  video: number;
  image: number;
  document: number;
  /** Cap on the combined count across every type. */
  total: number;
}

export interface ChannelDlStatusExtra {
  folder?: string;
  done?: boolean;
  downloaded?: number;
}

export interface ChannelDlCheckPageResponse {
  onTg: boolean;
  version: "a" | "k";
  channelTitle: string;
}

export interface ChannelDlStatusResponse {
  running: boolean;
  paused: boolean;
  found: number;
  downloaded: number;
}

export interface ChannelDlPeekResponse {
  found: number;
}

/** content-script (isolated world) -> content-script-inject (page/main world), via a `video_download` CustomEvent. */
export interface DownloadableItem {
  videoUrl: string;
  videoId: string;
  page: string;
  downloadId: string;
  /** Known at catalog time (which DOM element matched); used for the popup's preview icon and channel per-type limits. */
  kind?: "video" | "image" | "document";
  /** A small `data:` URL snapshot taken via canvas at catalog time, while still in the Telegram page's own context (where `videoUrl`'s often-`blob:` source is valid). Self-contained, so it always renders in the popup regardless of the source URL's cross-origin/blob status. */
  thumbnailDataUrl?: string;
}

export type VideoDownloadEventDetail =
  | { type: "single"; item: DownloadableItem }
  | { type: "batch"; items: DownloadableItem[]; zip?: boolean; zipName?: string };
