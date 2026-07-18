// CRUD de catálogo para el admin (ISSUE-13), bajo /api/v1/admin. Solo admin
// (super_admin hereda). El borrado con dependientes lo bloquean las FK Restrict
// (ISSUE-12) → CONFLICT vía mapDeleteRestrict.

import type { FastifyPluginAsync } from "fastify";
import type { LessonType, Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { isPrismaError, mapDeleteRestrict } from "../../lib/prisma-errors.js";
import { assertValidLessonPayload, reorderLessons } from "./lessons.js";
import { assertLessonAcceptsQuestions } from "./questions.js";
import { assertValidQuestion } from "./question-types.js";

export interface CatalogRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const createGradeBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
} as const;

const updateGradeBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
} as const;

interface IdParams {
  id: string;
}
interface GradeBody {
  name: string;
}

const gradeSelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

const createWeekBodySchema = {
  type: "object",
  required: ["gradeId", "number", "title"],
  additionalProperties: false,
  properties: {
    gradeId: { type: "string", pattern: UUID_PATTERN },
    number: { type: "integer", minimum: 1, maximum: 1000 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2000 },
  },
} as const;

const updateWeekBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    number: { type: "integer", minimum: 1, maximum: 1000 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2000 },
  },
} as const;

const weeksQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { gradeId: { type: "string", pattern: UUID_PATTERN } },
} as const;

interface CreateWeekBody {
  gradeId: string;
  number: number;
  title: string;
  description?: string;
}
interface UpdateWeekBody {
  number?: number;
  title?: string;
  description?: string;
}
interface WeeksQuery {
  gradeId?: string;
}

const weekSelect = {
  id: true,
  gradeId: true,
  number: true,
  title: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const;

const lessonContentProps = {
  embedUrl: { type: "string", maxLength: 2000, pattern: "^https://[^\\s]+$" },
  richContent: { type: "string", maxLength: 100000 },
  fileKey: { type: "string", maxLength: 500 },
} as const;

const createLessonBodySchema = {
  type: "object",
  required: ["weekId", "type"],
  additionalProperties: false,
  properties: {
    weekId: { type: "string", pattern: UUID_PATTERN },
    type: { type: "string", enum: ["video", "reading", "quiz"] },
    ...lessonContentProps,
  },
} as const;

const updateLessonBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: { ...lessonContentProps },
} as const;

const lessonsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { weekId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const reorderBodySchema = {
  type: "object",
  required: ["weekId", "orderedIds"],
  additionalProperties: false,
  properties: {
    weekId: { type: "string", pattern: UUID_PATTERN },
    orderedIds: {
      type: "array",
      minItems: 1,
      maxItems: 1000,
      uniqueItems: true,
      items: { type: "string", pattern: UUID_PATTERN },
    },
  },
} as const;

interface CreateLessonBody {
  weekId: string;
  type: LessonType;
  embedUrl?: string;
  richContent?: string;
  fileKey?: string;
}
interface UpdateLessonBody {
  embedUrl?: string;
  richContent?: string;
  fileKey?: string;
}
interface LessonsQuery {
  weekId?: string;
}
interface ReorderBody {
  weekId: string;
  orderedIds: string[];
}

const lessonSelect = {
  id: true,
  weekId: true,
  order: true,
  type: true,
  embedUrl: true,
  richContent: true,
  fileKey: true,
  createdAt: true,
  updatedAt: true,
} as const;

const createQuestionBodySchema = {
  type: "object",
  required: ["lessonId", "type", "content", "answerSpec"],
  additionalProperties: false,
  properties: {
    lessonId: { type: "string", pattern: UUID_PATTERN },
    type: { type: "string", minLength: 1, maxLength: 50 },
    content: { type: "object" },
    answerSpec: { type: "object" },
    points: { type: "integer", minimum: 1, maximum: 1000 },
  },
} as const;

const updateQuestionBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    content: { type: "object" },
    answerSpec: { type: "object" },
    points: { type: "integer", minimum: 1, maximum: 1000 },
  },
} as const;

const questionsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { lessonId: { type: "string", pattern: UUID_PATTERN } },
} as const;

interface CreateQuestionBody {
  lessonId: string;
  type: string;
  content: Prisma.InputJsonValue;
  answerSpec: Prisma.InputJsonValue;
  points?: number;
}
interface UpdateQuestionBody {
  content?: Prisma.InputJsonValue;
  answerSpec?: Prisma.InputJsonValue;
  points?: number;
}
interface QuestionsQuery {
  lessonId?: string;
}

