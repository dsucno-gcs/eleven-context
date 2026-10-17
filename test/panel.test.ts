import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify from "fastify";

const store = new Map<string, string>();
const history = new Map<string, string[]>();

const HISTORY_MAX = 10;

vi.mock("../src/store/redis.js", () => ({
  redis: { quit: vi.fn() },
  saveContext: vi.fn(async (e164: string, ctx: unknown) => {
    store.set(`ctx:${e164}`, JSON.stringify(ctx));
  }),
  getContext: vi.fn(async (e164: string) => {
    const raw = store.get(`ctx:${e164}`);
    return raw ? JSON.parse(raw) : null;
  }),
  pushHistory: vi.fn(async (e164: string, ctx: unknown) => {
    const list = history.get(`hist:${e164}`) ?? [];
    list.unshift(JSON.stringify(ctx));
    history.set(`hist:${e164}`, list.slice(0, HISTORY_MAX + 1));
  }),
  getHistory: vi.fn(async (e164: string) => {
    const list = history.get(`hist:${e164}`) ?? [];
    const seen = new Set<string>();
    const out: { conversation_id: string }[] = [];
    for (const item of list) {
      const parsed = JSON.parse(item);
      if (seen.has(parsed.conversation_id)) continue;
      seen.add(parsed.conversation_id);
      out.push(parsed);
    }
    return out;
  }),
}));

vi.mock("../src/config.js", () => ({
  config: {
    panelTokenSecret: "test-secret-at-least-32-bytes-long!!",
    panelTokenTtlSeconds: 1800,
    contextTtlSeconds: 900,
    historyTtlSeconds: 7776000,
    historyMaxItems: HISTORY_MAX,
  },
}));

const { panelRoutes } = await import("../src/routes/panel.js");
const { signPanelToken } = await import("../src/lib/tokens.js");
const { saveContext, pushHistory } = await import("../src/store/redis.js");

const app = Fastify();
beforeAll(async () => {
  await app.register(panelRoutes);
  await app.ready();

  // Tres interacciones viejas + la actual, en orden cronologico
  for (const c of [
    {
      conversation_id: "conv_old1",
      summary: "Consulta por resultados",
      intent: "consulta_resultados",
      created_at: "2026-05-10T10:00:00.000Z",
    },
    {
      conversation_id: "conv_old2",
      summary: "Pidio turno para resonancia",
      intent: "solicitud_turno",
      created_at: "2026-06-02T15:30:00.000Z",
    },
    {
      conversation_id: "conv_old3",
      summary: "Reclamo por demora",
      intent: "reclamo",
      created_at: "2026-07-01T09:12:00.000Z",
    },
  ]) {
    await pushHistory("+5491155554820", {
      caller_number: "+5491155554820",
      fields: {},
      ...c,
    });
  }

  const current = {
    caller_number: "+5491155554820",
    conversation_id: "conv_abc123",
    summary: "Quiere cambiar direccion",
    intent: "cambio_direccion",
    fields: { pedido: "48213" },
    created_at: "2026-07-28T12:00:00.000Z",
  };
  await saveContext("+5491155554820", current);
  await pushHistory("+5491155554820", current);
});
afterAll(() => app.close());

describe("GET /api/panel-data", () => {
  it("returns 400 without token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/panel-data" });
    expect(res.statusCode).toBe(400);
  });

  it("returns 401 with invalid token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/panel-data?token=garbage",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns context for valid token", async () => {
    const token = await signPanelToken({
      phone: "+5491155554820",
      conversation_id: "conv_abc123",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/panel-data?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.caller_number).toBe("+5491155554820");
    expect(body.conversation_id).toBe("conv_abc123");
    expect(body.summary).toBe("Quiere cambiar direccion");
    expect(body.intent).toBe("cambio_direccion");
    expect(body.fields).toEqual({ pedido: "48213" });
    expect(body.created_at).toBe("2026-07-28T12:00:00.000Z");
  });

  it("returns empty context when no data in redis", async () => {
    const token = await signPanelToken({
      phone: "+14155551234",
      conversation_id: "conv_unknown",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/panel-data?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.caller_number).toBe("+14155551234");
    expect(body.summary).toBe("");
    expect(body.intent).toBe("");
    expect(body.history).toEqual([]);
    expect(body.history_count).toBe(0);
  });
});

