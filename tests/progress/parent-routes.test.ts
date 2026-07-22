import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

const SECRET = "integration-secret-at-least-16-chars";

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
    "[parent] BD no disponible: se saltan los tests (corren en CI).",
  );
const db = prisma as PrismaClient;
let app: FastifyInstance;

describe.skipIf(!dbAvailable)("Endpoints del padre", () => {
  const tag = `par30-${randomUUID()}`;
  let parentAId: string;
  let famAId: string;
  let child1: string; // con historial
  let gradeId: string;
  let famBId: string;
  let parentBId: string;
  let childB: string;
  let week1Lessons: string[] = [];

  const parentToken = (userId: string, familyId: string) =>
    createAccessToken(SECRET, { userId, role: "parent", familyId });

  beforeAll(async () => {
    if (!dbAvailable) return;
    app = buildApp({ prisma: db, jwtSecret: SECRET });
    await app.ready();

    // Familia A: padre con 2 hijos.
    const pA = await db.user.create({
      data: {
        email: `pa-${tag}@piensa.test`,
        passwordHash: "x",
        role: "parent",
      },
    });
    parentAId = pA.id;
    const famA = await db.family.create({
      data: { name: `FA-${tag}`, parentUserId: pA.id },
    });
    famAId = famA.id;
    const grade = await db.grade.create({
      data: { name: `G-${tag}`, level: Math.floor(Math.random() * 1e6) + 1 },
    });
    gradeId = grade.id;
    const subj = await db.subject.create({ data: { name: `Mate-${tag}` } });
    const course = await db.course.create({
      data: { subjectId: subj.id, gradeId: grade.id, title: "Mate" },
    });
    const w1 = await db.week.create({
      data: { courseId: course.id, number: 1, title: "S1" },
    });
    const l1 = await db.lesson.create({
      data: { weekId: w1.id, order: 1, type: "video" },
    });
    const l2 = await db.lesson.create({
      data: { weekId: w1.id, order: 2, type: "video" },
    });
    week1Lessons = [l1.id, l2.id];

    const c1 = await db.studentProfile.create({
      data: {
        familyId: famA.id,
        name: "Ana",
        avatar: "fox",
        pinHash: "x",
        gradeId: grade.id,
        subjects: { create: [{ subjectId: subj.id }] },
      },
    });
    child1 = c1.id;
    // Segundo hijo sin historial (Beto), no necesitamos su id.
    await db.studentProfile.create({
      data: { familyId: famA.id, name: "Beto", avatar: "cat", pinHash: "x" },
    });

    // Historial de child1: XP, racha, 1 lección completada, maestría, un intento.
    await db.xPEvent.create({
      data: {
        studentProfileId: child1,
        amount: 120,
        reason: "lesson_complete",
        refId: `seed-${randomUUID()}`,
      },
    });
    await db.streak.create({
      data: { studentProfileId: child1, current: 2, longest: 4 },
    });
    await db.lessonProgress.create({
      data: { studentProfileId: child1, lessonId: l1.id },
    });
    const topic = await db.topic.create({ data: { name: `T-${tag}` } });
    await db.topicMastery.create({
      data: { studentProfileId: child1, topicId: topic.id, level: "familiar" },
    });
    await db.quizAttempt.create({
      data: {
        studentProfileId: child1,
        lessonId: l2.id,
        answers: [],
        score: 8,
        maxScore: 10,
      },
    });

    // Familia B: otro padre con un hijo (ajeno a A).
    const pB = await db.user.create({
      data: {
        email: `pb-${tag}@piensa.test`,
        passwordHash: "x",
        role: "parent",
      },
    });
    parentBId = pB.id;
    const famB = await db.family.create({
      data: { name: `FB-${tag}`, parentUserId: pB.id },
    });
    famBId = famB.id;
    const cB = await db.studentProfile.create({
      data: { familyId: famB.id, name: "Cyn", avatar: "owl", pinHash: "x" },
    });
    childB = cB.id;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app.close();
    await db.studentProfile.deleteMany({
      where: { familyId: { in: [famAId, famBId] } },
    });
    await db.lesson.deleteMany({ where: { id: { in: week1Lessons } } });
    await db.week.deleteMany({
      where: { course: { subject: { name: { contains: tag } } } },
    });
    await db.course.deleteMany({
      where: { subject: { name: { contains: tag } } },
    });
    await db.subject.deleteMany({ where: { name: { contains: tag } } });
    await db.topic.deleteMany({ where: { name: { contains: tag } } });
    await db.grade.deleteMany({ where: { id: gradeId } });
    await db.family.deleteMany({ where: { id: { in: [famAId, famBId] } } });
    await db.user.deleteMany({ where: { id: { in: [parentAId, parentBId] } } });
    await db.$disconnect();
  });

  test("GET /family/students: el padre ve exactamente a sus hijos (compacto)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/family/students",
      headers: {
        authorization: `Bearer ${await parentToken(parentAId, famAId)}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data).toHaveLength(2);
    const ana = data.find((c: { name: string }) => c.name === "Ana");
    expect(ana.xp).toEqual({ total: 120, level: 2 });
    expect(ana.streak).toEqual({ current: 2, longest: 4 });
    expect(ana.grade.level).toBeTypeOf("number");
    const beto = data.find((c: { name: string }) => c.name === "Beto");
    expect(beto.xp).toEqual({ total: 0, level: 1 });
    expect(beto.grade).toBeNull();
    // No aparece el hijo de la familia B.
    expect(data.map((c: { id: string }) => c.id)).not.toContain(childB);
  });

  test("GET /:id/progress: avance por semana, maestría, racha, últimos intentos", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/family/students/${child1}/progress`,
      headers: {
        authorization: `Bearer ${await parentToken(parentAId, famAId)}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.student.name).toBe("Ana");
    expect(data.streak).toEqual({ current: 2, longest: 4 });
    // 1 curso, 1 semana, 1 de 2 lecciones completadas.
    expect(data.progress).toHaveLength(1);
    expect(data.progress[0].weeks[0]).toMatchObject({
      total: 2,
      completed: 1,
    });
    expect(data.mastery).toEqual([
      { topicId: expect.any(String), topic: `T-${tag}`, level: "familiar" },
    ]);
    // 1 intento 8/10 → passed (≥70%).
    expect(data.recentAttempts).toHaveLength(1);
    expect(data.recentAttempts[0]).toMatchObject({
      score: 8,
      maxScore: 10,
      passed: true,
    });
  });

  test("hijo ajeno → 403 FORBIDDEN", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/family/students/${childB}/progress`,
      headers: {
        authorization: `Bearer ${await parentToken(parentAId, famAId)}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
