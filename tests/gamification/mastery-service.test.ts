import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";
import { recalculate } from "../../src/modules/gamification/mastery.js";

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
    "[mastery] BD no disponible: se saltan los tests (corren en CI).",
  );
afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("mastery.recalculate", () => {
  const tag = `ms28-${randomUUID()}`;
  let userId: string;
  let famId: string;
  let studentId: string;
  let lessonId: string;
  const topicIds: Record<string, string> = {};
  let order = 0;

  async function newTopic(key: string): Promise<string> {
    const t = await db.topic.create({ data: { name: `${key}-${tag}` } });
    topicIds[key] = t.id;
    return t.id;
  }
  async function newQuestion(topicId: string): Promise<string> {
    const q = await db.question.create({
      data: {
        lessonId,
        order: ++order,
        type: "fill_blank",
        content: {},
        answerSpec: {},
        points: 1,
        topics: { create: { topicId } },
      },
    });
    return q.id;
  }
  function attempt(
    responses: { questionId: string; correct: boolean }[],
    createdAt?: Date,
  ) {
    return db.quizAttempt.create({
      data: {
        studentProfileId: studentId,
        lessonId,
        answers: responses as unknown as Prisma.InputJsonValue,
        score: 0,
        maxScore: 0,
        ...(createdAt ? { createdAt } : {}),
      },
    });
  }

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
    const grade = await db.grade.create({
      data: { name: `G-${tag}`, level: Math.floor(Math.random() * 1e6) + 1 },
    });
    const course = await db.course.create({
      data: { subjectId: subj.id, gradeId: grade.id, title: "C" },
    });
    const week = await db.week.create({
      data: { courseId: course.id, number: 1, title: "S1" },
    });
    lessonId = (
      await db.lesson.create({
        data: { weekId: week.id, order: 1, type: "quiz" },
      })
    ).id;
  });

  afterAll(async () => {
    await db.studentProfile.deleteMany({ where: { familyId: famId } });
    await db.question.deleteMany({ where: { lessonId } });
    await db.lesson.deleteMany({ where: { id: lessonId } });
    await db.week.deleteMany({
      where: { course: { subject: { name: `S-${tag}` } } },
    });
    await db.course.deleteMany({ where: { subject: { name: `S-${tag}` } } });
    await db.subject.deleteMany({ where: { name: `S-${tag}` } });
    await db.grade.deleteMany({ where: { name: `G-${tag}` } });
    await db.topic.deleteMany({ where: { name: { contains: tag } } });
    await db.family.deleteMany({ where: { id: famId } });
    await db.user.deleteMany({ where: { id: userId } });
  });

  test("un quiz con preguntas de 3 topics actualiza los 3", async () => {
    const t1 = await newTopic("t1");
    const t2 = await newTopic("t2");
    const t3 = await newTopic("t3");
    const q1 = await newQuestion(t1);
    const q2 = await newQuestion(t2);
    const q3 = await newQuestion(t3);
    await attempt([
      { questionId: q1, correct: true },
      { questionId: q2, correct: true },
      { questionId: q3, correct: false },
    ]);

    const updated = await recalculate(db, studentId, [t1, t2, t3]);
    expect(updated).toHaveLength(3);
    const rows = await db.topicMastery.findMany({
      where: { studentProfileId: studentId, topicId: { in: [t1, t2, t3] } },
    });
    // 1 respuesta cada uno → attempted en los tres
    expect(rows.map((r) => r.level).sort()).toEqual([
      "attempted",
      "attempted",
      "attempted",
    ]);
  });

  test("el nivel baja si el desempeño reciente cae", async () => {
    const td = await newTopic("td");
    const qs = await Promise.all([
      newQuestion(td),
      newQuestion(td),
      newQuestion(td),
      newQuestion(td),
      newQuestion(td),
    ]);
    // Intento con 5 respuestas correctas → familiar (5/5, ≥5).
    await attempt(qs.map((q) => ({ questionId: q, correct: true })));
    let m = await recalculate(db, studentId, [td]);
    expect(m[0]?.level).toBe("familiar");

    // Intento reciente con las 5 mal → ventana 10 resp, 5 aciertos = 50% → attempted.
    await attempt(qs.map((q) => ({ questionId: q, correct: false })));
    m = await recalculate(db, studentId, [td]);
    expect(m[0]?.level).toBe("attempted");
  });

  test("solo cuentan los últimos MASTERY_WINDOW intentos", async () => {
    const tw = await newTopic("tw");
    const qw = await newQuestion(tw);
    const base = Date.parse("2026-05-01T00:00:00Z");
    // 10 intentos viejos, todos mal.
    for (let i = 0; i < 10; i++)
      await attempt(
        [{ questionId: qw, correct: false }],
        new Date(base + i * 60_000),
      );
    // 10 intentos nuevos, todos bien.
    for (let i = 0; i < 10; i++)
      await attempt(
        [{ questionId: qw, correct: true }],
        new Date(base + (100 + i) * 60_000),
      );

    // Ventana = 10 más recientes (todos correctos) → 10/10 → proficient.
    // Si contara los 20, sería 10/20 = 50% → attempted.
    const m = await recalculate(db, studentId, [tw]);
    expect(m[0]?.level).toBe("proficient");
  });

  test("answers malformado no revienta ni otorga nivel", async () => {
    const tb = await newTopic("tb");
    const qb = await newQuestion(tb);
    // answers no es el array esperado.
    await attempt([{ questionId: qb, correct: true }]); // válido → attempted
    await db.quizAttempt.create({
      data: {
        studentProfileId: studentId,
        lessonId,
        answers: { garbage: true } as unknown as Prisma.InputJsonValue,
        score: 0,
        maxScore: 0,
      },
    });
    const m = await recalculate(db, studentId, [tb]);
    expect(m[0]?.level).toBe("attempted"); // el malformado se ignoró, no rompió
  });
});
