import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// CRUD /admin/topics + etiquetado end-to-end contra Postgres real (ISSUE-16).
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
    "[topics] BD no disponible: se saltan los tests (corren en CI).",
  );
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("CRUD /admin/topics + etiquetado", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let parentToken: string;
  let gradeId: string;
  let courseId: string;
  let lessonId: string;
  let questionId: string;
  const topicIds: string[] = [];
  const tag = `t16-${randomUUID()}`;

  beforeAll(async () => {
    app = buildApp({ jwtSecret: SECRET, prisma: db });
    await app.ready();
    const admin = await db.user.create({
      data: {
        email: `ad-${tag}@piensa.test`,
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
        email: `pa-${tag}@piensa.test`,
        passwordHash: "x",
        role: "parent",
      },
    });
    const fam = await db.family.create({
      data: { name: `Fam-${tag}`, parentUserId: parent.id },
    });
    parentToken = await createAccessToken(SECRET, {
      userId: parent.id,
      role: "parent",
      familyId: fam.id,
    });
    const grade = await db.grade.create({
      data: {
        name: `Grado-${tag}`,
        level: Math.floor(Math.random() * 2_000_000_000),
      },
    });
    gradeId = grade.id;
    const subject = await db.subject.create({ data: { name: `Mat-${tag}` } });
    const course = await db.course.create({
      data: { subjectId: subject.id, gradeId, title: `Matemáticas-${tag}` },
    });
    courseId = course.id;
    const week = await db.week.create({
      data: { courseId, number: 1, title: "S1" },
    });
    const lesson = await db.lesson.create({
      data: { weekId: week.id, order: 1, type: "quiz" },
    });
    lessonId = lesson.id;
    const question = await db.question.create({
      data: {
        lessonId,
        order: 1,
        type: "true_false",
        content: {},
        answerSpec: {},
      },
    });
    questionId = question.id;
  });

  afterAll(async () => {
    await db.lessonTopic.deleteMany({ where: { lessonId } });
    await db.questionTopic.deleteMany({ where: { questionId } });
    await db.question.deleteMany({ where: { lessonId } });
    await db.lesson.deleteMany({ where: { id: lessonId } });
    await db.week.deleteMany({ where: { courseId } });
    await db.course.deleteMany({ where: { id: courseId } });
    await db.subject.deleteMany({ where: { name: `Mat-${tag}` } });
    await db.grade.deleteMany({ where: { id: gradeId } });
    await db.topic.deleteMany({ where: { name: { contains: tag } } });
    await db.family.deleteMany({ where: { name: `Fam-${tag}` } });
    await db.user.deleteMany({ where: { email: { contains: tag } } });
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

  test("crear/leer/actualizar/listar topic (admin)", async () => {
    const c = await call("POST", "/admin/topics", adminToken, {
      name: `Frac-${tag}`,
    });
    expect(c.statusCode).toBe(201);
    const id = c.json().data.id;
    topicIds.push(id);
    const r = await call("GET", `/admin/topics/${id}`, adminToken);
    expect(r.json().data.name).toBe(`Frac-${tag}`);
    const u = await call("PATCH", `/admin/topics/${id}`, adminToken, {
      name: `Fracciones-${tag}`,
    });
    expect(u.json().data.name).toBe(`Fracciones-${tag}`);
  });

  test("nombre duplicado → CONFLICT", async () => {
    await call("POST", "/admin/topics", adminToken, { name: `Dup-${tag}` });
    const dup = await call("POST", "/admin/topics", adminToken, {
      name: `Dup-${tag}`,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CONFLICT");
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/topics", parentToken, { name: "X" });
    expect(res.statusCode).toBe(403);
  });

  test("una pregunta puede tener varios topics; etiquetar es idempotente", async () => {
    const t1 = (
      await call("POST", "/admin/topics", adminToken, { name: `T1-${tag}` })
    ).json().data.id;
    const t2 = (
      await call("POST", "/admin/topics", adminToken, { name: `T2-${tag}` })
    ).json().data.id;
    topicIds.push(t1, t2);
    expect(
      (
        await call(
          "POST",
          `/admin/questions/${questionId}/topics`,
          adminToken,
          {
            topicId: t1,
          },
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call(
          "POST",
          `/admin/questions/${questionId}/topics`,
          adminToken,
          {
            topicId: t2,
          },
        )
      ).statusCode,
    ).toBe(201);
    // Idempotente: re-etiquetar → 200, sin duplicar.
    expect(
      (
        await call(
          "POST",
          `/admin/questions/${questionId}/topics`,
          adminToken,
          {
            topicId: t1,
          },
        )
      ).statusCode,
    ).toBe(200);
    const list = await call(
      "GET",
      `/admin/questions/${questionId}/topics`,
      adminToken,
    );
    expect(list.json().data.length).toBe(2);
  });

  test("etiquetar con topic inexistente → VALIDATION_ERROR", async () => {
    const res = await call(
      "POST",
      `/admin/questions/${questionId}/topics`,
      adminToken,
      { topicId: randomUUID() },
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("borrar un topic en uso → CONFLICT; desetiquetar y luego sí borra", async () => {
    const tid = (
      await call("POST", "/admin/topics", adminToken, { name: `EnUso-${tag}` })
    ).json().data.id;
    await call("POST", `/admin/lessons/${lessonId}/topics`, adminToken, {
      topicId: tid,
    });
    const del = await call("DELETE", `/admin/topics/${tid}`, adminToken);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("CONFLICT");
    // Desetiquetar y ahora sí se borra.
    await call(
      "DELETE",
      `/admin/lessons/${lessonId}/topics/${tid}`,
      adminToken,
    );
    expect(
      (await call("DELETE", `/admin/topics/${tid}`, adminToken)).statusCode,
    ).toBe(200);
  });

  test("desetiquetar algo no etiquetado → NOT_FOUND", async () => {
    const tid = (
      await call("POST", "/admin/topics", adminToken, { name: `Libre-${tag}` })
    ).json().data.id;
    topicIds.push(tid);
    const res = await call(
      "DELETE",
      `/admin/lessons/${lessonId}/topics/${tid}`,
      adminToken,
    );
    expect(res.statusCode).toBe(404);
  });
});
