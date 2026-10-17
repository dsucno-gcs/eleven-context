import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../src/config.js", () => ({ config: { crmAdapterConfig: "" } }));
vi.mock("../src/store/redis.js", () => ({
  attachCrm: vi.fn(async () => {}),
  claimCrmNote: vi.fn(async () => true),
}));

const { createCrmAdapter, getPath, render } = await import("../src/crm/adapter.js");
const { enrichContext } = await import("../src/crm/enrich.js");
const redis = await import("../src/store/redis.js");

// CRM de mentira: una API REST real en un puerto local.
interface Seen {
  method: string;
  url: string;
  auth?: string;
  apiKey?: string;
  body?: string;
}
let seen: Seen[] = [];
let server: Server;
let baseUrl: string;
let slow = false;

const contacts: Record<string, object> = {
  "+5491155554820": {
    id: 77,
    nombre: "María Pérez",
    empresa: { nombre: "Cerámicos SA" },
    etapa: "Cliente activo",
    links: { web: "https://crm.test/contactos/77" },
    owner: { nombre: "Lucía" },
  },
  "1155554820": { id: 88, nombre: "Solo Nacional" },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      seen.push({
        method: req.method!,
        url: req.url!,
        auth: req.headers.authorization,
        apiKey: req.headers["x-api-key"] as string | undefined,
        body,
      });
      const send = (code: number, json: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const reply = () => {
        if (u.pathname === "/contactos" && req.method === "GET") {
          const q = u.searchParams.get("telefono") ?? "";
          const c = contacts[q] ?? contacts["+" + q];
          return send(200, { data: c ? [c] : [] });
        }
        if (u.pathname === "/rota") return send(500, { error: "boom" });
        if (/^\/contactos\/\d+\/notas$/.test(u.pathname) && req.method === "POST")
          return send(201, { ok: true });
        send(404, {});
      };
      if (slow) setTimeout(reply, 400);
      else reply();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
  slow = false;
  vi.clearAllMocks();
});

const baseCfg = () => ({
  baseUrl,
  auth: { type: "bearer", value: "${CRM_TOKEN}" },
  read: {
    path: "/contactos?telefono={{phone}}",
    pick: "data.0",
    map: {
      name: "nombre",
      company: "empresa.nombre",
      status: "etapa",
      url: "links.web",
      extras: { Vendedor: "owner.nombre" },
    },
  },
  write: {
    method: "POST",
    path: "/contactos/{{crm_id}}/notas",
    body: { texto: "{{summary}}", motivo: "{{intent}}" },
  },
});
const make = (cfg: object = baseCfg(), env: NodeJS.ProcessEnv = { CRM_TOKEN: "tok" }) =>
  createCrmAdapter(JSON.stringify(cfg), env)!;