describe("historial de interacciones previas", () => {
  const tokenFor = () =>
    signPanelToken({
      phone: "+5491155554820",
      conversation_id: "conv_abc123",
    });

  it("devuelve las interacciones previas, de la mas reciente a la mas vieja", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/panel-data?token=${await tokenFor()}`,
    });
    const body = res.json();
    expect(body.history_count).toBe(3);
    expect(body.history.map((h: { conversation_id: string }) => h.conversation_id)).toEqual([
      "conv_old3",
      "conv_old2",
      "conv_old1",
    ]);
  });

  it("excluye la interaccion en curso para no duplicarla", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/panel-data?token=${await tokenFor()}`,
    });
    const body = res.json();
    expect(body.conversation_id).toBe("conv_abc123");
    expect(
      body.history.some(
        (h: { conversation_id: string }) => h.conversation_id === "conv_abc123",
      ),
    ).toBe(false);
  });

  it("cada entrada trae resumen, intencion, fields y fecha", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/panel-data?token=${await tokenFor()}`,
    });
    expect(res.json().history[0]).toEqual({
      conversation_id: "conv_old3",
      summary: "Reclamo por demora",
      intent: "reclamo",
      fields: {},
      created_at: "2026-07-01T09:12:00.000Z",
    });
  });

  it("recorta a historyMaxItems interacciones previas", async () => {
    const phone = "+5491133334444";
    for (let i = 0; i < HISTORY_MAX + 5; i++) {
      await pushHistory(phone, {
        caller_number: phone,
        conversation_id: `conv_${i}`,
        summary: `Llamada ${i}`,
        intent: "consulta_general",
        fields: {},
        created_at: new Date(2026, 0, i + 1).toISOString(),
      });
    }
    const token = await signPanelToken({
      phone,
      conversation_id: "conv_actual_sin_contexto",
    });
    const body = (
      await app.inject({ method: "GET", url: `/api/panel-data?token=${token}` })
    ).json();
    expect(body.history_count).toBe(HISTORY_MAX);
    expect(body.history).toHaveLength(HISTORY_MAX);
  });

  it("muestra el historial aunque el bot no haya guardado contexto en esta llamada", async () => {
    // Numero con interacciones previas pero sin clave ctx: vigente (TTL vencido,
    // o el bot no llego a llamar guardar_contexto en la llamada actual).
    const phone = "+5491199998888";
    await pushHistory(phone, {
      caller_number: phone,
      conversation_id: "conv_viejo_a",
      summary: "Consulto por una orden medica",
      intent: "consulta_general",
      fields: {},
      created_at: "2026-04-01T11:00:00.000Z",
    });
    const token = await signPanelToken({
      phone,
      conversation_id: "conv_sin_guardar",
    });
    const body = (
      await app.inject({ method: "GET", url: `/api/panel-data?token=${token}` })
    ).json();
    expect(body.summary).toBe(""); // no hay contexto en curso
    expect(body.history_count).toBe(1); // pero el historial se muestra igual
    expect(body.history[0].conversation_id).toBe("conv_viejo_a");
  });
});

describe("GET /panel", () => {
  it("returns 400 without token", async () => {
    const res = await app.inject({ method: "GET", url: "/panel" });
    expect(res.statusCode).toBe(400);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("returns 401 with invalid token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/panel?token=garbage",
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("returns HTML page for valid token", async () => {
    const token = await signPanelToken({
      phone: "+5491155554820",
      conversation_id: "conv_abc123",
    });
    const res = await app.inject({
      method: "GET",
      url: `/panel?token=${token}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<!DOCTYPE html>");
    expect(res.body).toContain("Contexto de llamada");
    expect(res.body).toContain("/api/panel-data");
  });
});

describe("tarjeta del CRM", () => {
  it("panel-data devuelve crm cuando el contexto lo trae", async () => {
    await saveContext("+5491177778888", {
      caller_number: "+5491177778888",
      conversation_id: "conv_crm_panel",
      summary: "Resumen",
      intent: "consulta",
      fields: {},
      created_at: "2026-07-28T12:00:00.000Z",
      crm: {
        id: "77",
        name: "María Pérez",
        company: "Cerámicos SA",
        url: "https://crm.test/c/77",
        extras: { Vendedor: "Lucía" },
      },
    } as never);
    const token = await signPanelToken({
      phone: "+5491177778888",
      conversation_id: "conv_crm_panel",
    });
    const res = await app.inject({ method: "GET", url: `/api/panel-data?token=${token}` });
    expect(res.json().crm).toMatchObject({ name: "María Pérez", company: "Cerámicos SA" });
  });

  it("sin CRM no hay campo crm y el HTML sabe dibujar la tarjeta", async () => {
    const token = await signPanelToken({
      phone: "+5491155554820",
      conversation_id: "conv_abc123",
    });
    const data = await app.inject({ method: "GET", url: `/api/panel-data?token=${token}` });
    expect(data.json().crm).toBeUndefined();
    const html = await app.inject({ method: "GET", url: `/panel?token=${token}` });
    expect(html.body).toContain("crmHtml");
  });
});
