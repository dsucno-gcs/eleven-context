import { config } from "../config.js";
import { createCrmAdapter, type CrmAdapter } from "./adapter.js";
import { attachCrm, claimCrmNote } from "../store/redis.js";
import type { StoredContext } from "../types.js";

export const crmAdapter: CrmAdapter | null = createCrmAdapter(
  config.crmAdapterConfig,
);

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/**
 * Busca el contacto en el CRM del cliente, lo guarda junto al contexto (el panel
 * lo lee de ahi, sin esperar al CRM) y deja el resumen como nota.
 * Corre DESPUES de responderle al bot: nunca puede demorar ni romper la transferencia.
 */
export async function enrichContext(
  context: StoredContext,
  log: Logger,
  adapter: CrmAdapter | null = crmAdapter,
): Promise<void> {
  if (!adapter) return;
  const { caller_number: e164, conversation_id } = context;

  try {
    const card = await adapter.findByPhone(e164);
    if (!card) {
      log.info({ e164, conversation_id }, "CRM: contacto no encontrado");
      return;
    }
    await attachCrm(e164, conversation_id, card);
    log.info({ e164, conversation_id, crm_id: card.id }, "CRM: contacto asociado");

    if (adapter.canWrite && (await claimCrmNote(conversation_id))) {
      await adapter.writeNote(card, context);
      log.info({ e164, conversation_id, crm_id: card.id }, "CRM: nota escrita");
    }
  } catch (err) {
    log.warn({ err, e164, conversation_id }, "CRM: fallo, el panel sale sin tarjeta");
  }
}
