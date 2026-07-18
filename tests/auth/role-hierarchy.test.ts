import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { conventionsPlugin } from "../../src/plugins/conventions.js";
import { createAuthorization } from "../../src/modules/auth/authorize.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Jerarquía super_admin ⊇ admin (ISSUE-35): un super_admin pasa cualquier
// requireRole('admin'); un admin normal NO pasa requireRole('super_admin').
// Solo rol; el stub de prisma devuelve cuentas activas para authenticate.

const SECRET = "test-secret-at-least-16-chars-long";
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.register(conventionsPlugin);
  const authz = createAuthorization({
    jwtSecret: SECRET,
    prisma: {
      family: { findUnique: async () => ({ status: "active" }) },
      user: { findUnique: async () => ({ status: "active" }) },
    } as unknown as PrismaClient,
  });
  app.register(
    async (scope) => {
      const ok = async () => ({ data: { ok: true } });
      scope.get(
        "/__test/admin-only",
        { preHandler: [authz.authenticate, authz.requireRole("admin")] },
        ok,
      );
      scope.get(
        "/__test/super-only",
        { preHandler: [authz.authenticate, authz.requireRole("super_admin")] },
        ok,
      );
    },
    { prefix: "/api/v1" },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const tokenFor = (role: "admin" | "super_admin") =>
  createAccessToken(SECRET, { userId: "u1", role });

const call = (path: string, bearer: string) =>
  app.inject({
    method: "GET",
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${bearer}` },
  });

describe("jerarquía de roles", () => {
  test("super_admin pasa una ruta requireRole('admin')", async () => {
    const res = await call("/__test/admin-only", await tokenFor("super_admin"));
    expect(res.statusCode).toBe(200);
  });
  test("super_admin pasa una ruta requireRole('super_admin')", async () => {
    const res = await call("/__test/super-only", await tokenFor("super_admin"));
    expect(res.statusCode).toBe(200);
  });
  test("admin NO pasa una ruta requireRole('super_admin')", async () => {
    const res = await call("/__test/super-only", await tokenFor("admin"));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
