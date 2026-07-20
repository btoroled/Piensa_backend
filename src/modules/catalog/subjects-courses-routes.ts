// CRUD de materias y cursos + prerrequisitos (ISSUE-37), bajo /api/v1/admin.
// Solo admin. Borrar en uso → CONFLICT; duplicados → CONFLICT; FK mala →
// VALIDATION_ERROR; ciclo de prereq → VALIDATION_ERROR.

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { isPrismaError, mapDeleteRestrict } from "../../lib/prisma-errors.js";
import { wouldCreatePrereqCycle } from "./courses.js";

export interface SubjectsCoursesRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const subjectBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
} as const;

const createCourseBodySchema = {
  type: "object",
  required: ["subjectId", "gradeId", "title"],
  additionalProperties: false,
  properties: {
    subjectId: { type: "string", pattern: UUID_PATTERN },
    gradeId: { type: "string", pattern: UUID_PATTERN },
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2000 },
  },
} as const;

const updateCourseBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2000 },
  },
} as const;

const coursesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    subjectId: { type: "string", pattern: UUID_PATTERN },
    gradeId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const prereqBodySchema = {
  type: "object",
  required: ["requiresCourseId"],
  additionalProperties: false,
  properties: { requiresCourseId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const prereqParamsSchema = {
  type: "object",
  required: ["id", "requiresCourseId"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    requiresCourseId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

interface IdParams {
  id: string;
}
interface SubjectBody {
  name: string;
}
interface CreateCourseBody {
  subjectId: string;
  gradeId: string;
  title: string;
  description?: string;
}
interface UpdateCourseBody {
  title?: string;
  description?: string;
}
interface CoursesQuery {
  subjectId?: string;
  gradeId?: string;
}
interface PrereqBody {
  requiresCourseId: string;
}
interface PrereqParams {
  id: string;
  requiresCourseId: string;
}

const subjectSelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;
const courseSelect = {
  id: true,
  subjectId: true,
  gradeId: true,
  title: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const subjectsCoursesRoutes: FastifyPluginAsync<
  SubjectsCoursesRoutesOptions
> = async (app, opts) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];

  // ── Materias ──────────────────────────────────────────────────────────────
  app.post<{ Body: SubjectBody }>(
    "/admin/subjects",
    { schema: { body: subjectBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      try {
        const subject = await prisma.subject.create({
          data: { name: request.body.name },
          select: subjectSelect,
        });
        reply.code(201);
        return { data: subject };
      } catch (err) {
        if (isPrismaError(err, "P2002"))
          throw new AppError(
            "CONFLICT",
            "Ya existe una materia con ese nombre.",
          );
        throw err;
      }
    },
  );

  app.get("/admin/subjects", { preHandler: adminOnly }, async () => ({
    data: await prisma.subject.findMany({
      select: subjectSelect,
      orderBy: { name: "asc" },
    }),
  }));

  app.get<{ Params: IdParams }>(
    "/admin/subjects/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const subject = await prisma.subject.findUnique({
        where: { id: request.params.id },
        select: subjectSelect,
      });
      if (!subject) throw new AppError("NOT_FOUND", "Materia no encontrada.");
      return { data: subject };
    },
  );

  app.patch<{ Params: IdParams; Body: SubjectBody }>(
    "/admin/subjects/:id",
    {
      schema: { params: idParamsSchema, body: subjectBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        const subject = await prisma.subject.update({
          where: { id: request.params.id },
          data: { name: request.body.name },
          select: subjectSelect,
        });
        return { data: subject };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Materia no encontrada.");
        if (isPrismaError(err, "P2002"))
          throw new AppError(
            "CONFLICT",
            "Ya existe una materia con ese nombre.",
          );
        throw err;
      }
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/subjects/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.subject.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Materia no encontrada.");
        mapDeleteRestrict(
          err,
          "No se puede borrar la materia: tiene cursos o inscripciones.",
        );
      }
    },
  );

  // ── Cursos ────────────────────────────────────────────────────────────────
  app.post<{ Body: CreateCourseBody }>(
    "/admin/courses",
    { schema: { body: createCourseBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      try {
        const course = await prisma.course.create({
          data: request.body,
          select: courseSelect,
        });
        reply.code(201);
        return { data: course };
      } catch (err) {
        if (isPrismaError(err, "P2002"))
          throw new AppError(
            "CONFLICT",
            "Ya existe un curso para esa materia y año.",
          );
        if (isPrismaError(err, "P2003"))
          throw new AppError(
            "VALIDATION_ERROR",
            "La materia o el año indicado no existe.",
          );
        throw err;
      }
    },
  );

  app.get<{ Querystring: CoursesQuery }>(
    "/admin/courses",
    { schema: { querystring: coursesQuerySchema }, preHandler: adminOnly },
    async (request) => ({
      data: await prisma.course.findMany({
        where: {
          ...(request.query.subjectId
            ? { subjectId: request.query.subjectId }
            : {}),
          ...(request.query.gradeId ? { gradeId: request.query.gradeId } : {}),
        },
        select: courseSelect,
        orderBy: [{ subjectId: "asc" }, { gradeId: "asc" }],
      }),
    }),
  );

  app.get<{ Params: IdParams }>(
    "/admin/courses/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const course = await prisma.course.findUnique({
        where: { id: request.params.id },
        select: courseSelect,
      });
      if (!course) throw new AppError("NOT_FOUND", "Curso no encontrado.");
      return { data: course };
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateCourseBody }>(
    "/admin/courses/:id",
    {
      schema: { params: idParamsSchema, body: updateCourseBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        // subjectId/gradeId inmutables: solo title/description.
        const course = await prisma.course.update({
          where: { id: request.params.id },
          data: {
            title: request.body.title,
            description: request.body.description,
          },
          select: courseSelect,
        });
        return { data: course };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Curso no encontrado.");
        throw err;
      }
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/courses/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.course.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Curso no encontrado.");
        mapDeleteRestrict(
          err,
          "No se puede borrar el curso: tiene semanas o es prerrequisito de otro.",
        );
      }
    },
  );

  // ── Prerrequisitos ──────────────────────────────────────────────────────
  const requiresOf = (courseId: string) =>
    prisma.coursePrerequisite
      .findMany({ where: { courseId }, select: { requiresCourseId: true } })
      .then((rows) => rows.map((r) => r.requiresCourseId));

  app.post<{ Params: IdParams; Body: PrereqBody }>(
    "/admin/courses/:id/prerequisites",
    {
      schema: { params: idParamsSchema, body: prereqBodySchema },
      preHandler: adminOnly,
    },
    async (request, reply) => {
      const { id: courseId } = request.params;
      const { requiresCourseId } = request.body;
      if (
        await wouldCreatePrereqCycle(requiresOf, courseId, requiresCourseId)
      ) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Ese prerrequisito crearía un ciclo.",
        );
      }
      try {
        await prisma.coursePrerequisite.create({
          data: { courseId, requiresCourseId },
        });
        reply.code(201);
      } catch (err) {
        if (isPrismaError(err, "P2002")) {
          reply.code(200); // ya era prerrequisito: idempotente.
        } else if (isPrismaError(err, "P2003")) {
          throw new AppError(
            "VALIDATION_ERROR",
            "El curso o el prerrequisito indicado no existe.",
          );
        } else {
          throw err;
        }
      }
      return { data: { courseId, requiresCourseId } };
    },
  );

  app.delete<{ Params: PrereqParams }>(
    "/admin/courses/:id/prerequisites/:requiresCourseId",
    { schema: { params: prereqParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const { id: courseId, requiresCourseId } = request.params;
      try {
        await prisma.coursePrerequisite.delete({
          where: { courseId_requiresCourseId: { courseId, requiresCourseId } },
        });
        return { data: { courseId, requiresCourseId, removed: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "El prerrequisito no existe.");
        throw err;
      }
    },
  );

  app.get<{ Params: IdParams }>(
    "/admin/courses/:id/prerequisites",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const rows = await prisma.coursePrerequisite.findMany({
        where: { courseId: request.params.id },
        select: { requires: { select: courseSelect } },
      });
      return { data: rows.map((r) => r.requires) };
    },
  );
};
