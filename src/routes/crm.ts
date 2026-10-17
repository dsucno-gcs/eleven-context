import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config.js";
import { normalizeE164 } from "../lib/phone.js";
import { signPanelToken } from "../lib/tokens.js";
import { getContext } from "../store/redis.js";
import type { CrmSearchResponse } from "../types.js";

const CONTACT_ID_PREFIX = "ctx_";

function verifyCrmAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    reply.code(401).send({ error: "Missing or invalid Authorization header" });
    return false;
  }
  if (auth.slice(7) !== config.crmApiKey) {
    reply.code(403).send({ error: "Invalid API key" });
    return false;
  }
  return true;
}

export async function crmRoutes(app: FastifyInstance) {
  app.get("/crm/contacts/search", async (request, reply) => {
    if (!verifyCrmAuth(request, reply)) return;

    const { phone } = request.query as { phone?: string };
    if (!phone) {
      return reply.code(400).send({ error: "Missing phone parameter" });
    }

    const e164 = normalizeE164(phone);
    if (!e164) {
      // Yeastar puede mandar formatos raros — devolver vacío, no error
      return reply.send({ data: [] } satisfies CrmSearchResponse);
    }

    const context = await getContext(e164);
    if (!context) {
      return reply.send({ data: [] } satisfies CrmSearchResponse);
    }

    const token = await signPanelToken({
      phone: e164,
      conversation_id: context.conversation_id,
    });

    const contactUrl = `${config.publicBaseUrl}/panel?token=${token}`;

    const response: CrmSearchResponse = {
      data: [
        {
          id: `${CONTACT_ID_PREFIX}${context.conversation_id}`,
          first_name: context.crm?.name ?? "Cliente",
          phone: e164,
          contact_url: contactUrl,
        },
      ],
    };

    request.log.info(
      { e164, conversation_id: context.conversation_id },
      "CRM contact match found",
    );

    return reply.send(response);
  });

  // Call Journal — Yeastar posts CDR when call ends. Solo lo logueamos: es
  // parte obligatoria de la integracion Custom CRM (Yeastar lo llama solo
  // por tener CallJournal=1 en el template), no alimenta nada mas aca.
  app.post("/crm/journal", async (request, reply) => {
    if (!verifyCrmAuth(request, reply)) return;

    const body = request.body as Record<string, unknown>;

    request.log.info(
      {
        call_from: body.Call_From,
        call_to: body.Call_To,
        talk_duration: body.Talk_Duration_Sec,
        status: body.Call_Log_Status,
      },
      "Call journal received",
    );

    return reply.code(200).send({ status: "ok" });
  });
}
