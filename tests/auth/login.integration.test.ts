import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import { hashRefreshToken } from "../../src/modules/auth/refresh-token.js";
import { verifyAccessToken } from "../../src/modules/auth/tokens.js";

// Login end-to-end contra la API real y una BD PostgreSQL migrada (Spec §5, §6).
// Igual que los tests de constraints de ISSUE-05: sin BD disponible se AUTO-
// SALTAN (nada de verde fabricado) y son la evidencia real en CI.

const JWT_SECRET = "integration-secret-at-least-16-chars";
const PASSWORD = "contraseña-correcta-123";

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
    "[login.integration] BD no disponible en DATABASE_URL: se salta el login end-to-end (se ejecuta en CI).",
  );
}

const client = prisma as PrismaClient;
let app: FastifyInstance;

// Datos sembrados, limpiados al final.
const parentEmail = `parent-${randomUUID()}@piensa.test`;
let parentUserId: string;
let familyId: string;

beforeAll(async () => {
  if (!dbAvailable) return;
  app = buildApp({ prisma: client, jwtSecret: JWT_SECRET });
  await app.ready();

  const user = await client.user.create({
    data: {
      email: parentEmail,
      passwordHash: await hashPassword(PASSWORD),
      role: "parent",
    },
  });
  parentUserId = user.id;
  const family = await client.family.create({
    data: { name: "Los Prueba", parentUserId: user.id },
  });
  familyId = family.id;
});

afterAll(async () => {
  if (!dbAvailable) return;
  await client.refreshToken.deleteMany({ where: { userId: parentUserId } });
  await client.family.deleteMany({ where: { id: familyId } });
  await client.user.deleteMany({ where: { id: parentUserId } });
  await app.close();
  await client.$disconnect();
});

async function login(email: string, password: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email, password },
  });
}

describe.skipIf(!dbAvailable)("POST /auth/login — end-to-end", () => {
  test("credenciales válidas devuelven tokens y persisten el refresh hasheado", async () => {
    const res = await login(parentEmail, PASSWORD);

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(typeof data.accessToken).toBe("string");
    expect(typeof data.refreshToken).toBe("string");

    // El access token lleva los claims del padre, incluido familyId.
    const claims = await verifyAccessToken(JWT_SECRET, data.accessToken);
    expect(claims).toMatchObject({
      userId: parentUserId,
      role: "parent",
      familyId,
    });

    // Se persistió el HASH del refresh token, no el token en claro.
    const stored = await client.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(data.refreshToken) },
    });
    expect(stored).not.toBeNull();
    expect(stored?.userId).toBe(parentUserId);
    expect(stored?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const plaintextRow = await client.refreshToken.findUnique({
      where: { tokenHash: data.refreshToken },
    });
    expect(plaintextRow).toBeNull();
  });

  test("contraseña incorrecta → 401 UNAUTHORIZED", async () => {
    const res = await login(parentEmail, "contraseña-mala");
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  test("email inexistente da 401 con el MISMO mensaje (sin enumeración)", async () => {
    const wrongPassword = await login(parentEmail, "contraseña-mala");
    const unknownEmail = await login(
      `nadie-${randomUUID()}@piensa.test`,
      "loquesea",
    );

    expect(unknownEmail.statusCode).toBe(401);
    expect(unknownEmail.json().error.code).toBe("UNAUTHORIZED");
    // Cliente no puede distinguir si el email existe: mismo código y mensaje.
    expect(unknownEmail.json().error.message).toBe(
      wrongPassword.json().error.message,
    );
  });
});
