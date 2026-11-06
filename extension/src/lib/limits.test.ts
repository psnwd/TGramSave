import { describe, expect, it } from "vitest";
import { areAllCapsReached, dispatchedTotal, isDurationAllowed, isKindCapReached } from "./limits";

const counts = (video = 0, image = 0, document = 0) => ({ video, image, document });

describe("dispatchedTotal", () => {
  it("sums all kinds", () => {
    expect(dispatchedTotal(counts(1, 2, 3))).toBe(6);
  });
});

describe("isKindCapReached", () => {
  const limits = { video: 2, image: 1, document: 0, total: 5 };

  it("uses the per-kind cap", () => {
    expect(isKindCapReached(limits, counts(1), "video")).toBe(false);
    expect(isKindCapReached(limits, counts(2), "video")).toBe(true);
    expect(isKindCapReached(limits, counts(0, 1), "image")).toBe(true);
  });

  it("uses the total cap across kinds", () => {
    expect(isKindCapReached({ ...limits, total: 3 }, counts(1, 1, 1), "video")).toBe(true);
  });

  it("treats 0 as no limit", () => {
    expect(isKindCapReached({ video: 0, image: 0, document: 0, total: 0 }, counts(999, 999, 999), "video")).toBe(false);
  });
});

describe("areAllCapsReached", () => {
  it("is true only when every selected kind is capped", () => {
    const limits = { video: 1, image: 1, document: 0, total: 0 };
    expect(areAllCapsReached(limits, counts(1, 0), { video: true, image: true, document: false })).toBe(false);
    expect(areAllCapsReached(limits, counts(1, 1), { video: true, image: true, document: false })).toBe(true);
  });

  it("ignores unselected kinds", () => {
    const limits = { video: 1, image: 0, document: 0, total: 0 };
    expect(areAllCapsReached(limits, counts(1, 0), { video: true, image: false, document: false })).toBe(true);
  });
});

describe("isDurationAllowed", () => {
  it("includes unknown durations", () => {
    expect(isDurationAllowed(undefined, 10, 20)).toBe(true);
    expect(isDurationAllowed(0, 10, 20)).toBe(true);
  });

  it("applies min/max", () => {
    expect(isDurationAllowed(9, 10, 20)).toBe(false);
    expect(isDurationAllowed(21, 10, 20)).toBe(false);
    expect(isDurationAllowed(10, 10, 20)).toBe(true);
    expect(isDurationAllowed(20, 0, 0)).toBe(true);
  });
});
