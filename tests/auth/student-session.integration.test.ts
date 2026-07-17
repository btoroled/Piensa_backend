import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import { verifyAccessToken } from "../../src/modules/auth/tokens.js";
import { MAX_PIN_ATTEMPTS } from "../../src/modules/auth/student-session.js";

// Sesión de alumno por PIN end-to-end contra la API real y una BD migrada
// (Spec §2, §5, §6). Igual que el resto de integraciones: sin BD disponible se
// AUTO-SALTAN (nada de verde fabricado) y son la evidencia real en CI.

const JWT_SECRET = "integration-secret-at-least-16-chars";
const PARENT_PASSWORD = "contraseña-correcta-123";
const CORRECT_PIN = "4321";

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
    "[student-session.integration] BD no disponible en DATABASE_URL: se salta la sesión de alumno end-to-end (se ejecuta en CI).",
  );
}

const client = prisma as PrismaClient;
let app: FastifyInstance;

// Padre propio + su hijo; y una segunda familia con su propio hijo (ajeno).
const parentEmail = `parent-${randomUUID()}@piensa.test`;
const otherParentEmail = `other-${randomUUID()}@piensa.test`;
let parentUserId: string;
let otherParentUserId: string;
let familyId: string;
let otherFamilyId: string;
let ownStudentId: string;
let otherStudentId: string;

beforeAll(async () => {
  if (!dbAvailable) return;
  app = buildApp({ prisma: client, jwtSecret: JWT_SECRET });
  await app.ready();

  const pinHash = await hashPassword(CORRECT_PIN);

  const parent = await client.user.create({
    data: {
      email: parentEmail,
      passwordHash: await hashPassword(PARENT_PASSWORD),
      role: "parent",
    },
  });
  parentUserId = parent.id;
  const family = await client.family.create({
    data: { name: "Los Prueba", parentUserId: parent.id },
  });
  familyId = family.id;
  const ownStudent = await client.studentProfile.create({
    data: { familyId: family.id, name: "Hijo Propio", avatar: "🦊", pinHash },
  });
  ownStudentId = ownStudent.id;

  const otherParent = await client.user.create({
    data: {
      email: otherParentEmail,
      passwordHash: await hashPassword(PARENT_PASSWORD),
      role: "parent",
    },
  });
  otherParentUserId = otherParent.id;
  const otherFamily = await client.family.create({
    data: { name: "Los Ajenos", parentUserId: otherParent.id },
  });
  otherFamilyId = otherFamily.id;
  const otherStudent = await client.studentProfile.create({
    data: {
      familyId: otherFamily.id,
      name: "Hijo Ajeno",
      avatar: "🐼",
      pinHash,
    },
  });
  otherStudentId = otherStudent.id;
});

afterAll(async () => {
  if (!dbAvailable) return;
  await client.studentProfile.deleteMany({
    where: { id: { in: [ownStudentId, otherStudentId] } },
  });
  await client.refreshToken.deleteMany({
    where: { userId: { in: [parentUserId, otherParentUserId] } },
  });
  await client.family.deleteMany({
    where: { id: { in: [familyId, otherFamilyId] } },
  });
  await client.user.deleteMany({
    where: { id: { in: [parentUserId, otherParentUserId] } },
  });
  await app.close();
  await client.$disconnect();
});

async function parentAccessToken(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: parentEmail, password: PARENT_PASSWORD },
  });
  return res.json().data.accessToken as string;
}

async function studentSession(
  bearer: string,
  studentProfileId: string,
  pin: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/student-session",
    headers: { authorization: `Bearer ${bearer}` },
    payload: { studentProfileId, pin },
  });
}

describe.skipIf(!dbAvailable)("POST /auth/student-session — end-to-end", () => {
  test("PIN correcto de un hijo propio → token de alumno", async () => {
    const bearer = await parentAccessToken();
    const res = await studentSession(bearer, ownStudentId, CORRECT_PIN);

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    const claims = await verifyAccessToken(JWT_SECRET, data.accessToken);
    expect(claims.role).toBe("student");
    expect(claims.studentProfileId).toBe(ownStudentId);
    expect(claims.familyId).toBe(familyId);
    expect(claims.userId).toBeUndefined();

    // El acierto deja el contador de intentos en cero en la BD.
    const row = await client.studentProfile.findUnique({
      where: { id: ownStudentId },
    });
    expect(row?.failedPinAttempts).toBe(0);
    expect(row?.pinLockedUntil).toBeNull();
  });

  test("PIN de un perfil de OTRA familia → 403 FORBIDDEN", async () => {
    const bearer = await parentAccessToken();
    const res = await studentSession(bearer, otherStudentId, CORRECT_PIN);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("5 fallos bloquean el PIN; luego el PIN correcto sigue dando INVALID_PIN", async () => {
    const bearer = await parentAccessToken();

    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
      const bad = await studentSession(bearer, ownStudentId, "0000");
      expect(bad.statusCode).toBe(401);
      expect(bad.json().error.code).toBe("INVALID_PIN");
    }

    const locked = await client.studentProfile.findUnique({
      where: { id: ownStudentId },
    });
    expect(locked?.failedPinAttempts).toBe(MAX_PIN_ATTEMPTS);
    expect(locked?.pinLockedUntil).not.toBeNull();
    expect(locked?.pinLockedUntil?.getTime()).toBeGreaterThan(Date.now());

    // Estando bloqueado, incluso el PIN correcto se rechaza igual.
    const correct = await studentSession(bearer, ownStudentId, CORRECT_PIN);
    expect(correct.statusCode).toBe(401);
    expect(correct.json().error.code).toBe("INVALID_PIN");
  });
});
