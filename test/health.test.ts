import { describe, it, expect, afterAll } from "vitest";
import Fastify from "fastify";
import { healthRoutes } from "../src/routes/health.js";

const app = Fastify();
app.register(healthRoutes);

afterAll(() => app.close());

describe("GET /healthz", () => {
  it("returns status ok", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });
});
