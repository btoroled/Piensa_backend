// Contenido de lección para el alumno (ISSUE-21): GET /lessons/:id. Solo si la
// lección está en el path del alumno (grado asignado ∩ materia inscrita) y
// desbloqueada; si no, FORBIDDEN. Para quiz devuelve las preguntas con `content`
// pero NUNCA `answerSpec`: no se selecciona de la BD (garantía a nivel de query).

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { computeLessonStatuses } from "./path.js";

export interface LessonRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

export const lessonRoutes: FastifyPluginAsync<LessonRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const studentOnly = [authz.authenticate, authz.requireRole("student")];

  app.get<{ Params: { id: string } }>(
    "/lessons/:id",
    { schema: { params: idParamsSchema }, preHandler: studentOnly },
    async (request) => {
      const studentProfileId = request.authPrincipal?.studentProfileId;
      if (!studentProfileId) {
        throw new AppError("UNAUTHORIZED", "No autenticado como alumno.");
      }
      const lessonId = request.params.id;

      // `answerSpec` deliberadamente ausente del select: no se lee jamás.
      const lesson = await prisma.lesson.findUnique({
        where: { id: lessonId },
        select: {
          id: true,
          type: true,
          order: true,
          embedUrl: true,
          richContent: true,
          fileKey: true,
          week: {
            select: {
              courseId: true,
              course: { select: { gradeId: true, subjectId: true } },
            },
          },
          questions: {
            orderBy: { order: "asc" },
            select: {
              id: true,
              order: true,
              type: true,
              content: true,
              points: true,
            },
          },
        },
      });
      if (!lesson) throw new AppError("NOT_FOUND", "Lección no encontrada.");

      const student = await prisma.studentProfile.findUnique({
        where: { id: studentProfileId },
        select: {
          gradeId: true,
          subjects: { select: { subjectId: true } },
        },
      });
      const enrolled = new Set(student?.subjects.map((s) => s.subjectId));
      const course = lesson.week.course;
      if (
        !student?.gradeId ||
        course.gradeId !== student.gradeId ||
        !enrolled.has(course.subjectId)
      ) {
        throw new AppError("FORBIDDEN", "Esta lección no está en tu camino.");
      }

      // Gate de desbloqueo: recalcula estados sobre el curso completo.
      const weeks = await prisma.week.findMany({
        where: { courseId: lesson.week.courseId },
        orderBy: { number: "asc" },
        select: {
          lessons: { orderBy: { order: "asc" }, select: { id: true } },
        },
      });
      const progress = await prisma.lessonProgress.findMany({
        where: { studentProfileId },
        select: { lessonId: true },
      });
      const completed = new Set(progress.map((p) => p.lessonId));
      const status = computeLessonStatuses(weeks, completed).get(lessonId);
      if (status === "locked" || status === undefined) {
        throw new AppError("FORBIDDEN", "Esta lección está bloqueada.");
      }

      const base = {
        id: lesson.id,
        type: lesson.type,
        order: lesson.order,
        status,
      };
      if (lesson.type === "quiz") {
        return { data: { ...base, questions: lesson.questions } };
      }
      if (lesson.type === "video") {
        return {
          data: { ...base, embedUrl: lesson.embedUrl, fileKey: lesson.fileKey },
        };
      }
      // reading
      return {
        data: {
          ...base,
          richContent: lesson.richContent,
          fileKey: lesson.fileKey,
        },
      };
    },
  );
};
