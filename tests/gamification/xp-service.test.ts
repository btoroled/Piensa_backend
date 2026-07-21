import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  append,
  getTotal,
  getCourseTotals,
} from "../../src/modules/gamification/xp.js";

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
  console.warn("[xp] BD no disponible: se saltan los tests (corren en CI).");
afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("xp service", () => {
  const tag = `xp25-${randomUUID()}`;
  let studentId: string;
  let famId: string;
  let userId: string;
  let courseA: string;
  let courseB: string;

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
    const st = await db.studentProfile.create({
      data: { familyId: fam.id, name: "Ana", avatar: "fox", pinHash: "x" },
    });
    studentId = st.id;
    const subj = await db.subject.create({ data: { name: `S-${tag}` } });
    const lvl = () => Math.floor(Math.random() * 1_000_000) + 1;
    const g1 = await db.grade.create({
      data: { name: `G1-${tag}`, level: lvl() },
    });
    const g2 = await db.grade.create({
      data: { name: `G2-${tag}`, level: lvl() },
    });
    courseA = (
      await db.course.create({
        data: { subjectId: subj.id, gradeId: g1.id, title: "A" },
      })
    ).id;
    courseB = (
      await db.course.create({
        data: { subjectId: subj.id, gradeId: g2.id, title: "B" },
      })
    ).id;
  });

  afterAll(async () => {
    await db.studentProfile.deleteMany({ where: { familyId: famId } });
    await db.course.deleteMany({ where: { id: { in: [courseA, courseB] } } });
    await db.subject.deleteMany({ where: { name: { contains: tag } } });
    await db.grade.deleteMany({ where: { name: { contains: tag } } });
    await db.family.deleteMany({ where: { id: famId } });
    await db.user.deleteMany({ where: { id: userId } });
  });

  test("append idempotente por (reason, refId): mismo par → un evento", async () => {
    const ref = `l-${randomUUID()}`;
    const first = await append(db, studentId, 10, "lesson_complete", ref);
    expect(first.created).toBe(true);
    const second = await append(db, studentId, 10, "lesson_complete", ref);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    const count = await db.xPEvent.count({
      where: {
        studentProfileId: studentId,
        reason: "lesson_complete",
        refId: ref,
      },
    });
    expect(count).toBe(1);
  });

  test("getTotal suma todos los eventos del alumno", async () => {
    await append(
      db,
      studentId,
      20,
      "quiz_passed",
      `q-${randomUUID()}`,
      courseA,
    );
    await append(
      db,
      studentId,
      5,
      "quiz_attempt",
      `a-${randomUUID()}`,
      courseB,
    );
    const total = await getTotal(db, studentId);
    expect(total).toBe(35); // 10 + 20 + 5
  });

  test("getCourseTotals agrega por curso; los sin curso no cuentan", async () => {
    const totals = await getCourseTotals(db, studentId);
    expect(totals[courseA]).toBe(20);
    expect(totals[courseB]).toBe(5);
    // el evento lesson_complete (sin courseId) no aparece
    expect(Object.keys(totals)).toHaveLength(2);
  });

  test("append rechaza amount ≤ 0", async () => {
    await expect(
      append(db, studentId, 0, "lesson_complete", `bad-${randomUUID()}`),
    ).rejects.toThrow();
  });
});
