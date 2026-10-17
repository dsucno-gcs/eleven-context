import { describe, it, expect, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  config: {
    panelTokenSecret: "test-secret-at-least-32-bytes-long!!",
    panelTokenTtlSeconds: 1800,
  },
}));

const { signPanelToken, verifyPanelToken } = await import(
  "../src/lib/tokens.js"
);

describe("panel tokens", () => {
  const payload = {
    phone: "+5491155554820",
    conversation_id: "conv_abc123",
  };

  it("signs and verifies a token", async () => {
    const token = await signPanelToken(payload);
    expect(typeof token).toBe("string");

    const result = await verifyPanelToken(token);
    expect(result).toEqual(payload);
  });

  it("returns null for a tampered token", async () => {
    const token = await signPanelToken(payload);
    const tampered = token.slice(0, -5) + "XXXXX";

    const result = await verifyPanelToken(tampered);
    expect(result).toBeNull();
  });

  it("returns null for garbage input", async () => {
    const result = await verifyPanelToken("not.a.jwt");
    expect(result).toBeNull();
  });
});