describe("helpers", () => {
  it("getPath recorre objetos y arrays", () => {
    expect(getPath({ a: { b: [{ c: 5 }] } }, "a.b.0.c")).toBe(5);
    expect(getPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(getPath({ a: 1 }, "")).toEqual({ a: 1 });
  });
  it("render codifica para URL solo cuando se pide", () => {
    expect(render("/x?q={{p}}", { p: "+54 9" }, true)).toBe("/x?q=%2B54%209");
    expect(render("{{p}}", { p: "+54 9" }, false)).toBe("+54 9");
  });
});

describe("createCrmAdapter", () => {
  it("sin config devuelve null (el Conector funciona como antes)", () => {
    expect(createCrmAdapter("")).toBeNull();
    expect(createCrmAdapter(undefined)).toBeNull();
  });

  it("falla al arrancar si el JSON es invalido o falta un secreto", () => {
    expect(() => createCrmAdapter("{no es json")).toThrow();
    expect(() => createCrmAdapter(JSON.stringify({ baseUrl: "x" }))).toThrow();
    expect(() => createCrmAdapter(JSON.stringify(baseCfg()), {})).toThrow(/CRM_TOKEN/);
  });

  it("busca por telefono, mapea los campos y manda el bearer", async () => {
    const card = await make().findByPhone("+5491155554820");
    expect(card).toEqual({
      id: "77",
      name: "María Pérez",
      company: "Cerámicos SA",
      status: "Cliente activo",
      url: "https://crm.test/contactos/77",
      extras: { Vendedor: "Lucía" },
    });
    expect(seen[0].url).toBe("/contactos?telefono=%2B5491155554820");
    expect(seen[0].auth).toBe("Bearer tok");
  });

  it("devuelve null si el CRM no tiene al contacto", async () => {
    expect(await make().findByPhone("+5491100000000")).toBeNull();
  });

  it("prueba varios formatos de telefono hasta encontrarlo", async () => {
    const cfg = baseCfg();
    (cfg.read as Record<string, unknown>).phoneFormats = ["e164", "national"];
    (cfg.read as Record<string, unknown>).map = { name: "nombre" };
    // El CRM guarda el numero sin codigo de pais: el 1.º intento falla y el 2.º lo encuentra.
    const card = await make(cfg).findByPhone("+541155554820");
    expect(seen.length).toBe(2);
    expect(card?.name).toBe("Solo Nacional");
  });

  it("autenticacion por header propio, basic y query", async () => {
    const hdr = baseCfg() as Record<string, unknown>;
    hdr.auth = { type: "header", name: "X-Api-Key", value: "k1" };
    await make(hdr).findByPhone("+5491155554820");
    expect(seen[0].apiKey).toBe("k1");

    const basic = baseCfg() as Record<string, unknown>;
    basic.auth = { type: "basic", user: "u", pass: "p" };
    await make(basic).findByPhone("+5491155554820");
    expect(seen[1].auth).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);

    const q = baseCfg() as Record<string, unknown>;
    q.auth = { type: "query", name: "api_key", value: "k2" };
    await make(q).findByPhone("+5491155554820");
    expect(seen[2].url).toContain("api_key=k2");
  });

  it("ignora un enlace que no sea http(s)", async () => {
    contacts["+5491166667777"] = { nombre: "X", links: { web: "javascript:alert(1)" } };
    const card = await make().findByPhone("+5491166667777");
    expect(card?.url).toBeUndefined();
  });

  it("falla si el CRM responde error o tarda mas que el timeout", async () => {
    const rota = baseCfg();
    rota.read.path = "/rota";
    await expect(make(rota).findByPhone("+5491155554820")).rejects.toThrow(/500/);

    slow = true;
    const lento = { ...baseCfg(), timeoutMs: 100 };
    await expect(make(lento).findByPhone("+5491155554820")).rejects.toThrow();
  });

  it("escribe la nota con el cuerpo renderizado", async () => {
    const adapter = make();
    await adapter.writeNote(
      { id: "77", name: "María", extras: {} },
      {
        caller_number: "+5491155554820",
        conversation_id: "conv_1",
        summary: "Quiere cambiar la entrega",
        intent: "cambio",
        fields: {},
        created_at: "2026-10-16T00:00:00Z",
      },
    );
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/contactos/77/notas");
    expect(JSON.parse(seen[0].body!)).toEqual({
      texto: "Quiere cambiar la entrega",
      motivo: "cambio",
    });
  });
});

describe("enrichContext", () => {
  const log = { info: vi.fn(), warn: vi.fn() };
  const ctx = {
    caller_number: "+5491155554820",
    conversation_id: "conv_1",
    summary: "Resumen",
    intent: "x",
    fields: {},
    created_at: "2026-10-16T00:00:00Z",
  };

  it("sin adaptador no hace nada", async () => {
    await enrichContext(ctx, log, null);
    expect(redis.attachCrm).not.toHaveBeenCalled();
  });

  it("asocia la tarjeta al contexto y escribe la nota una sola vez", async () => {
    await enrichContext(ctx, log, make());
    expect(redis.attachCrm).toHaveBeenCalledWith(
      "+5491155554820",
      "conv_1",
      expect.objectContaining({ name: "María Pérez" }),
    );
    expect(seen.map((s) => s.method)).toEqual(["GET", "POST"]);

    vi.mocked(redis.claimCrmNote).mockResolvedValueOnce(false);
    seen = [];
    await enrichContext(ctx, log, make());
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
  });

  it("si el contacto no existe no escribe nada", async () => {
    await enrichContext({ ...ctx, caller_number: "+5491100000000" }, log, make());
    expect(redis.attachCrm).not.toHaveBeenCalled();
    expect(seen.map((s) => s.method)).toEqual(["GET"]);
  });

  it("si el CRM falla, no lanza: solo avisa en el log", async () => {
    const rota = baseCfg();
    rota.read.path = "/rota";
    await expect(enrichContext(ctx, log, make(rota))).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
    expect(redis.attachCrm).not.toHaveBeenCalled();
  });
});
