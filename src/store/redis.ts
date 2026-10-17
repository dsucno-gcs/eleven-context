import { Redis } from "ioredis";
import { config } from "../config.js";
import type { CrmCard, StoredContext } from "../types.js";
import { contextKey, historyKey } from "../lib/phone.js";

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

export async function saveContext(
  e164: string,
  context: StoredContext,
): Promise<void> {
  await redis.set(
    contextKey(e164),
    JSON.stringify(context),
    "EX",
    config.contextTtlSeconds,
  );
}

export async function getContext(
  e164: string,
): Promise<StoredContext | null> {
  const raw = await redis.get(contextKey(e164));
  if (!raw) return null;
  return JSON.parse(raw) as StoredContext;
}

/**
 * Suma la tarjeta del CRM al contexto en curso sin tocar su TTL. Si mientras tanto
 * entró otra conversación para el mismo número, no la pisa.
 */
export async function attachCrm(
  e164: string,
  conversationId: string,
  card: CrmCard,
): Promise<void> {
  const key = contextKey(e164);
  const raw = await redis.get(key);
  if (!raw) return;
  const ctx = JSON.parse(raw) as StoredContext;
  if (ctx.conversation_id !== conversationId) return;
  await redis.set(key, JSON.stringify({ ...ctx, crm: card }), "KEEPTTL");
}

/** true la primera vez por conversacion: evita duplicar la nota si el bot guarda dos veces. */
export async function claimCrmNote(conversationId: string): Promise<boolean> {
  const r = await redis.set(`crmnote:${conversationId}`, "1", "EX", 86400, "NX");
  return r === "OK";
}

/**
 * Agrega una interacción al historial del número y renueva su TTL.
 *
 * Guarda un elemento de más: la interacción en curso también entra en la lista,
 * y el panel la filtra para no mostrarla duplicada. Así quedan `historyMaxItems`
 * interacciones *previas* visibles.
 */
export async function pushHistory(
  e164: string,
  context: StoredContext,
): Promise<void> {
  const key = historyKey(e164);
  await redis
    .multi()
    .lpush(key, JSON.stringify(context))
    .ltrim(key, 0, config.historyMaxItems) // 0..N inclusive = N+1 elementos
    .expire(key, config.historyTtlSeconds)
    .exec();
}

/**
 * Devuelve el historial del número, de la interacción más reciente a la más vieja.
 *
 * Descarta entradas corruptas y deduplica por `conversation_id` conservando la
 * primera aparición (la más reciente): si el bot llama `guardar_contexto` dos veces
 * en la misma llamada, vale la última versión guardada.
 */
export async function getHistory(e164: string): Promise<StoredContext[]> {
  const raw = await redis.lrange(historyKey(e164), 0, config.historyMaxItems);
  const seen = new Set<string>();
  const out: StoredContext[] = [];

  for (const item of raw) {
    let parsed: StoredContext;
    try {
      parsed = JSON.parse(item) as StoredContext;
    } catch {
      continue; // entrada corrupta: se ignora, no rompe el panel
    }
    if (seen.has(parsed.conversation_id)) continue;
    seen.add(parsed.conversation_id);
    out.push(parsed);
  }

  return out;
}
