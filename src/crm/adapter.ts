import { parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod/v4";
import type { CrmCard, StoredContext } from "../types.js";

/**
 * Adaptador de CRM generico, configurado por JSON (variable CRM_ADAPTER_CONFIG).
 * Sin esa variable el Conector funciona igual que antes. Ver docs/CRM-ADAPTER.md.
 */

const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer"), value: z.string() }),
  z.object({ type: z.literal("header"), name: z.string(), value: z.string() }),
  z.object({ type: z.literal("basic"), user: z.string(), pass: z.string() }),
  z.object({ type: z.literal("query"), name: z.string(), value: z.string() }),
  z.object({ type: z.literal("none") }),
]);

const requestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH"]).default("GET"),
  path: z.string().min(1),
  body: z.unknown().optional(),
});

const configSchema = z.object({
  baseUrl: z.string().url(),
  auth: authSchema.default({ type: "none" }),
  timeoutMs: z.number().int().positive().default(1500),
  headers: z.record(z.string(), z.string()).default({}),
  read: requestSchema.extend({
    /** Ruta (a.b.0.c) del contacto dentro de la respuesta. Vacio = la respuesta entera. */
    pick: z.string().default(""),
    /** Formatos del telefono a probar, en orden, hasta encontrar el contacto. */
    phoneFormats: z
      .array(z.enum(["e164", "digits", "national"]))
      .min(1)
      .default(["e164"]),
    map: z.object({
      id: z.string().default("id"),
      name: z.string(),
      company: z.string().optional(),
      status: z.string().optional(),
      url: z.string().optional(),
      extras: z.record(z.string(), z.string()).default({}),
    }),
  }),
  write: requestSchema.optional(),
});

export type CrmAdapterConfig = z.infer<typeof configSchema>;

export interface CrmAdapter {
  findByPhone(e164: string): Promise<CrmCard | null>;
  /** Deja el contexto de la llamada en el CRM. Solo si el contacto existe. */
  writeNote(card: CrmCard, context: StoredContext): Promise<void>;
  readonly canWrite: boolean;
}

type Vars = Record<string, string>;

/** Reemplaza ${VAR} por el valor del entorno: asi los secretos no viajan dentro del JSON. */
function resolveEnv(raw: string, env: NodeJS.ProcessEnv): string {
  return raw.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`CRM_ADAPTER_CONFIG usa \${${name}} y no esta definida`);
    return v;
  });
}

/** Reemplaza {{var}}. Con encode=true los valores quedan seguros para una URL. */
export function render(tpl: string, vars: Vars, encode: boolean): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => {
    const v = vars[k] ?? "";
    return encode ? encodeURIComponent(v) : v;
  });
}

function renderDeep(value: unknown, vars: Vars): unknown {
  if (typeof value === "string") return render(value, vars, false);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renderDeep(v, vars)]),
    );
  return value;
}

/** Lee "a.b.0.c" de un objeto. Devuelve undefined si algun tramo no existe. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function asText(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

function phoneVars(e164: string, format: "e164" | "digits" | "national"): Vars {
  const national = parsePhoneNumberFromString(e164)?.nationalNumber ?? e164.slice(1);
  const all = { e164, digits: e164.slice(1), national: String(national) };
  return {
    phone: all[format],
    phone_e164: all.e164,
    phone_digits: all.digits,
    phone_national: all.national,
  };
}

export function createCrmAdapter(
  rawConfig: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): CrmAdapter | null {
  if (!rawConfig || !rawConfig.trim()) return null;

  const cfg = configSchema.parse(JSON.parse(resolveEnv(rawConfig, env)));
  const base = cfg.baseUrl.replace(/\/+$/, "");

  async function call(
    req: z.infer<typeof requestSchema>,
    vars: Vars,
  ): Promise<unknown> {
    const url = new URL(base + render(req.path, vars, true));
    const headers: Record<string, string> = {
      accept: "application/json",
      ...cfg.headers,
    };
    const a = cfg.auth;
    if (a.type === "bearer") headers.authorization = `Bearer ${a.value}`;
    else if (a.type === "header") headers[a.name] = a.value;
    else if (a.type === "basic")
      headers.authorization = `Basic ${Buffer.from(`${a.user}:${a.pass}`).toString("base64")}`;
    else if (a.type === "query") url.searchParams.set(a.name, a.value);

    let body: string | undefined;
    if (req.body !== undefined && req.method !== "GET") {
      headers["content-type"] = "application/json";
      body = JSON.stringify(renderDeep(req.body, vars));
    }

    const res = await fetchFn(url, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`CRM respondio ${res.status} en ${req.method} ${url.pathname}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    canWrite: !!cfg.write,

    async findByPhone(e164) {
      const { map } = cfg.read;
      for (const format of cfg.read.phoneFormats) {
        const json = await call(cfg.read, phoneVars(e164, format));
        const found = getPath(json, cfg.read.pick);
        if (found === undefined || found === null) continue;
        if (Array.isArray(found) && found.length === 0) continue;

        const name = asText(getPath(found, map.name));
        if (!name) continue; // sin nombre no hay nada que mostrar

        const url = asText(map.url && getPath(found, map.url));
        const extras: Record<string, string> = {};
        for (const [label, path] of Object.entries(map.extras)) {
          const v = asText(getPath(found, path));
          if (v) extras[label] = v;
        }
        return {
          id: asText(getPath(found, map.id)) ?? "",
          name,
          company: asText(map.company && getPath(found, map.company)),
          status: asText(map.status && getPath(found, map.status)),
          // Solo http(s): el panel lo usa como href.
          url: url && /^https?:\/\//i.test(url) ? url : undefined,
          extras,
        };
      }
      return null;
    },

    async writeNote(card, context) {
      if (!cfg.write) return;
      await call(cfg.write, {
        ...phoneVars(context.caller_number, "e164"),
        crm_id: card.id,
        summary: context.summary,
        intent: context.intent,
        conversation_id: context.conversation_id,
        created_at: context.created_at,
        fields: Object.entries(context.fields)
          .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
          .join("\n"),
      });
    },
  };
}
