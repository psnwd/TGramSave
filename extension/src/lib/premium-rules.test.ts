import { describe, expect, it } from "vitest";
import { denyReasonKey } from "./premium-rules";

describe("denyReasonKey", () => {
  it("allows everything for premium", () => {
    expect(denyReasonKey(true, 999, "channel", 10)).toBeNull();
  });

  it("gates channel and batch for free users", () => {
    expect(denyReasonKey(false, 0, "channel", 10)).toBe("premium.channelOnly");
    expect(denyReasonKey(false, 0, "batch", 10)).toBe("premium.batchOnly");
  });

  it("allows free singles below the daily limit and denies at it", () => {
    expect(denyReasonKey(false, 9, "single", 10)).toBeNull();
    expect(denyReasonKey(false, 10, "single", 10)).toBe("premium.freeLimit");
  });
});
