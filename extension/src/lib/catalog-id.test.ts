import { describe, expect, it } from "vitest";
import { catalogId } from "./catalog-id";

describe("catalogId", () => {
  it("is stable for a message id and item index even when the src changes", () => {
    const a = catalogId("blob:https://web.telegram.org/one", "42", 2);
    const b = catalogId("blob:https://web.telegram.org/two", "42", 2);
    expect(a).toBe("42_2");
    expect(a).toBe(b);
  });

  it("keeps album siblings distinct", () => {
    expect(catalogId("blob:x", "42", 0)).not.toBe(catalogId("blob:x", "42", 1));
  });

  it("falls back to a short src hash when there is no message id", () => {
    const id = catalogId("https://web.telegram.org/a/progressive/document", undefined, 0);
    expect(id).toHaveLength(12);
    expect(id).toMatch(/^[a-f0-9]{12}$/);
  });
});
