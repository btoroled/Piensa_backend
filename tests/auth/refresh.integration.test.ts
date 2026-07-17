import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import { verifyAccessToken } from "../../src/modules/auth/tokens.js";

// Refresh con rotación end-to-end contra la API real y una BD migrada (Spec §5,
// §6). Igual que los demás tests de BD: se AUTO-SALTA sin Postgres y es la
// evidencia real en CI.

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
    "[refresh.integration] BD no disponible en DATABASE_URL: se salta el refresh end-to-end (se ejecuta en CI).",
  );
}

const client = prisma as PrismaClient;
let app: FastifyInstance;

const parentEmail = `refresh-${randomUUID()}@piensa.test`;
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
    data: { name: "Los Refresh", parentUserId: user.id },
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

async function login(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { email: parentEmail, password: PASSWORD },
  });
  return res.json().data.refreshToken as string;
}

async function doRefresh(refreshToken: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: { refreshToken },
  });
}

describe.skipIf(!dbAvailable)("POST /auth/refresh — end-to-end", () => {
  test("refresh válido emite tokens nuevos y el anterior deja de servir", async () => {
    const rt1 = await login();

    const rotated = await doRefresh(rt1);
    expect(rotated.statusCode).toBe(200);
    const { data } = rotated.json();
    expect(typeof data.accessToken).toBe("string");
    expect(data.refreshToken).not.toBe(rt1);

    const claims = await verifyAccessToken(JWT_SECRET, data.accessToken);
    expect(claims).toMatchObject({
      userId: parentUserId,
      role: "parent",
      familyId,
    });

    // El token anterior ya no sirve.
    const reused = await doRefresh(rt1);
    expect(reused.statusCode).toBe(401);
    expect(reused.json().error.code).toBe("UNAUTHORIZED");
  });

  test("reusar un token rotado revoca toda la cadena de la sesión", async () => {
    const rt1 = await login();

    // Rotación legítima rt1 → rt2.
    const rotated = await doRefresh(rt1);
    const rt2 = rotated.json().data.refreshToken as string;

    // Reuso de rt1 (revocado) → 401 y detección de robo.
    const reuse = await doRefresh(rt1);
    expect(reuse.statusCode).toBe(401);

    // Consecuencia: rt2, que era válido, también queda revocado.
    const rt2After = await doRefresh(rt2);
    expect(rt2After.statusCode).toBe(401);
    expect(rt2After.json().error.code).toBe("UNAUTHORIZED");
  });

  test("un refresh token inexistente → 401", async () => {
    const res = await doRefresh("A".repeat(43));
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });
});
