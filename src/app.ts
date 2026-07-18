import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { PrismaClient } from "@prisma/client";
import { conventionsPlugin } from "./plugins/conventions.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./modules/auth/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { getPrisma } from "./lib/prisma.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  // Secreto de firma del access token. En producción viene del entorno validado
  // (server.ts); si no se provee se usa un valor de prueba, nunca apto para
  // producción, para que los tests que no ejercen JWT no tengan que pasarlo.
  jwtSecret?: string;
  // Cliente Prisma; por defecto el singleton perezoso. Los tests de integración
  // inyectan el suyo para controlar su ciclo de vida.
  prisma?: PrismaClient;
}

const INSECURE_TEST_SECRET = "insecure-test-secret-do-not-use-in-prod";

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    // ID de correlación fresco por request; se ignora cualquier cabecera
    // entrante para no permitir suplantación ni inyección en los logs.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // Validación estricta (decisión de ISSUE-06 para todo Milestone 1, sobre la
    // nota de review de ISSUE-03): `removeAdditional: false` hace que una
    // propiedad desconocida se rechace con VALIDATION_ERROR en vez de eliminarse
    // en silencio. `coerceTypes` sigue activo (Fastify lo necesita para
    // params/query), por eso los campos sensibles se validan con `pattern`.
    ajv: { customOptions: { removeAdditional: false } },
  });

  const jwtSecret = opts.jwtSecret ?? INSECURE_TEST_SECRET;
  const prisma = opts.prisma ?? getPrisma();

  app.register(conventionsPlugin);

  app.register(healthRoutes, { prefix: "/api/v1" });
  app.register(
    async (scope) => {
      await authRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
  app.register(
    async (scope) => {
      await adminRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );

  return app;
}
