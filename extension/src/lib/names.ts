/** Filename and content-type helpers shared by the download bridge. */

const EXT_BY_SUBTYPE: Record<string, string> = {
  "svg+xml": "svg",
  "x-matroska": "mkv",
  "x-msvideo": "avi",
  quicktime: "mov",
  mpeg: "mpg",
  "x-mpeg": "mpg",
  "x-ms-wmv": "wmv",
  "x-flv": "flv",
  "x-m4v": "m4v",
  "vnd.rn-realmedia": "rm",
  "x-shockwave-flash": "swf",
  plain: "txt",
  "xhtml+xml": "xhtml",
  "ld+json": "json",
};

/** `video/quicktime` → `mov`, `image/jpeg` → `jpg`; falls back to the raw subtype for unknowns. */
export function extensionFromContentType(contentType: string | null | undefined): string | undefined {
  if (!contentType) return undefined;
  const subtype = (contentType.split(";")[0] ?? "").split("/")[1]?.trim().toLowerCase();
  if (!subtype) return undefined;
  return EXT_BY_SUBTYPE[subtype] ?? subtype;
}

/** Windows reserves these basenames regardless of extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * Turns an arbitrary (often Telegram-provided) filename into one safe for `chrome.downloads` and ZIP
 * entries: drops directory components and reserved characters, trims trailing dots/spaces, and caps
 * length. Never returns an empty string.
 */
export function sanitizeFilename(name: string, fallback = "telegram_download"): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const withoutControl = Array.from(base, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "_" : char;
  }).join("");
  let clean = withoutControl
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (RESERVED.test(clean)) clean = `_${clean}`;
  if (!clean || clean === "." || clean === "..") clean = fallback;
  return clean.slice(0, 150);
}

/** Ensures a ZIP entry name is relative, unique-looking and not a reserved Windows name. */
export function safeZipEntryName(name: string, fallback = "file"): string {
  return sanitizeFilename(name, fallback);
}

/**
 * Sanitizes a relative save path such as `TelegramMedia/My Channel/video.mp4`. Directory components are
 * kept (the channel downloader uses them intentionally), but `..`, absolute roots, drive letters and
 * reserved characters are removed from every segment.
 */
export function sanitizeDownloadPath(path: string, fallback = "telegram_download"): string {
  const parts = path
    .split(/[/\\]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => sanitizeFilename(part))
    .filter(Boolean);
  return parts.length > 0 ? parts.join("/").slice(0, 200) : fallback;
}
