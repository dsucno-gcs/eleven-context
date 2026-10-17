import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/healthz", async (_request, reply) => {
    return reply.send({ status: "ok", timestamp: new Date().toISOString() });
  });
}
