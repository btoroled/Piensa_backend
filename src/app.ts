import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { conventionsPlugin } from "./plugins/conventions.js";
import { healthRoutes } from "./routes/health.js";

export function buildApp(
  opts: { logger?: FastifyServerOptions["logger"] } = {},
): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    // ID de correlación fresco por request; se ignora cualquier cabecera
    // entrante para no permitir suplantación ni inyección en los logs.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  app.register(conventionsPlugin);

  app.register(healthRoutes, { prefix: "/api/v1" });

  return app;
}
