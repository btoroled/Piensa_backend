import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { conventionsPlugin } from "../../src/plugins/conventions.js";
import { createAuthorization } from "../../src/modules/auth/authorize.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";
import { hashPassword } from "../../src/modules/auth/password.js";

// Pertenencia contra BD (ISSUE-09) end-to-end. Sin BD se AUTO-SALTA (evidencia
// real en CI). Cubre: padre→hijo ajeno → FORBIDDEN aunque el ID exista.

const SECRET = "integration-secret-at-least-16-chars";

function makeClient(): PrismaClient | null {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "") {
    return null;
  }
  try {
    return new PrismaClient();
  } catch {
    return null;
  }
}

async function probe(client: PrismaClient | null): Promise<boolean> {
  if (!client) return false;
  try {
    await client.$queryRawUnsafe("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const prisma = makeClient();
const dbAvailable = await probe(prisma);

if (!dbAvailable) {
  console.warn(
    "[authorization-ownership.integration] BD no disponible: se salta la pertenencia end-to-end (se ejecuta en CI).",
  );
}

const client = prisma as PrismaClient;
let app: FastifyInstance;

const parentAEmail = `parentA-${randomUUID()}@piensa.test`;
const parentBEmail = `parentB-${randomUUID()}@piensa.test`;
let parentAId: string;
let parentBId: string;
let familyAId: string;
let familyBId: string;
let studentAId: string;
let studentBId: string;

beforeAll(async () => {
  if (!dbAvailable) return;
  app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.register(conventionsPlugin);
  const authz = createAuthorization({ jwtSecret: SECRET, prisma: client });
  app.register(
    async (scope) => {
      scope.get(
        "/__test/students/:id",
        {
          preHandler: [
            authz.authenticate,
            authz.requireRole("parent", "student"),
            authz.requireStudentOwnership({ from: "params", key: "id" }),
          ],
        },
        async () => ({ data: { ok: true } }),
      );
    },
    { prefix: "/api/v1" },
  );
  await app.ready();

  const pinHash = await hashPassword("4321");
  const parentA = await client.user.create({
    data: {
      email: parentAEmail,
      passwordHash: await hashPassword("x"),
      role: "parent",
    },
  });
  parentAId = parentA.id;
  const familyA = await client.family.create({
    data: { name: "Familia A", parentUserId: parentA.id },
  });
  familyAId = familyA.id;
  const studentA = await client.studentProfile.create({
    data: { familyId: familyA.id, name: "Hijo A", avatar: "🦊", pinHash },
  });
  studentAId = studentA.id;

  const parentB = await client.user.create({
    data: {
      email: parentBEmail,
      passwordHash: await hashPassword("x"),
      role: "parent",
    },
  });
  parentBId = parentB.id;
  const familyB = await client.family.create({
    data: { name: "Familia B", parentUserId: parentB.id },
  });
  familyBId = familyB.id;
  const studentB = await client.studentProfile.create({
    data: { familyId: familyB.id, name: "Hijo B", avatar: "🐼", pinHash },
  });
  studentBId = studentB.id;
});

afterAll(async () => {
  if (!dbAvailable) return;
  await client.studentProfile.deleteMany({
    where: { id: { in: [studentAId, studentBId] } },
  });
  await client.family.deleteMany({
    where: { id: { in: [familyAId, familyBId] } },
  });
  await client.user.deleteMany({
    where: { id: { in: [parentAId, parentBId] } },
  });
  await app.close();
  await client.$disconnect();
});

async function get(id: string, bearer: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/__test/students/${id}`,
    headers: { authorization: `Bearer ${bearer}` },
  });
}

describe.skipIf(!dbAvailable)("requireStudentOwnership contra BD", () => {
  test("padre → hijo propio → 200", async () => {
    const token = await createAccessToken(SECRET, {
      userId: parentAId,
      role: "parent",
      familyId: familyAId,
    });
    const res = await get(studentAId, token);
    expect(res.statusCode).toBe(200);
  });

  test("padre → hijo de OTRA familia → 403 (aunque el ID exista)", async () => {
    const token = await createAccessToken(SECRET, {
      userId: parentAId,
      role: "parent",
      familyId: familyAId,
    });
    const res = await get(studentBId, token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("alumno → su propio perfil → 200", async () => {
    const token = await createAccessToken(SECRET, {
      studentProfileId: studentAId,
      role: "student",
      familyId: familyAId,
    });
    const res = await get(studentAId, token);
    expect(res.statusCode).toBe(200);
  });

  test("alumno → otro perfil → 403", async () => {
    const token = await createAccessToken(SECRET, {
      studentProfileId: studentAId,
      role: "student",
      familyId: familyAId,
    });
    const res = await get(studentBId, token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
