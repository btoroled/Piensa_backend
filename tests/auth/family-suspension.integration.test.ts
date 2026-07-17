import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { conventionsPlugin } from "../../src/plugins/conventions.js";
import { createAuthorization } from "../../src/modules/auth/authorize.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";
import { hashPassword } from "../../src/modules/auth/password.js";

// Suspensión de familia efectiva de inmediato (ISSUE-10) end-to-end. Sin BD se
// AUTO-SALTA (evidencia real en CI). Cubre: suspender corta el acceso de padre e
// hijos en el siguiente request con token AÚN VÁLIDO; reactivar lo restaura.

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
    "[family-suspension.integration] BD no disponible: se salta la suspensión end-to-end (se ejecuta en CI).",
  );
}

const client = prisma as PrismaClient;
let app: FastifyInstance;

const parentEmail = `parent-${randomUUID()}@piensa.test`;
let parentUserId: string;
let familyId: string;
let studentProfileId: string;

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
        "/__test/me",
        { preHandler: [authz.authenticate] },
        async () => ({ data: { ok: true } }),
      );
    },
    { prefix: "/api/v1" },
  );
  await app.ready();

  const parent = await client.user.create({
    data: {
      email: parentEmail,
      passwordHash: await hashPassword("x"),
      role: "parent",
    },
  });
  parentUserId = parent.id;
  const family = await client.family.create({
    data: { name: "Los Prueba", parentUserId: parent.id },
  });
  familyId = family.id;
  const student = await client.studentProfile.create({
    data: {
      familyId: family.id,
      name: "Hijo",
      avatar: "🦊",
      pinHash: await hashPassword("4321"),
    },
  });
  studentProfileId = student.id;
});

afterAll(async () => {
  if (!dbAvailable) return;
  await client.studentProfile.deleteMany({ where: { id: studentProfileId } });
  await client.family.deleteMany({ where: { id: familyId } });
  await client.user.deleteMany({ where: { id: parentUserId } });
  await app.close();
  await client.$disconnect();
});

async function me(bearer: string) {
  return app.inject({
    method: "GET",
    url: "/api/v1/__test/me",
    headers: { authorization: `Bearer ${bearer}` },
  });
}

async function setStatus(status: "active" | "suspended") {
  await client.family.update({ where: { id: familyId }, data: { status } });
}

describe.skipIf(!dbAvailable)("suspensión de familia end-to-end", () => {
  test("suspender corta el acceso de padre e hijos con token aún válido", async () => {
    const parentToken = await createAccessToken(SECRET, {
      userId: parentUserId,
      role: "parent",
      familyId,
    });
    const studentToken = await createAccessToken(SECRET, {
      studentProfileId,
      role: "student",
      familyId,
    });

    // Con la familia activa, ambos tokens dan acceso.
    await setStatus("active");
    expect((await me(parentToken)).statusCode).toBe(200);
    expect((await me(studentToken)).statusCode).toBe(200);

    // Se suspende (los tokens NO se tocan: siguen vigentes).
    await setStatus("suspended");
    const parentRes = await me(parentToken);
    expect(parentRes.statusCode).toBe(403);
    expect(parentRes.json().error.code).toBe("FAMILY_SUSPENDED");
    const studentRes = await me(studentToken);
    expect(studentRes.statusCode).toBe(403);
    expect(studentRes.json().error.code).toBe("FAMILY_SUSPENDED");
  });

  test("reactivar restaura el acceso", async () => {
    const parentToken = await createAccessToken(SECRET, {
      userId: parentUserId,
      role: "parent",
      familyId,
    });

    await setStatus("suspended");
    expect((await me(parentToken)).statusCode).toBe(403);

    await setStatus("active");
    expect((await me(parentToken)).statusCode).toBe(200);
  });
});
