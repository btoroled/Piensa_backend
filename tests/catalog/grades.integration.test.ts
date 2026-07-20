import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// CRUD /admin/grades end-to-end contra Postgres real (ISSUE-13). Auto-salta sin
// BD; corre en CI.

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
if (!dbAvailable)
  console.warn(
    "[grades] BD no disponible: se saltan los tests (corren en CI).",
  );
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("CRUD /admin/grades", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let parentToken: string;
  const gradeIds: string[] = [];
  let subjectId: string;
  const emailTag = `g13-${randomUUID()}`;
  // Nivel único global (los tests corren en paralelo contra la misma BD).
  const lvl = () => Math.floor(Math.random() * 2_000_000_000);

  beforeAll(async () => {
    app = buildApp({ jwtSecret: SECRET, prisma: db });
    await app.ready();
    const admin = await db.user.create({
      data: {
        email: `ad-${emailTag}@piensa.test`,
        passwordHash: "x",
        role: "admin",
      },
    });
    adminToken = await createAccessToken(SECRET, {
      userId: admin.id,
      role: "admin",
    });
    const parent = await db.user.create({
      data: {
        email: `pa-${emailTag}@piensa.test`,
        passwordHash: "x",
        role: "parent",
      },
    });
    const fam = await db.family.create({
      data: { name: `Fam-${emailTag}`, parentUserId: parent.id },
    });
    parentToken = await createAccessToken(SECRET, {
      userId: parent.id,
      role: "parent",
      familyId: fam.id,
    });
    const subject = await db.subject.create({
      data: { name: `Mat-${emailTag}` },
    });
    subjectId = subject.id;
  });

  afterAll(async () => {
    await db.course.deleteMany({ where: { gradeId: { in: gradeIds } } });
    await db.subject.deleteMany({ where: { name: `Mat-${emailTag}` } });
    await db.grade.deleteMany({ where: { id: { in: gradeIds } } });
    await db.family.deleteMany({ where: { name: `Fam-${emailTag}` } });
    await db.user.deleteMany({
      where: { email: { contains: emailTag } },
    });
    await app.close();
    await db.$disconnect();
  });

  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.inject({
      method: method as "POST",
      url: `/api/v1${path}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body ? { payload: body as object } : {}),
    });

  test("crear/leer/actualizar un grado (admin)", async () => {
    const created = await call("POST", "/admin/grades", adminToken, {
      name: "3° Primaria",
      level: lvl(),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id;
    gradeIds.push(id);

    const read = await call("GET", `/admin/grades/${id}`, adminToken);
    expect(read.json().data.name).toBe("3° Primaria");

    const upd = await call("PATCH", `/admin/grades/${id}`, adminToken, {
      name: "4° Primaria",
    });
    expect(upd.json().data.name).toBe("4° Primaria");
  });

  test("nombre vacío → VALIDATION_ERROR", async () => {
    const res = await call("POST", "/admin/grades", adminToken, {
      name: "",
      level: lvl(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("no-admin (parent) → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/grades", parentToken, {
      name: "X",
      level: lvl(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("borrar un grado con cursos → CONFLICT", async () => {
    const g = await call("POST", "/admin/grades", adminToken, {
      name: "Con cursos",
      level: lvl(),
    });
    const gid = g.json().data.id;
    gradeIds.push(gid);
    await db.course.create({
      data: { subjectId, gradeId: gid, title: "Curso" },
    });

    const del = await call("DELETE", `/admin/grades/${gid}`, adminToken);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("CONFLICT");
  });

  test("borrar un grado vacío → 200 y luego 404", async () => {
    const g = await call("POST", "/admin/grades", adminToken, {
      name: "Vacío",
      level: lvl(),
    });
    const gid = g.json().data.id;
    const del = await call("DELETE", `/admin/grades/${gid}`, adminToken);
    expect(del.statusCode).toBe(200);
    const read = await call("GET", `/admin/grades/${gid}`, adminToken);
    expect(read.statusCode).toBe(404);
  });

  test("borrar un grado inexistente → NOT_FOUND", async () => {
    const res = await call(
      "DELETE",
      `/admin/grades/${randomUUID()}`,
      adminToken,
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
