import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod/v4";
import { config } from "../config.js";
import { normalizeE164 } from "../lib/phone.js";
import { saveContext, pushHistory } from "../store/redis.js";
import { enrichContext } from "../crm/enrich.js";
import type { StoredContext } from "../types.js";

const contextBodySchema = z.object({
  caller_number: z.string().min(1),
  conversation_id: z.string().min(1),
  summary: z.string().min(1),
  intent: z.string().min(1),
  fields: z.record(z.string(), z.unknown()).default({}),
});

function verifyBearer(request: FastifyRequest, reply: FastifyReply): boolean {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing or invalid Authorization header" });
    return false;
  }
  const token = auth.slice(7);
  if (token !== config.ingestApiKey) {
    reply.code(403).send({ error: "Invalid API key" });
    return false;
  }
  return true;
}

export async function contextRoutes(app: FastifyInstance) {
  app.post("/api/context", async (request, reply) => {
    if (!verifyBearer(request, reply)) return;

    const parsed = contextBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid payload",
        details: parsed.error.issues,
      });
    }

    const { caller_number, conversation_id, summary, intent, fields } =
      parsed.data;

    const e164 = normalizeE164(caller_number);
    if (!e164) {
      return reply.code(400).send({
        error: "Invalid phone number",
        detail: `Could not normalize "${caller_number}" to E.164`,
      });
    }

    const context: StoredContext = {
      caller_number: e164,
      conversation_id,
      summary,
      intent,
      fields,
      created_at: new Date().toISOString(),
    };

    await saveContext(e164, context);

    // El historial es secundario: si falla, la llamada tiene que seguir igual.
    // Este endpoint esta en el camino critico de la transferencia — un 500 aca
    // le devuelve un error al LLM y le rompe el flujo al paciente.
    try {
      await pushHistory(e164, context);
    } catch (err) {
      request.log.warn(
        { err, e164, conversation_id },
        "Could not append to history",
      );
    }

    request.log.info(
      { e164, conversation_id, intent },
      "Context saved",
    );

    // Despues de responder: el CRM puede ser lento y no debe demorar al bot.
    void enrichContext(context, request.log);

    return reply.code(200).send({ status: "ok", message: "Contexto guardado" });
  });
}
