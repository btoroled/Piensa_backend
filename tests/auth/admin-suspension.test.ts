import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { conventionsPlugin } from "../../src/plugins/conventions.js";
import { createAuthorization } from "../../src/modules/auth/authorize.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Suspensión de admin efectiva de inmediato (ISSUE-35): con el token válido, si
// User.status = suspended el request se corta con ACCOUNT_SUSPENDED. Stub de
// prisma parametrizable por status.

const SECRET = "test-secret-at-least-16-chars-long";

function appWithUserStatus(status: "active" | "suspended"): FastifyInstance {
  const app = Fastify({
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
      user: { findUnique: async () => ({ status }) },
    } as unknown as PrismaClient,
  });
  app.register(
    async (scope) => {
      scope.get(
        "/__test/admin-only",
        { preHandler: [authz.authenticate, authz.requireRole("admin")] },
        async () => ({ data: { ok: true } }),
      );
    },
    { prefix: "/api/v1" },
  );
  return app;
}

const call = (app: FastifyInstance, bearer: string) =>
  app.inject({
    method: "GET",
    url: "/api/v1/__test/admin-only",
    headers: { authorization: `Bearer ${bearer}` },
  });

describe("suspensión de cuenta admin", () => {
  let active: FastifyInstance;
  let suspended: FastifyInstance;
  beforeAll(async () => {
    active = appWithUserStatus("active");
    suspended = appWithUserStatus("suspended");
    await Promise.all([active.ready(), suspended.ready()]);
  });
  afterAll(async () => {
    await Promise.all([active.close(), suspended.close()]);
  });

  test("admin activo pasa", async () => {
    const token = await createAccessToken(SECRET, {
      userId: "a1",
      role: "admin",
    });
    expect((await call(active, token)).statusCode).toBe(200);
  });

  test("admin suspendido → ACCOUNT_SUSPENDED con token aún vigente", async () => {
    const token = await createAccessToken(SECRET, {
      userId: "a1",
      role: "admin",
    });
    const res = await call(suspended, token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ACCOUNT_SUSPENDED");
  });

  test("super_admin suspendido también se corta", async () => {
    const token = await createAccessToken(SECRET, {
      userId: "s1",
      role: "super_admin",
    });
    const res = await call(suspended, token);
    expect(res.json().error.code).toBe("ACCOUNT_SUSPENDED");
  });
});
