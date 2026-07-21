// Gestión de la inscripción del alumno (ISSUE-38), bajo /api/v1/admin/students.
// Solo admin: promover de año, inscribir/desinscribir materias (individual +
// bulk) y consultar los cursos accesibles ("para abajo").

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { isPrismaError } from "../../lib/prisma-errors.js";

export interface StudentsRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const subjectParamsSchema = {
  type: "object",
  required: ["id", "subjectId"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    subjectId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const updateStudentBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    avatar: { type: "string", minLength: 1, maxLength: 100 },
    gradeId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const enrollBodySchema = {
  type: "object",
  required: ["subjectId"],
  additionalProperties: false,
  properties: { subjectId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const setSubjectsBodySchema = {
  type: "object",
  required: ["subjectIds"],
  additionalProperties: false,
  properties: {
    subjectIds: {
      type: "array",
      maxItems: 50,
      uniqueItems: true,
      items: { type: "string", pattern: UUID_PATTERN },
    },
  },
} as const;

interface IdParams {
  id: string;
}
interface SubjectParams {
  id: string;
  subjectId: string;
}
interface UpdateStudentBody {
  name?: string;
  avatar?: string;
  gradeId?: string;
}
interface EnrollBody {
  subjectId: string;
}
interface SetSubjectsBody {
  subjectIds: string[];
}

const studentSelect = {
  id: true,
  familyId: true,
  name: true,
  avatar: true,
  gradeId: true,
} as const;
const subjectSelect = { id: true, name: true } as const;
const courseSelect = {
  id: true,
  subjectId: true,
  gradeId: true,
  title: true,
  description: true,
} as const;

export const studentsRoutes: FastifyPluginAsync<StudentsRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];

  const requireStudent = async (id: string) => {
    const s = await prisma.studentProfile.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!s) throw new AppError("NOT_FOUND", "Alumno no encontrado.");
  };

  app.get<{ Params: IdParams }>(
    "/admin/students/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const s = await prisma.studentProfile.findUnique({
        where: { id: request.params.id },
        select: {
          ...studentSelect,
          subjects: { select: { subject: { select: subjectSelect } } },
        },
      });
      if (!s) throw new AppError("NOT_FOUND", "Alumno no encontrado.");
      return { data: { ...s, subjects: s.subjects.map((x) => x.subject) } };
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateStudentBody }>(
    "/admin/students/:id",
    {
      schema: { params: idParamsSchema, body: updateStudentBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        const s = await prisma.studentProfile.update({
          where: { id: request.params.id },
          data: {
            name: request.body.name,
            avatar: request.body.avatar,
            gradeId: request.body.gradeId,
          },
          select: studentSelect,
        });
        return { data: s };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Alumno no encontrado.");
        if (isPrismaError(err, "P2003"))
          throw new AppError(
            "VALIDATION_ERROR",
            "El grado indicado no existe.",
          );
        throw err;
      }
    },
  );

  // ── Materias del alumno ─────────────────────────────────────────────────
  app.get<{ Params: IdParams }>(
    "/admin/students/:id/subjects",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      await requireStudent(request.params.id);
      const rows = await prisma.studentSubject.findMany({
        where: { studentProfileId: request.params.id },
        select: { subject: { select: subjectSelect } },
        orderBy: { subject: { name: "asc" } },
      });
      return { data: rows.map((r) => r.subject) };
    },
  );

  app.post<{ Params: IdParams; Body: EnrollBody }>(
    "/admin/students/:id/subjects",
    {
      schema: { params: idParamsSchema, body: enrollBodySchema },
      preHandler: adminOnly,
    },
    async (request, reply) => {
      await requireStudent(request.params.id); // NOT_FOUND si no existe
      try {
        await prisma.studentSubject.create({
          data: {
            studentProfileId: request.params.id,
            subjectId: request.body.subjectId,
          },
        });
        reply.code(201);
      } catch (err) {
        if (isPrismaError(err, "P2002")) {
          reply.code(200); // ya inscrita: idempotente
        } else if (isPrismaError(err, "P2003")) {
          throw new AppError("VALIDATION_ERROR", "La materia no existe.");
        } else {
          throw err;
        }
      }
      return {
        data: {
          studentProfileId: request.params.id,
          subjectId: request.body.subjectId,
        },
      };
    },
  );

  app.delete<{ Params: SubjectParams }>(
    "/admin/students/:id/subjects/:subjectId",
    { schema: { params: subjectParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.studentSubject.delete({
          where: {
            studentProfileId_subjectId: {
              studentProfileId: request.params.id,
              subjectId: request.params.subjectId,
            },
          },
        });
        return {
          data: {
            studentProfileId: request.params.id,
            subjectId: request.params.subjectId,
            removed: true,
          },
        };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "El alumno no tiene esa materia.");
        throw err;
      }
    },
  );

  app.put<{ Params: IdParams; Body: SetSubjectsBody }>(
    "/admin/students/:id/subjects",
    {
      schema: { params: idParamsSchema, body: setSubjectsBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      await requireStudent(request.params.id);
      const { subjectIds } = request.body;
      try {
        // Bulk atómico: reemplaza toda la inscripción.
        await prisma.$transaction([
          prisma.studentSubject.deleteMany({
            where: { studentProfileId: request.params.id },
          }),
          prisma.studentSubject.createMany({
            data: subjectIds.map((subjectId) => ({
              studentProfileId: request.params.id,
              subjectId,
            })),
          }),
        ]);
      } catch (err) {
        if (isPrismaError(err, "P2003"))
          throw new AppError(
            "VALIDATION_ERROR",
            "Alguna materia indicada no existe.",
          );
        throw err;
      }
      const rows = await prisma.studentSubject.findMany({
        where: { studentProfileId: request.params.id },
        select: { subject: { select: subjectSelect } },
        orderBy: { subject: { name: "asc" } },
      });
      return { data: rows.map((r) => r.subject) };
    },
  );

  // ── Cursos accesibles ("para abajo") ────────────────────────────────────
  app.get<{ Params: IdParams }>(
    "/admin/students/:id/courses",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const student = await prisma.studentProfile.findUnique({
        where: { id: request.params.id },
        select: {
          grade: { select: { level: true } },
          subjects: { select: { subjectId: true } },
        },
      });
      if (!student) throw new AppError("NOT_FOUND", "Alumno no encontrado.");
      const subjectIds = student.subjects.map((s) => s.subjectId);
      // Sin año asignado o sin materias → nada accesible todavía.
      if (!student.grade || subjectIds.length === 0) return { data: [] };
      const courses = await prisma.course.findMany({
        where: {
          subjectId: { in: subjectIds },
          grade: { level: { lte: student.grade.level } },
        },
        select: courseSelect,
        orderBy: [{ subjectId: "asc" }, { gradeId: "asc" }],
      });
      return { data: courses };
    },
  );
};
