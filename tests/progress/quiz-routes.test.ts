import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient, type Prisma } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";
import { seedBadges } from "../../src/modules/gamification/badges.js";

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
  console.warn("[quiz] BD no disponible: se saltan los tests (corren en CI).");
const db = prisma as PrismaClient;
let app: FastifyInstance;

const CORRECT_FILL = "SECRETO_LIMA";

describe.skipIf(!dbAvailable)("POST /quizzes/:id/attempts", () => {
  const tag = `qz24-${randomUUID()}`;
  let userId: string;
  let famId: string;
  let studentId: string;
  let quizId: string;
  let topicA: string;
  let topicB: string;
  const q: Record<string, string> = {};

  async function submit(
    lessonId: string,
    answers: { questionId: string; answer?: string | number | boolean }[],
  ) {
    const token = await createAccessToken(SECRET, {
      studentProfileId: studentId,
      role: "student",
      familyId: famId,
    });
    return app.inject({
      method: "POST",
      url: `/api/v1/quizzes/${lessonId}/attempts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { answers },
    });
  }
  const pass = () => [
    { questionId: q.q1 as string, answer: 1 }, // correcto
    { questionId: q.q2 as string, answer: true }, // correcto
    { questionId: q.q3 as string, answer: CORRECT_FILL }, // correcto
    { questionId: q.q4 as string, answer: "brasil" }, // incorrecto → 30/40 = 75%
  ];
  const fail = () => [
    { questionId: q.q1 as string, answer: 0 },
    { questionId: q.q2 as string, answer: false },
    { questionId: q.q3 as string, answer: "x" },
    { questionId: q.q4 as string, answer: "y" },
  ];

  beforeAll(async () => {
    if (!dbAvailable) return;
    app = buildApp({ prisma: db, jwtSecret: SECRET });
    await app.ready();
    await seedBadges(db);

    const user = await db.user.create({
      data: {
        email: `u-${tag}@piensa.test`,
        passwordHash: "x",
        role: "parent",
      },
    });
    userId = user.id;
    const fam = await db.family.create({
      data: { name: `F-${tag}`, parentUserId: user.id },
    });
    famId = fam.id;
    const grade = await db.grade.create({
      data: { name: `G-${tag}`, level: Math.floor(Math.random() * 1e6) + 1 },
    });
    const subj = await db.subject.create({ data: { name: `Mate-${tag}` } });
    const course = await db.course.create({
      data: { subjectId: subj.id, gradeId: grade.id, title: "Mate" },
    });
    const w1 = await db.week.create({
      data: { courseId: course.id, number: 1, title: "S1" },
    });
    const quiz = await db.lesson.create({
      data: { weekId: w1.id, order: 1, type: "quiz" },
    });
    quizId = quiz.id;
    topicA = (await db.topic.create({ data: { name: `A-${tag}` } })).id;
    topicB = (await db.topic.create({ data: { name: `B-${tag}` } })).id;

    const mk = async (
      order: number,
      type: string,
      answerSpec: Prisma.InputJsonValue,
      topic: string,
    ) => {
      const created = await db.question.create({
        data: {
          lessonId: quiz.id,
          order,
          type,
          content: { prompt: `p${order}` },
          answerSpec,
          points: 10,
          topics: { create: { topicId: topic } },
        },
      });
      return created.id;
    };
    q.q1 = await mk(1, "multiple_choice", { correctIndex: 1 }, topicA);
    q.q2 = await mk(2, "true_false", { answer: true }, topicA);
    q.q3 = await mk(3, "fill_blank", { answer: CORRECT_FILL }, topicB);
    q.q4 = await mk(4, "fill_blank", { answer: "peru" }, topicB);

    const st = await db.studentProfile.create({
      data: {
        familyId: fam.id,
        name: "Ana",
        avatar: "fox",
        pinHash: "x",
        gradeId: grade.id,
        subjects: { create: [{ subjectId: subj.id }] },
      },
    });
    studentId = st.id;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app.close();
    await db.studentProfile.deleteMany({ where: { familyId: famId } });
    await db.question.deleteMany({ where: { lessonId: quizId } });
    await db.lesson.deleteMany({ where: { id: quizId } });
    await db.week.deleteMany({
      where: { course: { subject: { name: { contains: tag } } } },
    });
    await db.course.deleteMany({
      where: { subject: { name: { contains: tag } } },
    });
    await db.subject.deleteMany({ where: { name: { contains: tag } } });
    await db.topic.deleteMany({ where: { name: { contains: tag } } });
    await db.grade.deleteMany({ where: { name: `G-${tag}` } });
    await db.family.deleteMany({ where: { id: famId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  test("intento aprobado mixto: califica, no revela respuestas, +20 XP", async () => {
    // q3 correcto requiere responder exactamente SECRETO_LIMA.
    const answers = [
      { questionId: q.q1 as string, answer: 1 }, // correcto
      { questionId: q.q2 as string, answer: true }, // correcto
      { questionId: q.q3 as string, answer: ` ${CORRECT_FILL.toLowerCase()} ` }, // correcto (trim+case)
      { questionId: q.q4 as string, answer: "brasil" }, // incorrecto
    ];
    const res = await submit(quizId, answers);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.score).toBe(30);
    expect(data.maxScore).toBe(40);
    expect(data.passed).toBe(true); // 75% ≥ 70%
    expect(data.perQuestion).toHaveLength(4);
    expect(
      data.perQuestion.map((p: { correct: boolean }) => p.correct),
    ).toEqual([true, true, true, false]);
    expect(data.xpEarned).toBe(20);
    expect(data.streak.current).toBe(1);
    // Aprobar el único quiz de la semana → first-lesson y week-complete.
    const codes = data.newBadges.map((b: { code: string }) => b.code);
    expect(codes).toContain("first-lesson");
    // masteryChanges: ambos topics pasan a attempted (from null).
    const changed = data.masteryChanges.map(
      (m: { topicId: string; to: string }) => m.to,
    );
    expect(changed).toEqual(["attempted", "attempted"]);
    // NO se filtra la respuesta correcta ni el answerSpec.
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("answerSpec");
    expect(raw).not.toContain("correctIndex");
    expect(raw).not.toContain(CORRECT_FILL);
  });

  test("persiste el QuizAttempt completo y el LessonProgress (aprobó)", async () => {
    const attempt = await db.quizAttempt.findFirst({
      where: { studentProfileId: studentId, lessonId: quizId },
      orderBy: { createdAt: "desc" },
    });
    expect(attempt?.score).toBe(30);
    expect(attempt?.maxScore).toBe(40);
    expect(Array.isArray(attempt?.answers)).toBe(true);
    expect((attempt?.answers as unknown[]).length).toBe(4);
    const progress = await db.lessonProgress.count({
      where: { studentProfileId: studentId, lessonId: quizId },
    });
    expect(progress).toBe(1);
    const passedXp = await db.xPEvent.count({
      where: {
        studentProfileId: studentId,
        reason: "quiz_passed",
        refId: quizId,
      },
    });
    expect(passedXp).toBe(1);
  });

  test("XP no farmeable: reaprobar no da XP de aprobado", async () => {
    const res = await submit(quizId, pass());
    expect(res.json().data.xpEarned).toBe(0);
  });

  test("intento fallido: +5 solo el primer fallo del día", async () => {
    const first = await submit(quizId, fail());
    expect(first.json().data.passed).toBe(false);
    expect(first.json().data.xpEarned).toBe(5);
    const second = await submit(quizId, fail());
    expect(second.json().data.xpEarned).toBe(0); // mismo día → no farmea
  });

  test("lección que no es quiz → VALIDATION_ERROR", async () => {
    // creamos una lección video en la misma semana
    const week = await db.week.findFirst({
      where: { lessons: { some: { id: quizId } } },
    });
    const video = await db.lesson.create({
      data: { weekId: week!.id, order: 99, type: "video" },
    });
    const res = await submit(video.id, []);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    await db.lesson.delete({ where: { id: video.id } });
  });
});
