import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify from "fastify";

const store = new Map<string, string>();

vi.mock("../src/store/redis.js", () => ({
  redis: { quit: vi.fn() },
  saveContext: vi.fn(async (e164: string, ctx: unknown) => {
    store.set(`ctx:${e164}`, JSON.stringify(ctx));
  }),
  getContext: vi.fn(async (e164: string) => {
    const raw = store.get(`ctx:${e164}`);
    return raw ? JSON.parse(raw) : null;
  }),
}));

vi.mock("../src/config.js", () => ({
  config: {
    crmApiKey: "crm-test-key",
    publicBaseUrl: "https://connector.test.com",
    panelTokenSecret: "test-secret-at-least-32-bytes-long!!",
    panelTokenTtlSeconds: 1800,
    contextTtlSeconds: 900,
    ingestApiKey: "ingest-test-key",
  },
}));

const { crmRoutes } = await import("../src/routes/crm.js");
const { saveContext } = await import("../src/store/redis.js");

const app = Fastify();
beforeAll(async () => {
  await app.register(crmRoutes);
  await app.ready();

  // Seed a context
  await saveContext("+5491155554820", {
    caller_number: "+5491155554820",
    conversation_id: "conv_abc123",
    summary: "Quiere cambiar direccion",
    intent: "cambio_direccion",
    fields: { pedido: "48213" },
    created_at: new Date().toISOString(),
  });
});
afterAll(() => app.close());

describe("GET /crm/contacts/search", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/crm/contacts/search?phone=%2B5491155554820",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 with wrong key", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/crm/contacts/search?phone=%2B5491155554820",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 400 without phone param", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/crm/contacts/search",
      headers: { authorization: "Bearer crm-test-key" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns empty data for unknown number", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/crm/contacts/search?phone=%2B14155551234",
      headers: { authorization: "Bearer crm-test-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it("returns contact with token for known number", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/crm/contacts/search?phone=%2B5491155554820",
      headers: { authorization: "Bearer crm-test-key" },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("ctx_conv_abc123");
    expect(body.data[0].first_name).toBe("Cliente");
    expect(body.data[0].phone).toBe("+5491155554820");
    expect(body.data[0].contact_url).toMatch(
      /^https:\/\/connector\.test\.com\/panel\?token=ey/,
    );
  });

  it("returns empty data for invalid phone format", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/crm/contacts/search?phone=garbage",
      headers: { authorization: "Bearer crm-test-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
  });
});

describe("POST /crm/journal", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/crm/journal",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 with wrong key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/crm/journal",
      payload: {},
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("accepts journal entry and returns ok", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/crm/journal",
      headers: { authorization: "Bearer crm-test-key" },
      payload: {
        Call_From: "+5491155554820",
        Call_To: "1001",
        Talk_Duration_Sec: "120",
        Call_Log_Status: "ANSWERED",
        StartTimeUnix: "1722182400",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});

describe("contacto con datos del CRM del cliente", () => {
  it("usa el nombre del CRM como first_name", async () => {
    await saveContext("+5491166667777", {
      caller_number: "+5491166667777",
      conversation_id: "conv_crm",
      summary: "x",
      intent: "y",
      fields: {},
      created_at: new Date().toISOString(),
      crm: { id: "77", name: "María Pérez", extras: {} },
    });
    const res = await app.inject({
      method: "GET",
      url: "/crm/contacts/search?phone=%2B5491166667777",
      headers: { authorization: "Bearer crm-test-key" },
    });
    expect(res.json().data[0].first_name).toBe("María Pérez");
  });
});