const questionSelect = {
  id: true,
  lessonId: true,
  order: true,
  type: true,
  content: true,
  answerSpec: true,
  points: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const catalogRoutes: FastifyPluginAsync<CatalogRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];

  // ── Grados ────────────────────────────────────────────────────────────────
  app.post<{ Body: GradeBody }>(
    "/admin/grades",
    { schema: { body: createGradeBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      const grade = await prisma.grade.create({
        data: { name: request.body.name },
        select: gradeSelect,
      });
      reply.code(201);
      return { data: grade };
    },
  );

  app.get("/admin/grades", { preHandler: adminOnly }, async () => ({
    data: await prisma.grade.findMany({
      select: gradeSelect,
      orderBy: { createdAt: "asc" },
    }),
  }));

  app.get<{ Params: IdParams }>(
    "/admin/grades/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const grade = await prisma.grade.findUnique({
        where: { id: request.params.id },
        select: gradeSelect,
      });
      if (!grade) throw new AppError("NOT_FOUND", "Grado no encontrado.");
      return { data: grade };
    },
  );

  app.patch<{ Params: IdParams; Body: GradeBody }>(
    "/admin/grades/:id",
    {
      schema: { params: idParamsSchema, body: updateGradeBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        const grade = await prisma.grade.update({
          where: { id: request.params.id },
          data: { name: request.body.name },
          select: gradeSelect,
        });
        return { data: grade };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Grado no encontrado.");
        throw err;
      }
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/grades/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.grade.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Grado no encontrado.");
        // Semanas colgando o alumnos asignados (FK Restrict) → CONFLICT.
        mapDeleteRestrict(
          err,
          "No se puede borrar el grado: tiene semanas o alumnos asociados.",
        );
      }
    },
  );

  // ── Semanas ─────────────────────────────────────────────────────────────
  app.post<{ Body: CreateWeekBody }>(
    "/admin/weeks",
    { schema: { body: createWeekBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      try {
        const week = await prisma.week.create({
          data: request.body,
          select: weekSelect,
        });
        reply.code(201);
        return { data: week };
      } catch (err) {
        if (isPrismaError(err, "P2003"))
          throw new AppError(
            "VALIDATION_ERROR",
            "El grado indicado no existe.",
          );
        if (isPrismaError(err, "P2002"))
          throw new AppError(
            "CONFLICT",
            "Ya existe una semana con ese número en el grado.",
          );
        throw err;
      }
    },
  );

  app.get<{ Querystring: WeeksQuery }>(
    "/admin/weeks",
    { schema: { querystring: weeksQuerySchema }, preHandler: adminOnly },
    async (request) => ({
      data: await prisma.week.findMany({
        where: request.query.gradeId ? { gradeId: request.query.gradeId } : {},
        select: weekSelect,
        orderBy: [{ gradeId: "asc" }, { number: "asc" }],
      }),
    }),
  );

  app.get<{ Params: IdParams }>(
    "/admin/weeks/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const week = await prisma.week.findUnique({
        where: { id: request.params.id },
        select: weekSelect,
      });
      if (!week) throw new AppError("NOT_FOUND", "Semana no encontrada.");
      return { data: week };
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateWeekBody }>(
    "/admin/weeks/:id",
    {
      schema: { params: idParamsSchema, body: updateWeekBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        const week = await prisma.week.update({
          where: { id: request.params.id },
          data: request.body,
          select: weekSelect,
        });
        return { data: week };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Semana no encontrada.");
        if (isPrismaError(err, "P2002"))
          throw new AppError(
            "CONFLICT",
            "Ya existe una semana con ese número en el grado.",
          );
        throw err;
      }
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/weeks/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.week.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Semana no encontrada.");
        mapDeleteRestrict(
          err,
          "No se puede borrar la semana: tiene lecciones asociadas.",
        );
      }
    },
  );

  // ── Lecciones ─────────────────────────────────────────────────────────────
  app.post<{ Body: CreateLessonBody }>(
    "/admin/lessons",
    { schema: { body: createLessonBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      const { weekId, type, embedUrl, richContent, fileKey } = request.body;
      assertValidLessonPayload(type, { embedUrl, richContent, fileKey });
      try {
        // order auto-asignado (append): max(order) de la semana + 1, atómico.
        const lesson = await prisma.$transaction(async (tx) => {
          const agg = await tx.lesson.aggregate({
            where: { weekId },
            _max: { order: true },
          });
          return tx.lesson.create({
            data: {
              weekId,
              type,
              order: (agg._max.order ?? 0) + 1,
              embedUrl,
              richContent,
              fileKey,
            },
            select: lessonSelect,
          });
        });
        reply.code(201);
        return { data: lesson };
      } catch (err) {
        if (isPrismaError(err, "P2003"))
          throw new AppError(
            "VALIDATION_ERROR",
            "La semana indicada no existe.",
          );
        throw err;
      }
    },
  );

  app.get<{ Querystring: LessonsQuery }>(
    "/admin/lessons",
    { schema: { querystring: lessonsQuerySchema }, preHandler: adminOnly },
    async (request) => ({
      data: await prisma.lesson.findMany({
        where: request.query.weekId ? { weekId: request.query.weekId } : {},
        select: lessonSelect,
        orderBy: [{ weekId: "asc" }, { order: "asc" }],
      }),
    }),
  );

  // Antes que /admin/lessons/:id para que no se matchee "reorder" como :id.
  app.post<{ Body: ReorderBody }>(
    "/admin/lessons/reorder",
    { schema: { body: reorderBodySchema }, preHandler: adminOnly },
    async (request) => {
      await reorderLessons(
        prisma,
        request.body.weekId,
        request.body.orderedIds,
      );
      return {
        data: await prisma.lesson.findMany({
          where: { weekId: request.body.weekId },
          select: lessonSelect,
          orderBy: { order: "asc" },
        }),
      };
    },
  );

  app.get<{ Params: IdParams }>(
    "/admin/lessons/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const lesson = await prisma.lesson.findUnique({
        where: { id: request.params.id },
        select: lessonSelect,
      });
      if (!lesson) throw new AppError("NOT_FOUND", "Lección no encontrada.");
      return { data: lesson };
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateLessonBody }>(
    "/admin/lessons/:id",
    {
      schema: { params: idParamsSchema, body: updateLessonBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      const existing = await prisma.lesson.findUnique({
        where: { id: request.params.id },
        select: { type: true },
      });
      if (!existing) throw new AppError("NOT_FOUND", "Lección no encontrada.");
      // PATCH reemplaza el contenido del tipo actual (type inmutable): el nuevo
      // conjunto de campos debe ser válido para ese tipo. Los ausentes → null.
      const { embedUrl, richContent, fileKey } = request.body;
      assertValidLessonPayload(existing.type, {
        embedUrl,
        richContent,
        fileKey,
      });
      const lesson = await prisma.lesson.update({
        where: { id: request.params.id },
        data: {
          embedUrl: embedUrl ?? null,
          richContent: richContent ?? null,
          fileKey: fileKey ?? null,
        },
        select: lessonSelect,
      });
      return { data: lesson };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/lessons/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.lesson.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Lección no encontrada.");
        mapDeleteRestrict(
          err,
          "No se puede borrar la lección: tiene preguntas asociadas.",
        );
      }
    },
  );

  // ── Preguntas ─────────────────────────────────────────────────────────────
  app.post<{ Body: CreateQuestionBody }>(
    "/admin/questions",
    { schema: { body: createQuestionBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      const { lessonId, type, content, answerSpec, points } = request.body;
      const lesson = await prisma.lesson.findUnique({
        where: { id: lessonId },
        select: { type: true },
      });
      if (!lesson)
        throw new AppError(
          "VALIDATION_ERROR",
          "La lección indicada no existe.",
        );
      assertLessonAcceptsQuestions({ type: lesson.type }); // solo quiz
      assertValidQuestion(type, content, answerSpec);
      const question = await prisma.$transaction(async (tx) => {
        const agg = await tx.question.aggregate({
          where: { lessonId },
          _max: { order: true },
        });
        return tx.question.create({
          data: {
            lessonId,
            type,
            content,
            answerSpec,
            points: points ?? 1,
            order: (agg._max.order ?? 0) + 1,
          },
          select: questionSelect,
        });
      });
      reply.code(201);
      return { data: question };
    },
  );

  app.get<{ Querystring: QuestionsQuery }>(
    "/admin/questions",
    { schema: { querystring: questionsQuerySchema }, preHandler: adminOnly },
    async (request) => ({
      data: await prisma.question.findMany({
        where: request.query.lessonId
          ? { lessonId: request.query.lessonId }
          : {},
        select: questionSelect,
        orderBy: [{ lessonId: "asc" }, { order: "asc" }],
      }),
    }),
  );

  app.get<{ Params: IdParams }>(
    "/admin/questions/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const question = await prisma.question.findUnique({
        where: { id: request.params.id },
        select: questionSelect,
      });
      if (!question) throw new AppError("NOT_FOUND", "Pregunta no encontrada.");
      return { data: question };
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateQuestionBody }>(
    "/admin/questions/:id",
    {
      schema: { params: idParamsSchema, body: updateQuestionBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      const existing = await prisma.question.findUnique({
        where: { id: request.params.id },
        select: { type: true, content: true, answerSpec: true },
      });
      if (!existing) throw new AppError("NOT_FOUND", "Pregunta no encontrada.");
      const nextContent = request.body.content ?? existing.content;
      const nextSpec = request.body.answerSpec ?? existing.answerSpec;
      // type inmutable: se valida el resultado contra el schema del tipo actual.
      assertValidQuestion(existing.type, nextContent, nextSpec);
      const question = await prisma.question.update({
        where: { id: request.params.id },
        data: {
          content: request.body.content,
          answerSpec: request.body.answerSpec,
          points: request.body.points,
        },
        select: questionSelect,
      });
      return { data: question };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/questions/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        // Sin dependientes que la bloqueen: sus QuestionTopic caen por Cascade.
        await prisma.question.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Pregunta no encontrada.");
        throw err;
      }
    },
  );
};
