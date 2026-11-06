import { describe, expect, it } from "vitest";
import { extensionFromContentType, safeZipEntryName, sanitizeDownloadPath, sanitizeFilename } from "./names";

describe("extensionFromContentType", () => {
  it("maps common Telegram types", () => {
    expect(extensionFromContentType("video/quicktime")).toBe("mov");
    expect(extensionFromContentType("image/svg+xml; charset=utf-8")).toBe("svg");
    expect(extensionFromContentType("video/x-matroska")).toBe("mkv");
    expect(extensionFromContentType("image/jpeg")).toBe("jpeg");
  });

  it("falls back and handles missing values", () => {
    expect(extensionFromContentType("application/octet-stream")).toBe("octet-stream");
    expect(extensionFromContentType(null)).toBeUndefined();
  });
});

describe("sanitizeFilename", () => {
  it("removes directory components and reserved characters", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename('bad<>:"|?*name.mp4')).toBe("bad_______name.mp4");
  });

  it("handles control characters without a regex", () => {
    expect(sanitizeFilename("a\u0000b\u001fc")).toBe("a_b_c");
  });

  it("avoids reserved Windows basenames and empty names", () => {
    expect(sanitizeFilename("CON.txt")).toBe("_CON.txt");
    expect(sanitizeFilename("")).toBe("telegram_download");
    expect(sanitizeFilename("...")).toBe("telegram_download");
  });

  it("caps length", () => {
    expect(sanitizeFilename("a".repeat(300))).toHaveLength(150);
  });
});

describe("sanitizeDownloadPath", () => {
  it("keeps intentional folders but drops traversal", () => {
    expect(sanitizeDownloadPath("TelegramMedia/My Channel/video.mp4")).toBe("TelegramMedia/My Channel/video.mp4");
    expect(sanitizeDownloadPath("../../evil/file.mp4")).toBe("evil/file.mp4");
    expect(sanitizeDownloadPath("/absolute/path/file.mp4")).toBe("absolute/path/file.mp4");
  });

  it("falls back for empty paths", () => {
    expect(sanitizeDownloadPath("../..")).toBe("telegram_download");
  });
});

describe("safeZipEntryName", () => {
  it("returns a basename only", () => {
    expect(safeZipEntryName("folder/sub/file.jpg")).toBe("file.jpg");
  });
});
