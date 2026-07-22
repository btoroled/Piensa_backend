import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient, type Prisma } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

const SECRET = "integration-secret-at-least-16-chars";
const SECRET_ANSWER = "RESPUESTA_SECRETA_XYZ";

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
    "[lesson] BD no disponible: se saltan los tests (corren en CI).",
  );
const db = prisma as PrismaClient;
let app: FastifyInstance;

describe.skipIf(!dbAvailable)("GET /lessons/:id", () => {
  const tag = `les21-${randomUUID()}`;
  let userId: string;
  let famId: string;
  let studentId: string;
  let videoId: string; // semana 1, orden 1 (available)
  let quizId: string; // semana 1, orden 2 (locked hasta completar el video)
  let offPathLessonId: string; // materia no inscrita

  async function get(lessonId: string) {
    const token = await createAccessToken(SECRET, {
      studentProfileId: studentId,
      role: "student",
      familyId: famId,
    });
    return app.inject({
      method: "GET",
      url: `/api/v1/lessons/${lessonId}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  beforeAll(async () => {
    if (!dbAvailable) return;
    app = buildApp({ prisma: db, jwtSecret: SECRET });
    await app.ready();

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

    const math = await db.subject.create({ data: { name: `Mate-${tag}` } });
    const art = await db.subject.create({ data: { name: `Arte-${tag}` } });
    const mathCourse = await db.course.create({
      data: { subjectId: math.id, gradeId: grade.id, title: "Matemáticas" },
    });
    const artCourse = await db.course.create({
      data: { subjectId: art.id, gradeId: grade.id, title: "Arte" },
    });
    const w1 = await db.week.create({
      data: { courseId: mathCourse.id, number: 1, title: "Semana 1" },
    });
    videoId = (
      await db.lesson.create({
        data: {
          weekId: w1.id,
          order: 1,
          type: "video",
          embedUrl: "https://videos.test/x",
        },
      })
    ).id;
    const quiz = await db.lesson.create({
      data: { weekId: w1.id, order: 2, type: "quiz" },
    });
    quizId = quiz.id;
    await db.question.create({
      data: {
        lessonId: quiz.id,
        order: 1,
        type: "fill_blank",
        content: { prompt: "Capital del Perú" },
        answerSpec: {
          answer: SECRET_ANSWER,
        } as unknown as Prisma.InputJsonValue,
        points: 5,
      },
    });

    // Lección de una materia (Arte) en la que el alumno NO está inscrito.
    const wArt = await db.week.create({
      data: { courseId: artCourse.id, number: 1, title: "S1" },
    });
    offPathLessonId = (
      await db.lesson.create({
        data: { weekId: wArt.id, order: 1, type: "video" },
      })
    ).id;

    const st = await db.studentProfile.create({
      data: {
        familyId: fam.id,
        name: "Ana",
        avatar: "fox",
        pinHash: "x",
        gradeId: grade.id,
        subjects: { create: [{ subjectId: math.id }] }, // solo Mate
      },
    });
    studentId = st.id;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app.close();
    await db.lessonProgress.deleteMany({
      where: { studentProfileId: studentId },
    });
    await db.studentProfile.deleteMany({ where: { familyId: famId } });
    await db.question.deleteMany({ where: { lessonId: quizId } });
    await db.lesson.deleteMany({
      where: { id: { in: [videoId, quizId, offPathLessonId] } },
    });
    await db.week.deleteMany({
      where: { course: { subject: { name: { contains: tag } } } },
    });
    await db.course.deleteMany({
      where: { subject: { name: { contains: tag } } },
    });
    await db.subject.deleteMany({ where: { name: { contains: tag } } });
    await db.grade.deleteMany({ where: { name: `G-${tag}` } });
    await db.family.deleteMany({ where: { id: famId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  test("video desbloqueado → 200 con embedUrl", async () => {
    const res = await get(videoId);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.type).toBe("video");
    expect(data.embedUrl).toBe("https://videos.test/x");
    expect(data.status).toBe("available");
  });

  test("quiz bloqueado → 403 FORBIDDEN", async () => {
    const res = await get(quizId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("quiz desbloqueado → 200 con preguntas y SIN answerSpec en ningún nivel", async () => {
    await db.lessonProgress.create({
      data: { studentProfileId: studentId, lessonId: videoId },
    });
    const res = await get(quizId);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.questions).toHaveLength(1);
    expect(data.questions[0].content.prompt).toBe("Capital del Perú");
    // La garantía: nada de answerSpec ni del valor secreto en todo el JSON.
    const raw = JSON.stringify(res.json());
    expect(raw).not.toContain("answerSpec");
    expect(raw).not.toContain(SECRET_ANSWER);
  });

  test("lección fuera del path (materia no inscrita) → 403", async () => {
    const res = await get(offPathLessonId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("id inexistente → 404 NOT_FOUND", async () => {
    const res = await get(randomUUID());
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
