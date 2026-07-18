import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";

// Constraints del catálogo contra una BD PostgreSQL real (Spec §4, ISSUE-12).
// Auto-salta sin Postgres (nada de verde fabricado); corre en CI (ISSUE-04),
// que es la evidencia real de los criterios de aceptación.

function makeClient(): PrismaClient | null {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "") {
    return null;
  }
  try {
    return new PrismaClient();
  } catch {
    return null;
  }
}

async function probe(client: PrismaClient | null): Promise<boolean> {
  if (!client) return false;
  try {
    await client.$queryRawUnsafe("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const prisma = makeClient();
const dbAvailable = await probe(prisma);

if (!dbAvailable) {
  console.warn(
    "[catalog-constraints] BD no disponible en DATABASE_URL: se saltan los tests (corren en CI).",
  );
}

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});

const client = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("Catálogo — constraints contra BD", () => {
  test("order duplicado de lecciones en la misma semana falla (único por semana)", async () => {
    const grade = await client.grade.create({
      data: { name: `Grado ${randomUUID()}` },
    });
    const week = await client.week.create({
      data: { gradeId: grade.id, number: 1, title: "Semana 1" },
    });
    const first = await client.lesson.create({
      data: { weekId: week.id, order: 1, type: "video" },
    });
    try {
      await expect(
        client.lesson.create({
          data: { weekId: week.id, order: 1, type: "reading" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    } finally {
      await client.lesson.delete({ where: { id: first.id } });
      await client.week.delete({ where: { id: week.id } });
      await client.grade.delete({ where: { id: grade.id } });
    }
  });

  test("order duplicado de preguntas en la misma lección falla (único por lección)", async () => {
    const grade = await client.grade.create({
      data: { name: `Grado ${randomUUID()}` },
    });
    const week = await client.week.create({
      data: { gradeId: grade.id, number: 1, title: "Semana 1" },
    });
    const lesson = await client.lesson.create({
      data: { weekId: week.id, order: 1, type: "quiz" },
    });
    const first = await client.question.create({
      data: {
        lessonId: lesson.id,
        order: 1,
        type: "true_false",
        content: {},
        answerSpec: {},
      },
    });
    try {
      await expect(
        client.question.create({
          data: {
            lessonId: lesson.id,
            order: 1,
            type: "true_false",
            content: {},
            answerSpec: {},
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    } finally {
      await client.question.delete({ where: { id: first.id } });
      await client.lesson.delete({ where: { id: lesson.id } });
      await client.week.delete({ where: { id: week.id } });
      await client.grade.delete({ where: { id: grade.id } });
    }
  });

  test("borrar un Grade con Weeks falla (FK Restrict, sin cascada)", async () => {
    const grade = await client.grade.create({
      data: { name: `Grado ${randomUUID()}` },
    });
    const week = await client.week.create({
      data: { gradeId: grade.id, number: 1, title: "Semana 1" },
    });
    try {
      await expect(
        client.grade.delete({ where: { id: grade.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
    } finally {
      await client.week.delete({ where: { id: week.id } });
      await client.grade.delete({ where: { id: grade.id } });
    }
  });

  test("borrar una Lesson con Questions falla (FK Restrict)", async () => {
    const grade = await client.grade.create({
      data: { name: `Grado ${randomUUID()}` },
    });
    const week = await client.week.create({
      data: { gradeId: grade.id, number: 1, title: "Semana 1" },
    });
    const lesson = await client.lesson.create({
      data: { weekId: week.id, order: 1, type: "quiz" },
    });
    const question = await client.question.create({
      data: {
        lessonId: lesson.id,
        order: 1,
        type: "true_false",
        content: {},
        answerSpec: {},
      },
    });
    try {
      await expect(
        client.lesson.delete({ where: { id: lesson.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
    } finally {
      await client.question.delete({ where: { id: question.id } });
      await client.lesson.delete({ where: { id: lesson.id } });
      await client.week.delete({ where: { id: week.id } });
      await client.grade.delete({ where: { id: grade.id } });
    }
  });

  test("borrar un Topic etiquetado en una lección falla (FK Restrict, ISSUE-16)", async () => {
    const grade = await client.grade.create({
      data: { name: `Grado ${randomUUID()}` },
    });
    const week = await client.week.create({
      data: { gradeId: grade.id, number: 1, title: "Semana 1" },
    });
    const lesson = await client.lesson.create({
      data: { weekId: week.id, order: 1, type: "video" },
    });
    const topic = await client.topic.create({
      data: { name: `Fracciones ${randomUUID()}` },
    });
    await client.lessonTopic.create({
      data: { lessonId: lesson.id, topicId: topic.id },
    });
    try {
      await expect(
        client.topic.delete({ where: { id: topic.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
    } finally {
      await client.lessonTopic.delete({
        where: { lessonId_topicId: { lessonId: lesson.id, topicId: topic.id } },
      });
      await client.topic.delete({ where: { id: topic.id } });
      await client.lesson.delete({ where: { id: lesson.id } });
      await client.week.delete({ where: { id: week.id } });
      await client.grade.delete({ where: { id: grade.id } });
    }
  });

  test("borrar una Lesson con tags borra sus links pero no el Topic (Cascade→link, Restrict→topic)", async () => {
    const grade = await client.grade.create({
      data: { name: `Grado ${randomUUID()}` },
    });
    const week = await client.week.create({
      data: { gradeId: grade.id, number: 1, title: "Semana 1" },
    });
    const lesson = await client.lesson.create({
      data: { weekId: week.id, order: 1, type: "video" },
    });
    const topic = await client.topic.create({
      data: { name: `Álgebra ${randomUUID()}` },
    });
    await client.lessonTopic.create({
      data: { lessonId: lesson.id, topicId: topic.id },
    });
    try {
      // Borrar la lección (sin questions) arrastra su link de topic (Cascade)...
      await client.lesson.delete({ where: { id: lesson.id } });
      const links = await client.lessonTopic.findMany({
        where: { topicId: topic.id },
      });
      expect(links).toHaveLength(0);
      // ...pero el Topic sigue vivo.
      const stillThere = await client.topic.findUnique({
        where: { id: topic.id },
      });
      expect(stillThere).not.toBeNull();
    } finally {
      await client.topic.delete({ where: { id: topic.id } });
      await client.week.delete({ where: { id: week.id } });
      await client.grade.delete({ where: { id: grade.id } });
    }
  });
});
