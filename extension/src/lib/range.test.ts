import { describe, expect, it } from "vitest";
import { backoffMs, parseContentRange, parseRetryAfter } from "./range";

describe("parseContentRange", () => {
  it("parses a normal range", () => {
    expect(parseContentRange("bytes 0-524287/1048576")).toEqual({ start: 0, end: 524287, total: 1048576 });
  });

  it("keeps a null total for the valid wildcard form", () => {
    expect(parseContentRange("bytes 524288-1048575/*")).toEqual({ start: 524288, end: 1048575, total: null });
  });

  it("rejects absent or malformed headers", () => {
    expect(parseContentRange(null)).toBeNull();
    expect(parseContentRange("items 0-1/2")).toBeNull();
    expect(parseContentRange("bytes 0-1")).toBeNull();
  });
});

describe("parseRetryAfter", () => {
  it("parses seconds and ignores HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("backoffMs", () => {
  it("honors Retry-After and caps it", () => {
    expect(backoffMs(0, 2)).toBe(2000);
    expect(backoffMs(0, 999)).toBe(30_000);
  });

  it("grows and stays capped", () => {
    const first = backoffMs(0);
    const later = backoffMs(5);
    expect(first).toBeGreaterThanOrEqual(500);
    expect(later).toBeGreaterThan(first);
    expect(later).toBeLessThanOrEqual(8_250);
  });
});
