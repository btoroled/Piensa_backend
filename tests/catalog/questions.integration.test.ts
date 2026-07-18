import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";
import { registerQuestionType } from "../../src/modules/catalog/question-types.js";

// CRUD /admin/questions end-to-end contra Postgres real (ISSUE-15). Auto-salta
// sin BD; corre en CI.

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
    "[questions] BD no disponible: se saltan los tests (corren en CI).",
  );
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("CRUD /admin/questions", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let parentToken: string;
  let gradeId: string;
  let quizLessonId: string;
  let videoLessonId: string;
  const emailTag = `q15-${randomUUID()}`;

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
    const quiz = await db.lesson.create({
      data: { weekId: week.id, order: 1, type: "quiz" },
    });
    quizLessonId = quiz.id;
    const video = await db.lesson.create({
      data: {
        weekId: week.id,
        order: 2,
        type: "video",
        embedUrl: "https://x/v",
      },
    });
    videoLessonId = video.id;
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

  test("crear pregunta de cada tipo v1 (order auto)", async () => {
    const mc = await call("POST", "/admin/questions", adminToken, {
      lessonId: quizLessonId,
      type: "multiple_choice",
      content: { prompt: "¿2+2?", options: ["3", "4"] },
      answerSpec: { correctIndex: 1 },
    });
    expect(mc.statusCode).toBe(201);
    expect(mc.json().data.order).toBe(1);
    const tf = await call("POST", "/admin/questions", adminToken, {
      lessonId: quizLessonId,
      type: "true_false",
      content: { prompt: "¿El cielo es azul?" },
      answerSpec: { answer: true },
    });
    expect(tf.json().data.order).toBe(2);
    const fb = await call("POST", "/admin/questions", adminToken, {
      lessonId: quizLessonId,
      type: "fill_blank",
      content: { prompt: "Capital de Francia" },
      answerSpec: { answer: "París" },
    });
    expect(fb.json().data.order).toBe(3);
  });

  test("content inválido → VALIDATION_ERROR indicando el campo", async () => {
    const res = await call("POST", "/admin/questions", adminToken, {
      lessonId: quizLessonId,
      type: "multiple_choice",
      content: { prompt: "?" },
      answerSpec: { correctIndex: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/content/);
  });

  test("pregunta bajo una lección NO quiz → VALIDATION_ERROR", async () => {
    const res = await call("POST", "/admin/questions", adminToken, {
      lessonId: videoLessonId,
      type: "true_false",
      content: { prompt: "?" },
      answerSpec: { answer: true },
    });
    expect(res.statusCode).toBe(400);
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/questions", parentToken, {
      lessonId: quizLessonId,
      type: "true_false",
      content: { prompt: "?" },
      answerSpec: { answer: true },
    });
    expect(res.statusCode).toBe(403);
  });

  test("PATCH cambia points sin reenviar content; borrar → 200", async () => {
    const q = await call("POST", "/admin/questions", adminToken, {
      lessonId: quizLessonId,
      type: "fill_blank",
      content: { prompt: "Capital de España" },
      answerSpec: { answer: "Madrid" },
    });
    const id = q.json().data.id;
    const upd = await call("PATCH", `/admin/questions/${id}`, adminToken, {
      points: 5,
    });
    expect(upd.json().data.points).toBe(5);
    const del = await call("DELETE", `/admin/questions/${id}`, adminToken);
    expect(del.statusCode).toBe(200);
  });

  test("punto de extensión: registrar tipo ficticio y crearlo por el CRUD (sin migración)", async () => {
    registerQuestionType("fake_slider", {
      contentSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: { prompt: { type: "string", minLength: 1 } },
      },
      answerSpecSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "integer" } },
      },
    });
    const res = await call("POST", "/admin/questions", adminToken, {
      lessonId: quizLessonId,
      type: "fake_slider",
      content: { prompt: "Deslizá" },
      answerSpec: { value: 7 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.type).toBe("fake_slider");
  });
});
