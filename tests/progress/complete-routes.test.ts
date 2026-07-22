import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
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
  console.warn(
    "[complete] BD no disponible: se saltan los tests (corren en CI).",
  );
const db = prisma as PrismaClient;
let app: FastifyInstance;

describe.skipIf(!dbAvailable)("POST /lessons/:id/complete", () => {
  const tag = `cmp22-${randomUUID()}`;
  let userId: string;
  let famId: string;
  let studentId: string;
  let video1: string; // semana 1, orden 1 (available)
  let quizLesson: string; // semana 1, orden 3 (quiz)
  let lockedLesson: string; // semana 2 (locked)
  let offPath: string; // materia no inscrita

  async function complete(lessonId: string) {
    const token = await createAccessToken(SECRET, {
      studentProfileId: studentId,
      role: "student",
      familyId: famId,
    });
    return app.inject({
      method: "POST",
      url: `/api/v1/lessons/${lessonId}/complete`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

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
    const math = await db.subject.create({ data: { name: `Mate-${tag}` } });
    const art = await db.subject.create({ data: { name: `Arte-${tag}` } });
    const mathCourse = await db.course.create({
      data: { subjectId: math.id, gradeId: grade.id, title: "Matemáticas" },
    });
    const artCourse = await db.course.create({
      data: { subjectId: art.id, gradeId: grade.id, title: "Arte" },
    });
    const w1 = await db.week.create({
      data: { courseId: mathCourse.id, number: 1, title: "S1" },
    });
    const w2 = await db.week.create({
      data: { courseId: mathCourse.id, number: 2, title: "S2" },
    });
    video1 = (
      await db.lesson.create({
        data: { weekId: w1.id, order: 1, type: "video" },
      })
    ).id;
    quizLesson = (
      await db.lesson.create({
        data: { weekId: w1.id, order: 3, type: "quiz" },
      })
    ).id;
    lockedLesson = (
      await db.lesson.create({
        data: { weekId: w2.id, order: 1, type: "video" },
      })
    ).id;
    const wArt = await db.week.create({
      data: { courseId: artCourse.id, number: 1, title: "S1" },
    });
    offPath = (
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
    await db.studentProfile.deleteMany({ where: { familyId: famId } });
    await db.lesson.deleteMany({
      where: { id: { in: [video1, quizLesson, lockedLesson, offPath] } },
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

  test("primera completada → +10 XP, nivel 1, racha 1, insignia first-lesson", async () => {
    const res = await complete(video1);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.xpEarned).toBe(10);
    expect(data.totalXp).toBe(10);
    expect(data.level).toBe(1);
    expect(data.streak.current).toBe(1);
    expect(data.newBadges.map((b: { code: string }) => b.code)).toContain(
      "first-lesson",
    );
  });

  test("segunda completada (repaso) → xpEarned 0, sin nuevo XPEvent, misma respuesta", async () => {
    const res = await complete(video1);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.xpEarned).toBe(0);
    expect(data.totalXp).toBe(10); // sin cambio
    expect(data.newBadges).toEqual([]); // first-lesson ya otorgada
    // Racha sigue viva (repaso cuenta como actividad); mismo día → sin incremento.
    expect(data.streak.current).toBe(1);
    const events = await db.xPEvent.count({
      where: { studentProfileId: studentId, refId: video1 },
    });
    expect(events).toBe(1);
  });

  test("lección tipo quiz → 400 VALIDATION_ERROR", async () => {
    const res = await complete(quizLesson);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("lección bloqueada → 403 FORBIDDEN", async () => {
    const res = await complete(lockedLesson);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("lección fuera del path → 403 FORBIDDEN", async () => {
    const res = await complete(offPath);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
