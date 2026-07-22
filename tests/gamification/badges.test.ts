import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import { evaluate, seedBadges } from "../../src/modules/gamification/badges.js";

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
    "[badges] BD no disponible: se saltan los tests (corren en CI).",
  );
afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});
const db = prisma as PrismaClient;

const codes = (badges: { code: string }[]) => badges.map((b) => b.code).sort();

describe.skipIf(!dbAvailable)("badges.evaluate", () => {
  const tag = `bd27-${randomUUID()}`;
  let userId: string;
  let famId: string;
  let lessonA: string;
  let lessonB: string;
  const brokenCodes = [`broken-${tag}`, `broken2-${tag}`];

  async function newStudent(): Promise<string> {
    const st = await db.studentProfile.create({
      data: { familyId: famId, name: "Ana", avatar: "fox", pinHash: "x" },
    });
    return st.id;
  }
  const completeLesson = (sid: string, lessonId: string) =>
    db.lessonProgress.create({ data: { studentProfileId: sid, lessonId } });

  beforeAll(async () => {
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
    const subj = await db.subject.create({ data: { name: `S-${tag}` } });
    const grade = await db.grade.create({
      data: { name: `G-${tag}`, level: Math.floor(Math.random() * 1e6) + 1 },
    });
    const course = await db.course.create({
      data: { subjectId: subj.id, gradeId: grade.id, title: "C" },
    });
    const week = await db.week.create({
      data: { courseId: course.id, number: 1, title: "S1" },
    });
    lessonA = (
      await db.lesson.create({
        data: { weekId: week.id, order: 1, type: "video" },
      })
    ).id;
    lessonB = (
      await db.lesson.create({
        data: { weekId: week.id, order: 2, type: "video" },
      })
    ).id;
    // Insignias con criterio malformado (no deben otorgarse nunca).
    await db.badge.create({
      data: {
        code: brokenCodes[0] as string,
        name: "Rota",
        description: "tipo desconocido",
        criteria: { type: "nope" },
      },
    });
    await db.badge.create({
      data: {
        code: brokenCodes[1] as string,
        name: "Rota2",
        description: "streak sin days",
        criteria: { type: "streak" },
      },
    });
  });

  afterAll(async () => {
    await db.studentProfile.deleteMany({ where: { familyId: famId } });
    await db.badge.deleteMany({ where: { code: { in: brokenCodes } } });
    await db.lesson.deleteMany({ where: { id: { in: [lessonA, lessonB] } } });
    await db.week.deleteMany({
      where: { title: "S1", course: { subject: { name: `S-${tag}` } } },
    });
    await db.course.deleteMany({ where: { subject: { name: `S-${tag}` } } });
    await db.subject.deleteMany({ where: { name: `S-${tag}` } });
    await db.grade.deleteMany({ where: { name: `G-${tag}` } });
    await db.family.deleteMany({ where: { id: famId } });
    await db.user.deleteMany({ where: { id: userId } });
  });

  test("first-lesson: se otorga tras la 1ª lección, una sola vez", async () => {
    const s = await newStudent();
    expect(await evaluate(db, s)).toEqual([]);
    await completeLesson(s, lessonA);
    const first = await evaluate(db, s);
    expect(codes(first)).toContain("first-lesson");
    // idempotente: segundo barrido no re-otorga
    const second = await evaluate(db, s);
    expect(codes(second)).not.toContain("first-lesson");
    expect(
      await db.badgeAward.count({
        where: { studentProfileId: s, badge: { code: "first-lesson" } },
      }),
    ).toBe(1);
  });

  test("week-complete: solo con todas las lecciones de la semana", async () => {
    const s = await newStudent();
    await completeLesson(s, lessonA);
    expect(codes(await evaluate(db, s))).not.toContain("week-complete");
    await completeLesson(s, lessonB);
    expect(codes(await evaluate(db, s))).toContain("week-complete");
  });

  test("perfect-quiz: solo con score == maxScore", async () => {
    const s = await newStudent();
    await db.quizAttempt.create({
      data: {
        studentProfileId: s,
        lessonId: lessonA,
        answers: {},
        score: 3,
        maxScore: 4,
      },
    });
    expect(codes(await evaluate(db, s))).not.toContain("perfect-quiz");
    await db.quizAttempt.create({
      data: {
        studentProfileId: s,
        lessonId: lessonA,
        answers: {},
        score: 4,
        maxScore: 4,
      },
    });
    expect(codes(await evaluate(db, s))).toContain("perfect-quiz");
  });

  test("streak-7 usa longest y es retroactiva; streak-30 no", async () => {
    const s = await newStudent();
    await db.streak.create({
      data: { studentProfileId: s, current: 6, longest: 6 },
    });
    expect(codes(await evaluate(db, s))).not.toContain("streak-7");
    // La racha histórica sube a 7 (aunque la insignia se evalúe después): retroactivo.
    await db.streak.update({
      where: { studentProfileId: s },
      data: { longest: 7 },
    });
    const awarded = codes(await evaluate(db, s));
    expect(awarded).toContain("streak-7");
    expect(awarded).not.toContain("streak-30");
  });

  test("criterio malformado no otorga ni revienta", async () => {
    const s = await newStudent();
    await db.streak.create({
      data: { studentProfileId: s, current: 100, longest: 100 },
    });
    const awarded = codes(await evaluate(db, s)); // longest 100 → streak-7 y streak-30 sí
    expect(awarded).toContain("streak-7");
    expect(awarded).not.toContain(brokenCodes[0]);
    expect(awarded).not.toContain(brokenCodes[1]);
  });
});
