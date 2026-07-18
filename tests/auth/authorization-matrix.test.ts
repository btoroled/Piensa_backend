import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { conventionsPlugin } from "../../src/plugins/conventions.js";
import { createAuthorization } from "../../src/modules/auth/authorize.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Matriz rol×endpoint de las primitivas de autorización (ISSUE-09). Solo rol:
// no toca la BD (prisma nunca se invoca en endpoints protegidos solo por rol),
// así que corre en cualquier entorno. Los issues posteriores extienden esta
// matriz agregando filas (endpoints) y reusando `call`.

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
  // `authenticate` consulta `Family.status` (ISSUE-10) y, para admin/super_admin,
  // `User.status` (ISSUE-35); un stub que devuelve ambos activos basta para la
  // matriz de rol (sin BD real).
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
        "/__test/parent-only",
        { preHandler: [authz.authenticate, authz.requireRole("parent")] },
        ok,
      );
      scope.get(
        "/__test/student-only",
        { preHandler: [authz.authenticate, authz.requireRole("student")] },
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

async function tokenFor(
  role: "admin" | "parent" | "student" | "super_admin",
): Promise<string> {
  if (role === "parent")
    return createAccessToken(SECRET, { userId: "p1", role, familyId: "f1" });
  if (role === "student")
    return createAccessToken(SECRET, {
      studentProfileId: "s1",
      role,
      familyId: "f1",
    });
  // admin y super_admin: solo userId.
  return createAccessToken(SECRET, { userId: "u1", role });
}

async function call(path: string, bearer?: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1${path}`,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

// endpoint → estado esperado por principal.
const MATRIX: Record<string, Record<string, number>> = {
  "/__test/admin-only": {
    admin: 200,
    parent: 403,
    student: 403,
    super_admin: 200,
  },
  "/__test/parent-only": {
    admin: 403,
    parent: 200,
    student: 403,
    super_admin: 403,
  },
  "/__test/student-only": {
    admin: 403,
    parent: 403,
    student: 200,
    super_admin: 403,
  },
  "/__test/super-only": {
    admin: 403,
    parent: 403,
    student: 403,
    super_admin: 200,
  },
};

describe("matriz rol×endpoint", () => {
  for (const [path, expected] of Object.entries(MATRIX)) {
    for (const [role, status] of Object.entries(expected)) {
      test(`${role} → ${path} → ${status}`, async () => {
        const res = await call(path, await tokenFor(role as "admin"));
        expect(res.statusCode).toBe(status);
      });
    }

    test(`sin token → ${path} → 401 UNAUTHORIZED`, async () => {
      const res = await call(path);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    });

    test(`token inválido → ${path} → 401 UNAUTHORIZED`, async () => {
      const res = await call(path, "no-es-un-jwt");
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    });
  }
});
