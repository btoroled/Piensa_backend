// Topics y etiquetado (ISSUE-16), bajo /api/v1/admin. Solo admin. Un topic en
// uso no se puede borrar (FK Restrict de LessonTopic/QuestionTopic → CONFLICT).
// Etiquetar es idempotente (ya etiquetado → 200).

import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { isPrismaError, mapDeleteRestrict } from "../../lib/prisma-errors.js";

export interface TopicsRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const topicBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
} as const;

const tagBodySchema = {
  type: "object",
  required: ["topicId"],
  additionalProperties: false,
  properties: { topicId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const tagParamsSchema = {
  type: "object",
  required: ["id", "topicId"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    topicId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

interface IdParams {
  id: string;
}
interface TopicBody {
  name: string;
}
interface TagBody {
  topicId: string;
}
interface TagParams {
  id: string;
  topicId: string;
}

const topicSelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const topicsRoutes: FastifyPluginAsync<TopicsRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];

  // ── Topics ────────────────────────────────────────────────────────────────
  app.post<{ Body: TopicBody }>(
    "/admin/topics",
    { schema: { body: topicBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      try {
        const topic = await prisma.topic.create({
          data: { name: request.body.name },
          select: topicSelect,
        });
        reply.code(201);
        return { data: topic };
      } catch (err) {
        if (isPrismaError(err, "P2002"))
          throw new AppError("CONFLICT", "Ya existe un topic con ese nombre.");
        throw err;
      }
    },
  );

  app.get("/admin/topics", { preHandler: adminOnly }, async () => ({
    data: await prisma.topic.findMany({
      select: topicSelect,
      orderBy: { name: "asc" },
    }),
  }));

  app.get<{ Params: IdParams }>(
    "/admin/topics/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const topic = await prisma.topic.findUnique({
        where: { id: request.params.id },
        select: topicSelect,
      });
      if (!topic) throw new AppError("NOT_FOUND", "Topic no encontrado.");
      return { data: topic };
    },
  );

  app.patch<{ Params: IdParams; Body: TopicBody }>(
    "/admin/topics/:id",
    {
      schema: { params: idParamsSchema, body: topicBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        const topic = await prisma.topic.update({
          where: { id: request.params.id },
          data: { name: request.body.name },
          select: topicSelect,
        });
        return { data: topic };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Topic no encontrado.");
        if (isPrismaError(err, "P2002"))
          throw new AppError("CONFLICT", "Ya existe un topic con ese nombre.");
        throw err;
      }
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/topics/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.topic.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Topic no encontrado.");
        mapDeleteRestrict(
          err,
          "No se puede borrar el topic: está en uso por lecciones o preguntas.",
        );
      }
    },
  );

  // ── Etiquetado ──────────────────────────────────────────────────────────
  // Etiquetar es idempotente (ya etiquetado → 200). Un id inexistente (lección/
  // pregunta o topic) → VALIDATION_ERROR.
  const tag = async (
    link: () => Promise<unknown>,
    reply: FastifyReply,
    payload: object,
  ) => {
    try {
      await link();
      reply.code(201);
    } catch (err) {
      if (isPrismaError(err, "P2002")) {
        reply.code(200); // ya etiquetado: idempotente.
      } else if (isPrismaError(err, "P2003")) {
        throw new AppError(
          "VALIDATION_ERROR",
          "El recurso o el topic indicado no existe.",
        );
      } else {
        throw err;
      }
    }
    return { data: payload };
  };

  // Lecciones ↔ topics
  app.post<{ Params: IdParams; Body: TagBody }>(
    "/admin/lessons/:id/topics",
    {
      schema: { params: idParamsSchema, body: tagBodySchema },
      preHandler: adminOnly,
    },
    async (request, reply) => {
      const { id: lessonId } = request.params;
      const { topicId } = request.body;
      return tag(
        () => prisma.lessonTopic.create({ data: { lessonId, topicId } }),
        reply,
        { lessonId, topicId, tagged: true },
      );
    },
  );

  app.delete<{ Params: TagParams }>(
    "/admin/lessons/:id/topics/:topicId",
    { schema: { params: tagParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const { id: lessonId, topicId } = request.params;
      try {
        await prisma.lessonTopic.delete({
          where: { lessonId_topicId: { lessonId, topicId } },
        });
        return { data: { lessonId, topicId, tagged: false } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "La etiqueta no existe.");
        throw err;
      }
    },
  );

  app.get<{ Params: IdParams }>(
    "/admin/lessons/:id/topics",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const links = await prisma.lessonTopic.findMany({
        where: { lessonId: request.params.id },
        select: { topic: { select: topicSelect } },
        orderBy: { topic: { name: "asc" } },
      });
      return { data: links.map((l) => l.topic) };
    },
  );

  // Preguntas ↔ topics
  app.post<{ Params: IdParams; Body: TagBody }>(
    "/admin/questions/:id/topics",
    {
      schema: { params: idParamsSchema, body: tagBodySchema },
      preHandler: adminOnly,
    },
    async (request, reply) => {
      const { id: questionId } = request.params;
      const { topicId } = request.body;
      return tag(
        () => prisma.questionTopic.create({ data: { questionId, topicId } }),
        reply,
        { questionId, topicId, tagged: true },
      );
    },
  );

  app.delete<{ Params: TagParams }>(
    "/admin/questions/:id/topics/:topicId",
    { schema: { params: tagParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const { id: questionId, topicId } = request.params;
      try {
        await prisma.questionTopic.delete({
          where: { questionId_topicId: { questionId, topicId } },
        });
        return { data: { questionId, topicId, tagged: false } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "La etiqueta no existe.");
        throw err;
      }
    },
  );

  app.get<{ Params: IdParams }>(
    "/admin/questions/:id/topics",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const links = await prisma.questionTopic.findMany({
        where: { questionId: request.params.id },
        select: { topic: { select: topicSelect } },
        orderBy: { topic: { name: "asc" } },
      });
      return { data: links.map((l) => l.topic) };
    },
  );
};
