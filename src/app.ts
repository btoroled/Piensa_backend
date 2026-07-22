import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import type { PrismaClient } from "@prisma/client";
import { conventionsPlugin } from "./plugins/conventions.js";
import {
  DEFAULT_RATE_LIMIT,
  rateLimitPlugin,
  type RateLimitConfig,
} from "./plugins/rate-limit.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./modules/auth/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { catalogRoutes } from "./modules/catalog/routes.js";
import { topicsRoutes } from "./modules/catalog/topics-routes.js";
import { uploadsRoutes } from "./modules/admin/uploads-routes.js";
import {
  loadR2Config,
  createPresignUpload,
  type PresignUpload,
} from "./lib/r2.js";
import { familiesRoutes } from "./modules/families/routes.js";
import { subjectsCoursesRoutes } from "./modules/catalog/subjects-courses-routes.js";
import { studentsRoutes } from "./modules/families/students-routes.js";
import { pathRoutes } from "./modules/progress/path-routes.js";
import { lessonRoutes } from "./modules/progress/lesson-routes.js";
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
  // Límites de rate limiting; por defecto los de producción. Los tests los
  // ajustan (p. ej. max bajo) para ejercer el rechazo de forma determinista.
  rateLimit?: RateLimitConfig;
  // Presigner de subida a R2; por defecto se arma desde el entorno si está
  // configurado. Los tests inyectan un mock (no pegan a R2 real).
  r2Presign?: PresignUpload;
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
  const rateLimit = opts.rateLimit ?? DEFAULT_RATE_LIMIT;
  // R2 opcional: si no hay config en el entorno, el presigner queda undefined y
  // /admin/uploads responde error de configuración (la app arranca igual).
  const r2Config = loadR2Config();
  const r2Presign =
    opts.r2Presign ?? (r2Config ? createPresignUpload(r2Config) : undefined);

  app.register(conventionsPlugin);
  // Después de conventions (para tener el x-request-id) y antes de las rutas.
  app.register(rateLimitPlugin, { config: rateLimit });

  app.register(healthRoutes, { prefix: "/api/v1" });
  app.register(
    async (scope) => {
      await authRoutes(scope, {
        prisma,
        jwtSecret,
        authRateLimit: rateLimit.auth,
      });
    },
    { prefix: "/api/v1" },
  );
  app.register(
    async (scope) => {
      await adminRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
  app.register(
    async (scope) => {
      await catalogRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
  app.register(
    async (scope) => {
      await topicsRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
  app.register(
    async (scope) => {
      await uploadsRoutes(scope, {
        prisma,
        jwtSecret,
        presignUpload: r2Presign,
      });
    },
    { prefix: "/api/v1" },
  );
  app.register(
    async (scope) => {
      await familiesRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
  app.register(
    async (scope) => {
      await subjectsCoursesRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
  app.register(
    async (scope) => {
      await studentsRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
  app.register(
    async (scope) => {
      await pathRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
  app.register(
    async (scope) => {
      await lessonRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );

  return app;
}
