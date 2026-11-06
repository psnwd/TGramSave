import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { APP_VERSION } from "./config";

describe("APP_VERSION", () => {
  it("matches package.json (manifest and popup share one source)", () => {
    expect(APP_VERSION).toBe(pkg.version);
  });
});
