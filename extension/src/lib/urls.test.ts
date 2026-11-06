import { describe, expect, it } from "vitest";
import { isAllowedTelegramUrl } from "./urls";

describe("isAllowedTelegramUrl", () => {
  it("allows Telegram and blob URLs", () => {
    expect(isAllowedTelegramUrl("https://web.telegram.org/a/progressive/document")).toBe(true);
    expect(isAllowedTelegramUrl("blob:https://web.telegram.org/1234")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isAllowedTelegramUrl("https://example.com/file.mp4")).toBe(false);
    expect(isAllowedTelegramUrl("http://web.telegram.org/file.mp4")).toBe(false);
    expect(isAllowedTelegramUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedTelegramUrl("not a url")).toBe(false);
  });
});
