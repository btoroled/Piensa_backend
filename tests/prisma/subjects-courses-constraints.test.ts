import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";

// Constraints de materias/cursos/prerrequisitos/inscripción contra Postgres real
// (Milestone 2.5, ISSUE-36). Auto-salta sin BD; corre en CI.

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
    "[subjects-courses] BD no disponible: se saltan los tests (corren en CI).",
  );

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});

const db = prisma as PrismaClient;
const level = () => Math.floor(Math.random() * 2_000_000_000);

describe.skipIf(!dbAvailable)(
  "Materias/cursos/inscripción — constraints",
  () => {
    test("Subject.name único → P2002", async () => {
      const name = `Mat-${randomUUID()}`;
      const s = await db.subject.create({ data: { name } });
      try {
        await expect(
          db.subject.create({ data: { name } }),
        ).rejects.toMatchObject({
          code: "P2002",
        });
      } finally {
        await db.subject.delete({ where: { id: s.id } });
      }
    });

    test("Course único por (materia, año) → P2002", async () => {
      const subject = await db.subject.create({
        data: { name: `S-${randomUUID()}` },
      });
      const grade = await db.grade.create({
        data: { name: `G-${randomUUID()}`, level: level() },
      });
      const first = await db.course.create({
        data: { subjectId: subject.id, gradeId: grade.id, title: "C1" },
      });
      try {
        await expect(
          db.course.create({
            data: { subjectId: subject.id, gradeId: grade.id, title: "C2" },
          }),
        ).rejects.toMatchObject({ code: "P2002" });
      } finally {
        await db.course.delete({ where: { id: first.id } });
        await db.subject.delete({ where: { id: subject.id } });
        await db.grade.delete({ where: { id: grade.id } });
      }
    });

    test("borrar una Subject con cursos → P2003 (Restrict)", async () => {
      const subject = await db.subject.create({
        data: { name: `S-${randomUUID()}` },
      });
      const grade = await db.grade.create({
        data: { name: `G-${randomUUID()}`, level: level() },
      });
      const course = await db.course.create({
        data: { subjectId: subject.id, gradeId: grade.id, title: "C" },
      });
      try {
        await expect(
          db.subject.delete({ where: { id: subject.id } }),
        ).rejects.toMatchObject({ code: "P2003" });
      } finally {
        await db.course.delete({ where: { id: course.id } });
        await db.subject.delete({ where: { id: subject.id } });
        await db.grade.delete({ where: { id: grade.id } });
      }
    });

    test("prereq: borrar el curso requerido → P2003; borrar el dueño arrastra la arista", async () => {
      const subject = await db.subject.create({
        data: { name: `S-${randomUUID()}` },
      });
      const g3 = await db.grade.create({
        data: { name: `G3-${randomUUID()}`, level: level() },
      });
      const g4 = await db.grade.create({
        data: { name: `G4-${randomUUID()}`, level: level() },
      });
      const mat3 = await db.course.create({
        data: { subjectId: subject.id, gradeId: g3.id, title: "Mat 3" },
      });
      const mat4 = await db.course.create({
        data: { subjectId: subject.id, gradeId: g4.id, title: "Mat 4" },
      });
      // Mat 4 requiere Mat 3.
      await db.coursePrerequisite.create({
        data: { courseId: mat4.id, requiresCourseId: mat3.id },
      });
      try {
        // No se puede borrar Mat 3: Mat 4 lo requiere (Restrict).
        await expect(
          db.course.delete({ where: { id: mat3.id } }),
        ).rejects.toMatchObject({ code: "P2003" });
        // Borrar Mat 4 (dueño de la arista) arrastra su prerrequisito (Cascade).
        await db.course.delete({ where: { id: mat4.id } });
        const edges = await db.coursePrerequisite.findMany({
          where: { requiresCourseId: mat3.id },
        });
        expect(edges).toHaveLength(0);
        // Mat 3 sigue vivo.
        expect(
          await db.course.findUnique({ where: { id: mat3.id } }),
        ).not.toBeNull();
      } finally {
        await db.coursePrerequisite.deleteMany({
          where: { requiresCourseId: mat3.id },
        });
        await db.course.deleteMany({
          where: { id: { in: [mat3.id, mat4.id] } },
        });
        await db.subject.delete({ where: { id: subject.id } });
        await db.grade.deleteMany({ where: { id: { in: [g3.id, g4.id] } } });
      }
    });

    test("inscripción: única por (alumno, materia); borrar el alumno cascada sus inscripciones", async () => {
      const subject = await db.subject.create({
        data: { name: `S-${randomUUID()}` },
      });
      const user = await db.user.create({
        data: {
          email: `p-${randomUUID()}@piensa.test`,
          passwordHash: "x",
          role: "parent",
        },
      });
      const fam = await db.family.create({
        data: { name: `F-${randomUUID()}`, parentUserId: user.id },
      });
      const student = await db.studentProfile.create({
        data: { familyId: fam.id, name: "Ana", avatar: "fox", pinHash: "x" },
      });
      await db.studentSubject.create({
        data: { studentProfileId: student.id, subjectId: subject.id },
      });
      try {
        // Duplicar la inscripción → P2002 (PK compuesta).
        await expect(
          db.studentSubject.create({
            data: { studentProfileId: student.id, subjectId: subject.id },
          }),
        ).rejects.toMatchObject({ code: "P2002" });
        // Borrar el alumno arrastra su inscripción (Cascade).
        await db.studentProfile.delete({ where: { id: student.id } });
        const left = await db.studentSubject.findMany({
          where: { subjectId: subject.id },
        });
        expect(left).toHaveLength(0);
      } finally {
        await db.studentSubject.deleteMany({
          where: { subjectId: subject.id },
        });
        await db.studentProfile.deleteMany({ where: { id: student.id } });
        await db.family.delete({ where: { id: fam.id } });
        await db.user.delete({ where: { id: user.id } });
        await db.subject.delete({ where: { id: subject.id } });
      }
    });
  },
);
