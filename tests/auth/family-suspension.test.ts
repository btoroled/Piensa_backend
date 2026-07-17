import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { FamilyStatus, PrismaClient } from "@prisma/client";
import { conventionsPlugin } from "../../src/plugins/conventions.js";
import { createAuthorization } from "../../src/modules/auth/authorize.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Suspensión de familia efectiva de inmediato (ISSUE-10). `authenticate` lee
// `Family.status` en cada request autenticado de padre/alumno: un token vigente
// no basta si la familia fue suspendida. Se prueba con un stub de prisma (sin
// BD); la evidencia end-to-end contra Postgres va en el test de integración.

const SECRET = "test-secret-at-least-16-chars-long";

// Estado de familia configurable por test, leído por el stub de prisma.
let familyStatus: FamilyStatus = "active";
let lastFamilyIdQueried: string | undefined;

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.register(conventionsPlugin);
  const prisma = {
    family: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        lastFamilyIdQueried = where.id;
        return { status: familyStatus };
      },
    },
  } as unknown as PrismaClient;
  const authz = createAuthorization({ jwtSecret: SECRET, prisma });
  app.register(
    async (scope) => {
      scope.get(
        "/__test/me",
        { preHandler: [authz.authenticate] },
        async () => ({ data: { ok: true } }),
      );
    },
    { prefix: "/api/v1" },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function call(bearer: string) {
  return app.inject({
    method: "GET",
    url: "/api/v1/__test/me",
    headers: { authorization: `Bearer ${bearer}` },
  });
}

const parentToken = () =>
  createAccessToken(SECRET, {
    userId: "p1",
    role: "parent",
    familyId: "fam-1",
  });
const studentToken = () =>
  createAccessToken(SECRET, {
    studentProfileId: "s1",
    role: "student",
    familyId: "fam-1",
  });
const adminToken = () =>
  createAccessToken(SECRET, { userId: "a1", role: "admin" });

describe("suspensión de familia en authenticate", () => {
  test("familia activa → padre pasa (200)", async () => {
    familyStatus = "active";
    const res = await call(await parentToken());
    expect(res.statusCode).toBe(200);
  });

  test("familia suspendida → padre → 403 FAMILY_SUSPENDED (token vigente)", async () => {
    familyStatus = "suspended";
    const res = await call(await parentToken());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FAMILY_SUSPENDED");
  });

  test("familia suspendida → alumno → 403 FAMILY_SUSPENDED", async () => {
    familyStatus = "suspended";
    const res = await call(await studentToken());
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FAMILY_SUSPENDED");
  });

  test("admin no tiene familia: no se consulta estado, pasa (200)", async () => {
    familyStatus = "suspended";
    lastFamilyIdQueried = undefined;
    const res = await call(await adminToken());
    expect(res.statusCode).toBe(200);
    expect(lastFamilyIdQueried).toBeUndefined();
  });

  test("reactivar restaura acceso (200)", async () => {
    familyStatus = "active";
    const res = await call(await parentToken());
    expect(res.statusCode).toBe(200);
  });
});
