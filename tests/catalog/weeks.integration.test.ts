import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// CRUD /admin/weeks end-to-end contra Postgres real (ISSUE-13). Auto-salta sin
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
  console.warn("[weeks] BD no disponible: se saltan los tests (corren en CI).");
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("CRUD /admin/weeks", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let parentToken: string;
  let gradeId: string;
  let courseId: string;
  const emailTag = `w13-${randomUUID()}`;

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
    const grade = await db.grade.create({
      data: {
        name: `Grado-${emailTag}`,
        level: Math.floor(Math.random() * 2_000_000_000),
      },
    });
    gradeId = grade.id;
    const subject = await db.subject.create({
      data: { name: `Mat-${emailTag}` },
    });
    const course = await db.course.create({
      data: {
        subjectId: subject.id,
        gradeId,
        title: `Matemáticas-${emailTag}`,
      },
    });
    courseId = course.id;
  });

  afterAll(async () => {
    // Orden por FK Restrict: lección → semana → curso → materia → grado → familia.
    const weeks = await db.week.findMany({
      where: { courseId },
      select: { id: true },
    });
    await db.lesson.deleteMany({
      where: { weekId: { in: weeks.map((w) => w.id) } },
    });
    await db.week.deleteMany({ where: { courseId } });
    await db.course.deleteMany({ where: { id: courseId } });
    await db.subject.deleteMany({ where: { name: `Mat-${emailTag}` } });
    await db.grade.deleteMany({ where: { id: gradeId } });
    await db.family.deleteMany({ where: { name: `Fam-${emailTag}` } });
    await db.user.deleteMany({ where: { email: { contains: emailTag } } });
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

  test("crear/listar/actualizar semana (admin)", async () => {
    const created = await call("POST", "/admin/weeks", adminToken, {
      courseId,
      number: 1,
      title: "Intro",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id;

    const list = await call(
      "GET",
      `/admin/weeks?courseId=${courseId}`,
      adminToken,
    );
    expect(list.json().data.length).toBeGreaterThanOrEqual(1);

    const upd = await call("PATCH", `/admin/weeks/${id}`, adminToken, {
      title: "Introducción",
    });
    expect(upd.json().data.title).toBe("Introducción");
  });

  test("courseId inexistente → VALIDATION_ERROR", async () => {
    const res = await call("POST", "/admin/weeks", adminToken, {
      courseId: randomUUID(),
      number: 9,
      title: "X",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("número duplicado en el curso → CONFLICT", async () => {
    await call("POST", "/admin/weeks", adminToken, {
      courseId,
      number: 5,
      title: "A",
    });
    const dup = await call("POST", "/admin/weeks", adminToken, {
      courseId,
      number: 5,
      title: "B",
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CONFLICT");
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/weeks", parentToken, {
      courseId,
      number: 2,
      title: "X",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("borrar semana con lecciones → CONFLICT", async () => {
    const w = await call("POST", "/admin/weeks", adminToken, {
      courseId,
      number: 7,
      title: "Con lección",
    });
    const wid = w.json().data.id;
    await db.lesson.create({ data: { weekId: wid, order: 1, type: "video" } });
    const del = await call("DELETE", `/admin/weeks/${wid}`, adminToken);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("CONFLICT");
  });
});
