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
  console.warn("[path] BD no disponible: se saltan los tests (corren en CI).");
const db = prisma as PrismaClient;
let app: FastifyInstance;

async function token(studentProfileId: string, familyId: string) {
  return createAccessToken(SECRET, {
    studentProfileId,
    role: "student",
    familyId,
  });
}
async function getPath(studentProfileId: string, familyId: string) {
  return app.inject({
    method: "GET",
    url: "/api/v1/me/path",
    headers: {
      authorization: `Bearer ${await token(studentProfileId, familyId)}`,
    },
  });
}

describe.skipIf(!dbAvailable)("GET /me/path", () => {
  const tag = `path20-${randomUUID()}`;
  let userId: string;
  let famId: string;
  let gradeId: string;
  let studentWithGrade: string;
  let studentNoGrade: string;
  // curso Matemáticas: semana 1 [mA1, mA2], semana 2 [mB1]
  const lessons: Record<string, string> = {};

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
    gradeId = grade.id;

    // Dos materias inscritas → dos cursos en el grado.
    const math = await db.subject.create({ data: { name: `Mate-${tag}` } });
    const sci = await db.subject.create({ data: { name: `Cien-${tag}` } });
    const mathCourse = await db.course.create({
      data: { subjectId: math.id, gradeId: grade.id, title: "Matemáticas" },
    });
    await db.course.create({
      data: { subjectId: sci.id, gradeId: grade.id, title: "Ciencias" },
    });
    const w1 = await db.week.create({
      data: { courseId: mathCourse.id, number: 1, title: "Semana 1" },
    });
    const w2 = await db.week.create({
      data: { courseId: mathCourse.id, number: 2, title: "Semana 2" },
    });
    lessons.mA1 = (
      await db.lesson.create({
        data: { weekId: w1.id, order: 1, type: "video" },
      })
    ).id;
    lessons.mA2 = (
      await db.lesson.create({
        data: { weekId: w1.id, order: 2, type: "video" },
      })
    ).id;
    lessons.mB1 = (
      await db.lesson.create({
        data: { weekId: w2.id, order: 1, type: "video" },
      })
    ).id;

    const withGrade = await db.studentProfile.create({
      data: {
        familyId: fam.id,
        name: "Ana",
        avatar: "fox",
        pinHash: "x",
        gradeId: grade.id,
        subjects: { create: [{ subjectId: math.id }, { subjectId: sci.id }] },
      },
    });
    studentWithGrade = withGrade.id;
    const noGrade = await db.studentProfile.create({
      data: { familyId: fam.id, name: "Beto", avatar: "cat", pinHash: "x" },
    });
    studentNoGrade = noGrade.id;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app.close();
    await db.lessonProgress.deleteMany({
      where: { studentProfileId: studentWithGrade },
    });
    await db.studentProfile.deleteMany({ where: { familyId: famId } });
    await db.lesson.deleteMany({
      where: { id: { in: Object.values(lessons) } },
    });
    await db.week.deleteMany({ where: { course: { gradeId } } });
    await db.course.deleteMany({ where: { gradeId } });
    await db.subject.deleteMany({ where: { name: { contains: tag } } });
    await db.grade.deleteMany({ where: { id: gradeId } });
    await db.family.deleteMany({ where: { id: famId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  test("alumno nuevo: agrupa por curso; solo la 1ª lección available", async () => {
    const res = await getPath(studentWithGrade, famId);
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.grade.id).toBe(gradeId);
    // 2 materias → 2 cursos, ordenados por nombre de materia (Cien antes que Mate)
    expect(data.courses).toHaveLength(2);
    const math = data.courses.find(
      (c: { title: string }) => c.title === "Matemáticas",
    );
    expect(math.weeks).toHaveLength(2);
    const [s1, s2] = math.weeks;
    expect(s1.lessons.map((l: { status: string }) => l.status)).toEqual([
      "available",
      "locked",
    ]);
    expect(s2.lessons.map((l: { status: string }) => l.status)).toEqual([
      "locked",
    ]);
  });

  test("al completar la semana 1, se abre la semana 2", async () => {
    await db.lessonProgress.createMany({
      data: [
        { studentProfileId: studentWithGrade, lessonId: lessons.mA1 as string },
        { studentProfileId: studentWithGrade, lessonId: lessons.mA2 as string },
      ],
    });
    const res = await getPath(studentWithGrade, famId);
    const { data } = res.json();
    const math = data.courses.find(
      (c: { title: string }) => c.title === "Matemáticas",
    );
    expect(
      math.weeks[0].lessons.map((l: { status: string }) => l.status),
    ).toEqual(["completed", "completed"]);
    expect(math.weeks[1].lessons[0].status).toBe("available");
  });

  test("sin grado asignado → 404 NOT_FOUND", async () => {
    const res = await getPath(studentNoGrade, famId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
