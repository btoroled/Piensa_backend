import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Gestión de admins end-to-end contra Postgres real (ISSUE-35). Auto-salta sin
// BD; corre en CI. Siembra un super_admin y un admin directo por Prisma.

const SECRET = "test-secret-at-least-16-chars-long";

function makeClient(): PrismaClient | null {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "")
    return null;
  try {
    return new PrismaClient();
  } catch {
    return null;
  }
}
async function probe(c: PrismaClient | null): Promise<boolean> {
  if (!c) return false;
  try {
    await c.$queryRawUnsafe("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const prisma = makeClient();
const dbAvailable = await probe(prisma);
if (!dbAvailable) {
  console.warn(
    "[admin-users] BD no disponible: se saltan los tests (corren en CI).",
  );
}
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("gestión de admins (super_admin)", () => {
  let app: FastifyInstance;
  let superToken: string;
  let adminToken: string;
  let superId: string;
  let adminId: string;
  const created: string[] = [];

  beforeAll(async () => {
    app = buildApp({ jwtSecret: SECRET, prisma: db });
    await app.ready();
    const su = await db.user.create({
      data: {
        email: `su-${randomUUID()}@piensa.test`,
        passwordHash: "x",
        role: "super_admin",
      },
    });
    const ad = await db.user.create({
      data: {
        email: `ad-${randomUUID()}@piensa.test`,
        passwordHash: "x",
        role: "admin",
      },
    });
    superId = su.id;
    adminId = ad.id;
    superToken = await createAccessToken(SECRET, {
      userId: su.id,
      role: "super_admin",
    });
    adminToken = await createAccessToken(SECRET, {
      userId: ad.id,
      role: "admin",
    });
  });

  afterAll(async () => {
    for (const id of created) await db.user.deleteMany({ where: { id } });
    await db.user.deleteMany({ where: { id: { in: [superId, adminId] } } });
    await app.close();
    await db.$disconnect();
  });

  const call = (method: string, path: string, token: string, body?: unknown) =>
    app.inject({
      method: method as "POST",
      url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${token}` },
      ...(body ? { payload: body as object } : {}),
    });

  test("super_admin crea un admin (rol admin, 201)", async () => {
    const res = await call("POST", "/admin/users", superToken, {
      email: `new-${randomUUID()}@piensa.test`,
      password: "una-clave-larga-123",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json().data;
    expect(body.role).toBe("admin");
    created.push(body.id);
  });

  test("un admin normal NO puede crear admins → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/users", adminToken, {
      email: `x-${randomUUID()}@piensa.test`,
      password: "una-clave-larga-123",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("suspender un admin corta su acceso en el siguiente request", async () => {
    const res = await call(
      "POST",
      `/admin/users/${adminId}/suspend`,
      superToken,
    );
    expect(res.statusCode).toBe(200);
    // El admin, con su token aún vigente, ya no pasa authenticate: authenticate
    // corre antes que el chequeo de rol, así que corta con ACCOUNT_SUSPENDED.
    const blocked = await call("GET", "/admin/users", adminToken);
    expect(blocked.json().error.code).toBe("ACCOUNT_SUSPENDED");
    // Reactivar lo restaura.
    const re = await call(
      "POST",
      `/admin/users/${adminId}/reactivate`,
      superToken,
    );
    expect(re.statusCode).toBe(200);
  });

  test("no se puede suspender a un super_admin → FORBIDDEN", async () => {
    const res = await call(
      "POST",
      `/admin/users/${superId}/suspend`,
      superToken,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("borrar un admin lo elimina", async () => {
    const victim = await db.user.create({
      data: {
        email: `del-${randomUUID()}@piensa.test`,
        passwordHash: "x",
        role: "admin",
      },
    });
    const res = await call("DELETE", `/admin/users/${victim.id}`, superToken);
    expect(res.statusCode).toBe(200);
    const gone = await db.user.findUnique({ where: { id: victim.id } });
    expect(gone).toBeNull();
  });
});
