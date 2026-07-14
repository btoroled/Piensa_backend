import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";

export function buildApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.register(healthRoutes, { prefix: "/api/v1" });

  return app;
}
