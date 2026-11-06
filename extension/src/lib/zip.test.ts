import { describe, expect, it } from "vitest";
import { uniqueZipEntryName } from "./zip";

describe("uniqueZipEntryName", () => {
  it("keeps the first name and suffixes later duplicates", () => {
    const used = new Set<string>();
    expect(uniqueZipEntryName("video.mp4", used)).toBe("video.mp4");
    expect(uniqueZipEntryName("video.mp4", used)).toBe("video (2).mp4");
    expect(uniqueZipEntryName("video.mp4", used)).toBe("video (3).mp4");
  });

  it("handles names without an extension", () => {
    const used = new Set<string>();
    expect(uniqueZipEntryName("README", used)).toBe("README");
    expect(uniqueZipEntryName("README", used)).toBe("README (2)");
  });
});
