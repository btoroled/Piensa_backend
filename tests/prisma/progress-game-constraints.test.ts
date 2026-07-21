import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";

// Constraints del modelo de progreso y juego contra Postgres real (ISSUE-19):
// uniques, cascada desde el alumno y SetNull en XPEvent.courseId. Auto-salta sin
// BD; corre en CI.

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
    "[progress-game] BD no disponible: se saltan los tests (corren en CI).",
  );
afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});
const db = prisma as PrismaClient;
const level = () => Math.floor(Math.random() * 2_000_000_000);

describe.skipIf(!dbAvailable)("Progreso y juego — constraints", () => {
  const tag = `pg19-${randomUUID()}`;
  let userId: string;
  let famId: string;
  let studentId: string;
  let lessonId: string;
  let topicId: string;
  let subjectId: string;
  let gradeId: string;
  let courseId: string;

  beforeAll(async () => {
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
    const student = await db.studentProfile.create({
      data: { familyId: fam.id, name: "Ana", avatar: "fox", pinHash: "x" },
    });
    studentId = student.id;
    const subject = await db.subject.create({ data: { name: `S-${tag}` } });
    subjectId = subject.id;
    const grade = await db.grade.create({
      data: { name: `G-${tag}`, level: level() },
    });
    gradeId = grade.id;
    const course = await db.course.create({
      data: { subjectId: subject.id, gradeId: grade.id, title: "C" },
    });
    courseId = course.id;
    const week = await db.week.create({
      data: { courseId: course.id, number: 1, title: "S1" },
    });
    const lesson = await db.lesson.create({
      data: { weekId: week.id, order: 1, type: "quiz" },
    });
    lessonId = lesson.id;
    const topic = await db.topic.create({ data: { name: `T-${tag}` } });
    topicId = topic.id;
  });

  afterAll(async () => {
    // Borrar el alumno cascada su progreso; luego el catálogo.
    await db.studentProfile.deleteMany({ where: { familyId: famId } });
    await db.badge.deleteMany({ where: { code: { contains: tag } } });
    await db.lesson.deleteMany({ where: { id: lessonId } });
    await db.week.deleteMany({ where: { courseId } });
    await db.course.deleteMany({ where: { subjectId } });
    await db.topic.deleteMany({ where: { name: { contains: tag } } });
    await db.subject.deleteMany({ where: { id: subjectId } });
    await db.grade.deleteMany({ where: { id: gradeId } });
    await db.family.deleteMany({ where: { id: famId } });
    await db.user.deleteMany({ where: { id: userId } });
  });

  test("LessonProgress único por (alumno, lección) → P2002", async () => {
    const p = await db.lessonProgress.create({
      data: { studentProfileId: studentId, lessonId },
    });
    try {
      await expect(
        db.lessonProgress.create({
          data: { studentProfileId: studentId, lessonId },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    } finally {
      await db.lessonProgress.delete({ where: { id: p.id } });
    }
  });

  test("XPEvent idempotente por (alumno, reason, refId) → P2002", async () => {
    const e = await db.xPEvent.create({
      data: {
        studentProfileId: studentId,
        amount: 10,
        reason: "lesson_complete",
        refId: lessonId,
      },
    });
    try {
      await expect(
        db.xPEvent.create({
          data: {
            studentProfileId: studentId,
            amount: 10,
            reason: "lesson_complete",
            refId: lessonId,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    } finally {
      await db.xPEvent.delete({ where: { id: e.id } });
    }
  });

  test("Streak único por alumno; Badge.code, BadgeAward y TopicMastery únicos → P2002", async () => {
    const s = await db.streak.create({ data: { studentProfileId: studentId } });
    const badge = await db.badge.create({
      data: { code: `b-${tag}`, name: "B", description: "d", criteria: {} },
    });
    const award = await db.badgeAward.create({
      data: { studentProfileId: studentId, badgeId: badge.id },
    });
    const tm = await db.topicMastery.create({
      data: { studentProfileId: studentId, topicId, level: "attempted" },
    });
    try {
      await expect(
        db.streak.create({ data: { studentProfileId: studentId } }),
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        db.badge.create({
          data: { code: `b-${tag}`, name: "X", description: "d", criteria: {} },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        db.badgeAward.create({
          data: { studentProfileId: studentId, badgeId: badge.id },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        db.topicMastery.create({
          data: { studentProfileId: studentId, topicId, level: "familiar" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    } finally {
      await db.topicMastery.delete({ where: { id: tm.id } });
      await db.badgeAward.delete({ where: { id: award.id } });
      await db.badge.delete({ where: { id: badge.id } });
      await db.streak.delete({ where: { id: s.id } });
    }
  });

  test("borrar el alumno cascada todo su progreso", async () => {
    const fam2 = await db.family.create({
      data: { name: `F2-${tag}`, parentUserId: userId },
    });
    const st = await db.studentProfile.create({
      data: { familyId: fam2.id, name: "Beto", avatar: "cat", pinHash: "x" },
    });
    await db.lessonProgress.create({
      data: { studentProfileId: st.id, lessonId },
    });
    await db.xPEvent.create({
      data: {
        studentProfileId: st.id,
        amount: 5,
        reason: "quiz_attempt",
        refId: `${lessonId}:day`,
      },
    });
    await db.streak.create({ data: { studentProfileId: st.id } });

    await db.studentProfile.delete({ where: { id: st.id } });

    expect(
      await db.lessonProgress.count({ where: { studentProfileId: st.id } }),
    ).toBe(0);
    expect(await db.xPEvent.count({ where: { studentProfileId: st.id } })).toBe(
      0,
    );
    expect(await db.streak.count({ where: { studentProfileId: st.id } })).toBe(
      0,
    );
    await db.family.delete({ where: { id: fam2.id } });
  });

  test("borrar un Course deja el XPEvent con courseId null (SetNull, conserva el total)", async () => {
    // Curso fresco sin semanas (borrable).
    const subj = await db.subject.create({ data: { name: `S2-${tag}` } });
    const grd = await db.grade.create({
      data: { name: `G2-${tag}`, level: level() },
    });
    const crs = await db.course.create({
      data: { subjectId: subj.id, gradeId: grd.id, title: "C2" },
    });
    const e = await db.xPEvent.create({
      data: {
        studentProfileId: studentId,
        amount: 20,
        reason: "quiz_passed",
        refId: `q-${randomUUID()}`,
        courseId: crs.id,
      },
    });
    try {
      await db.course.delete({ where: { id: crs.id } });
      const after = await db.xPEvent.findUnique({ where: { id: e.id } });
      expect(after?.courseId).toBeNull();
      expect(after?.amount).toBe(20); // el evento (y su XP) sigue.
    } finally {
      await db.xPEvent.delete({ where: { id: e.id } });
      await db.course.deleteMany({ where: { id: crs.id } });
      await db.subject.delete({ where: { id: subj.id } });
      await db.grade.delete({ where: { id: grd.id } });
    }
  });
});
