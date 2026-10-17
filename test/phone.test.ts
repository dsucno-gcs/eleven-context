import { describe, it, expect } from "vitest";
import { normalizeE164, contextKey } from "../src/lib/phone.js";

describe("normalizeE164", () => {
  it("normalizes a valid international number", () => {
    expect(normalizeE164("+5491155554820")).toBe("+5491155554820");
  });

  it("normalizes a number with spaces and dashes", () => {
    expect(normalizeE164("+54 9 11 5555-4820")).toBe("+5491155554820");
  });

  it("normalizes a US number", () => {
    expect(normalizeE164("+1 (212) 555-1234")).toBe("+12125551234");
  });

  it("returns null for invalid input", () => {
    expect(normalizeE164("not-a-number")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeE164("")).toBeNull();
  });

  it("returns null for a too-short number", () => {
    expect(normalizeE164("+1")).toBeNull();
  });
});

describe("contextKey", () => {
  it("generates the Redis key", () => {
    expect(contextKey("+5491155554820")).toBe("ctx:+5491155554820");
  });
});
