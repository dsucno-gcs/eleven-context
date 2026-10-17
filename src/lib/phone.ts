import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Normaliza un número de teléfono a formato E.164.
 * Retorna el número normalizado o null si no es válido.
 */
export function normalizeE164(raw: string): string | null {
  // Intentar parsear tal cual (con código de país)
  let phone = parsePhoneNumberFromString(raw);
  // Si no tiene código de país, asumir Argentina
  if (!phone || !phone.isValid()) {
    phone = parsePhoneNumberFromString(raw, "AR");
  }
  if (!phone || !phone.isValid()) return null;
  return phone.number; // E.164: "+5491155554820"
}

/**
 * Genera la clave Redis para un número E.164.
 */
export function contextKey(e164: string): string {
  return `ctx:${e164}`;
}

/**
 * Genera la clave Redis del historial de interacciones para un número E.164.
 * Es una lista: el elemento 0 es la interacción más reciente.
 */
export function historyKey(e164: string): string {
  return `hist:${e164}`;
}
