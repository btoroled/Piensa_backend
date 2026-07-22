// Lecciones del alumno (ISSUE-21, ISSUE-22).
//  - GET /lessons/:id: contenido según tipo; para quiz, preguntas SIN answerSpec
//    (no se selecciona de la BD). Bloqueada o fuera del path → FORBIDDEN.
//  - POST /lessons/:id/complete: solo video/lectura desbloqueadas. Registra
//    progreso, emite XP (+10, una sola vez por lección), actualiza racha y evalúa
//    insignias — todo en una transacción. Repasar (recompletar) cuenta para la
//    racha e insignias pero NO re-otorga XP (idempotente por lección).

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { computeLessonStatuses, type LessonStatus } from "./path.js";
import { append, getTotal, getLevel } from "../gamification/xp.js";
import {
  familyTimezoneForStudent,
  recordActivity,
} from "../gamification/streak.js";
import { evaluate } from "../gamification/badges.js";

export interface LessonRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

/** XP otorgado al completar una lección de video/lectura (una sola vez). */
export const XP_PER_LESSON = 10;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

interface StudentAccess {
  gradeId: string | null;
  subjects: { subjectId: string }[];
}

/** True si el curso está en el path del alumno: grado asignado ∩ materia inscrita. */
function inPath(
  student: StudentAccess | null,
  course: { gradeId: string; subjectId: string },
): boolean {
  const enrolled = new Set(student?.subjects.map((s) => s.subjectId));
  return (
    !!student?.gradeId &&
    course.gradeId === student.gradeId &&
    enrolled.has(course.subjectId)
  );
}

/** Estado de desbloqueo de una lección dentro de su curso. */
async function lessonStatus(
  prisma: PrismaClient,
  studentProfileId: string,
  courseId: string,
  lessonId: string,
): Promise<LessonStatus | undefined> {
  const weeks = await prisma.week.findMany({
    where: { courseId },
    orderBy: { number: "asc" },
    select: { lessons: { orderBy: { order: "asc" }, select: { id: true } } },
  });
  const progress = await prisma.lessonProgress.findMany({
    where: { studentProfileId },
    select: { lessonId: true },
  });
  const completed = new Set(progress.map((p) => p.lessonId));
  return computeLessonStatuses(weeks, completed).get(lessonId);
}

export const lessonRoutes: FastifyPluginAsync<LessonRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const studentOnly = [authz.authenticate, authz.requireRole("student")];

  const studentIdOf = (
    principal: { studentProfileId?: string } | undefined,
  ): string => {
    const id = principal?.studentProfileId;
    if (!id) throw new AppError("UNAUTHORIZED", "No autenticado como alumno.");
    return id;
  };

  // ── GET /lessons/:id ────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/lessons/:id",
    { schema: { params: idParamsSchema }, preHandler: studentOnly },
    async (request) => {
      const studentProfileId = studentIdOf(request.authPrincipal);
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
        select: { gradeId: true, subjects: { select: { subjectId: true } } },
      });
      if (!inPath(student, lesson.week.course)) {
        throw new AppError("FORBIDDEN", "Esta lección no está en tu camino.");
      }

      const status = await lessonStatus(
        prisma,
        studentProfileId,
        lesson.week.courseId,
        lessonId,
      );
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
      return {
        data: {
          ...base,
          richContent: lesson.richContent,
          fileKey: lesson.fileKey,
        },
      };
    },
  );

  // ── POST /lessons/:id/complete ──────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/lessons/:id/complete",
    { schema: { params: idParamsSchema }, preHandler: studentOnly },
    async (request) => {
      const studentProfileId = studentIdOf(request.authPrincipal);
      const lessonId = request.params.id;

      const lesson = await prisma.lesson.findUnique({
        where: { id: lessonId },
        select: {
          type: true,
          week: {
            select: {
              courseId: true,
              course: { select: { gradeId: true, subjectId: true } },
            },
          },
        },
      });
      if (!lesson) throw new AppError("NOT_FOUND", "Lección no encontrada.");

      const student = await prisma.studentProfile.findUnique({
        where: { id: studentProfileId },
        select: { gradeId: true, subjects: { select: { subjectId: true } } },
      });
      if (!inPath(student, lesson.week.course)) {
        throw new AppError("FORBIDDEN", "Esta lección no está en tu camino.");
      }
      if (lesson.type === "quiz") {
        throw new AppError(
          "VALIDATION_ERROR",
          "Un quiz se completa enviando un intento, no con esta acción.",
        );
      }
      const status = await lessonStatus(
        prisma,
        studentProfileId,
        lesson.week.courseId,
        lessonId,
      );
      if (status === "locked" || status === undefined) {
        throw new AppError("FORBIDDEN", "Esta lección está bloqueada.");
      }

      const timezone = await familyTimezoneForStudent(prisma, studentProfileId);
      const courseId = lesson.week.courseId;

      const outcome = await prisma.$transaction(async (tx) => {
        // Guardia de progreso (idempotente por alumno×lección). upsert en vez de
        // create-catch: un P2002 atrapado abortaría la transacción de Postgres.
        await tx.lessonProgress.upsert({
          where: { studentProfileId_lessonId: { studentProfileId, lessonId } },
          create: { studentProfileId, lessonId },
          update: {},
        });
        // XP: idempotente por (reason, refId) → solo la 1ª vez otorga.
        const { created } = await append(
          tx,
          studentProfileId,
          XP_PER_LESSON,
          "lesson_complete",
          lessonId,
          courseId,
        );
        // Racha e insignias: SIEMPRE (repasar cuenta como actividad de hoy).
        await recordActivity(tx, studentProfileId, timezone);
        const newBadges = await evaluate(tx, studentProfileId);
        const totalXp = await getTotal(tx, studentProfileId);
        const streak = await tx.streak.findUnique({
          where: { studentProfileId },
        });
        return { created, totalXp, streak, newBadges };
      });

      return {
        data: {
          xpEarned: outcome.created ? XP_PER_LESSON : 0,
          totalXp: outcome.totalXp,
          level: getLevel(outcome.totalXp),
          streak: {
            current: outcome.streak?.current ?? 0,
            longest: outcome.streak?.longest ?? 0,
          },
          newBadges: outcome.newBadges.map((b) => ({
            code: b.code,
            name: b.name,
            description: b.description,
          })),
        },
      };
    },
  );
};
