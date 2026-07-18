import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// CRUD /admin/lessons + reorder end-to-end contra Postgres real (ISSUE-14).
// Auto-salta sin BD; corre en CI.

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
    "[lessons] BD no disponible: se saltan los tests (corren en CI).",
  );
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("CRUD /admin/lessons + reorder", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let parentToken: string;
  let gradeId: string;
  let weekId: string;
  const emailTag = `l14-${randomUUID()}`;

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
      data: { name: `Grado-${emailTag}` },
    });
    gradeId = grade.id;
    const week = await db.week.create({
      data: { gradeId, number: 1, title: "S1" },
    });
    weekId = week.id;
  });

  afterAll(async () => {
    const weeks = await db.week.findMany({
      where: { gradeId },
      select: { id: true },
    });
    const wids = weeks.map((w) => w.id);
    const lessons = await db.lesson.findMany({
      where: { weekId: { in: wids } },
      select: { id: true },
    });
    await db.question.deleteMany({
      where: { lessonId: { in: lessons.map((l) => l.id) } },
    });
    await db.lesson.deleteMany({ where: { weekId: { in: wids } } });
    await db.week.deleteMany({ where: { gradeId } });
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

  test("crear video/lectura/quiz con su payload; order auto-incremental", async () => {
    const v = await call("POST", "/admin/lessons", adminToken, {
      weekId,
      type: "video",
      embedUrl: "https://x.test/v",
    });
    expect(v.statusCode).toBe(201);
    expect(v.json().data.order).toBe(1);
    const r = await call("POST", "/admin/lessons", adminToken, {
      weekId,
      type: "reading",
      richContent: "Hola",
    });
    expect(r.json().data.order).toBe(2);
    const q = await call("POST", "/admin/lessons", adminToken, {
      weekId,
      type: "quiz",
    });
    expect(q.json().data.order).toBe(3);
  });

  test("payload de tipo cruzado → VALIDATION_ERROR", async () => {
    const res = await call("POST", "/admin/lessons", adminToken, {
      weekId,
      type: "video",
      fileKey: "k",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("embedUrl no-https → VALIDATION_ERROR (schema)", async () => {
    const res = await call("POST", "/admin/lessons", adminToken, {
      weekId,
      type: "video",
      embedUrl: "http://x.test/v",
    });
    expect(res.statusCode).toBe(400);
  });

  test("weekId inexistente → VALIDATION_ERROR", async () => {
    const res = await call("POST", "/admin/lessons", adminToken, {
      weekId: randomUUID(),
      type: "quiz",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/lessons", parentToken, {
      weekId,
      type: "quiz",
    });
    expect(res.statusCode).toBe(403);
  });

  test("PATCH cambia el contenido del tipo; cruzado → VALIDATION_ERROR", async () => {
    const l = await call("POST", "/admin/lessons", adminToken, {
      weekId,
      type: "reading",
      richContent: "A",
    });
    const id = l.json().data.id;
    const ok = await call("PATCH", `/admin/lessons/${id}`, adminToken, {
      fileKey: "lessons/x.pdf",
    });
    expect(ok.json().data.fileKey).toBe("lessons/x.pdf");
    expect(ok.json().data.richContent).toBeNull();
    const bad = await call("PATCH", `/admin/lessons/${id}`, adminToken, {
      embedUrl: "https://x.test/v",
    });
    expect(bad.statusCode).toBe(400);
  });

  test("borrar lección con preguntas → CONFLICT", async () => {
    const q = await call("POST", "/admin/lessons", adminToken, {
      weekId,
      type: "quiz",
    });
    const qid = q.json().data.id;
    await db.question.create({
      data: {
        lessonId: qid,
        order: 1,
        type: "true_false",
        content: {},
        answerSpec: {},
      },
    });
    const del = await call("DELETE", `/admin/lessons/${qid}`, adminToken);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("CONFLICT");
  });

  test("reorder aplica el nuevo orden (atómico)", async () => {
    const w = await db.week.create({
      data: { gradeId, number: 50, title: "R" },
    });
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const l = await db.lesson.create({
        data: { weekId: w.id, order: n, type: "quiz" },
      });
      ids.push(l.id);
    }
    const res = await call("POST", "/admin/lessons/reorder", adminToken, {
      weekId: w.id,
      orderedIds: [ids[2], ids[0], ids[1]],
    });
    expect(res.statusCode).toBe(200);
    const ordered = res.json().data.map((l: { id: string }) => l.id);
    expect(ordered).toEqual([ids[2], ids[0], ids[1]]);
  });

  test("reorder con un ID de otra semana → rechazo total, nada cambia", async () => {
    const w = await db.week.create({
      data: { gradeId, number: 51, title: "R2" },
    });
    const a = await db.lesson.create({
      data: { weekId: w.id, order: 1, type: "quiz" },
    });
    const b = await db.lesson.create({
      data: { weekId: w.id, order: 2, type: "quiz" },
    });
    const foreign = await db.lesson.create({
      data: { weekId, order: 999, type: "quiz" },
    });
    const res = await call("POST", "/admin/lessons/reorder", adminToken, {
      weekId: w.id,
      orderedIds: [b.id, foreign.id],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    const after = await db.lesson.findMany({
      where: { weekId: w.id },
      orderBy: { order: "asc" },
      select: { id: true, order: true },
    });
    expect(after).toEqual([
      { id: a.id, order: 1 },
      { id: b.id, order: 2 },
    ]);
  });

  test("reorder incompleto (falta una) → rechazo", async () => {
    const w = await db.week.create({
      data: { gradeId, number: 52, title: "R3" },
    });
    const a = await db.lesson.create({
      data: { weekId: w.id, order: 1, type: "quiz" },
    });
    await db.lesson.create({ data: { weekId: w.id, order: 2, type: "quiz" } });
    const res = await call("POST", "/admin/lessons/reorder", adminToken, {
      weekId: w.id,
      orderedIds: [a.id],
    });
    expect(res.statusCode).toBe(400);
  });
});
