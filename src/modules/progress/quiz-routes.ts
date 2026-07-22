// Enviar intento de quiz (ISSUE-24): POST /quizzes/:id/attempts. El :id es la
// lección tipo quiz. Califica server-side con el motor de ISSUE-23 (el answerSpec
// solo se usa acá, nunca se envía al cliente), persiste el intento completo, y —
// en una transacción — otorga XP (no farmeable), marca progreso si aprueba, y
// actualiza racha, insignias y maestría. `perQuestion` nunca revela la respuesta.

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient, Prisma } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { computeLessonStatuses } from "./path.js";
import { grade } from "../catalog/grading.js";
import { append, getTotal, getLevel } from "../gamification/xp.js";
import {
  familyTimezoneForStudent,
  localDate,
  recordActivity,
} from "../gamification/streak.js";
import { evaluate } from "../gamification/badges.js";
import { recalculate } from "../gamification/mastery.js";

export interface QuizRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

/** Umbral de aprobación v1 (configurable). */
export const PASS_THRESHOLD = 0.7;
export const XP_QUIZ_PASSED = 20;
export const XP_QUIZ_ATTEMPT = 5;

const bodySchema = {
  type: "object",
  required: ["answers"],
  additionalProperties: false,
  properties: {
    answers: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        required: ["questionId"],
        additionalProperties: false,
        properties: {
          questionId: { type: "string", pattern: UUID_PATTERN },
          // Índice (mc), booleano (tf) o texto (fill_blank), según el tipo.
          answer: { type: ["string", "number", "boolean"] },
        },
      },
    },
  },
} as const;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

interface AttemptBody {
  answers: { questionId: string; answer?: string | number | boolean }[];
}

export const quizRoutes: FastifyPluginAsync<QuizRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const studentOnly = [authz.authenticate, authz.requireRole("student")];

  app.post<{ Params: { id: string }; Body: AttemptBody }>(
    "/quizzes/:id/attempts",
    {
      schema: { params: idParamsSchema, body: bodySchema },
      preHandler: studentOnly,
    },
    async (request) => {
      const studentProfileId = request.authPrincipal?.studentProfileId;
      if (!studentProfileId) {
        throw new AppError("UNAUTHORIZED", "No autenticado como alumno.");
      }
      const lessonId = request.params.id;

      // Cargamos las preguntas CON answerSpec (uso server-side exclusivo).
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
          questions: {
            orderBy: { order: "asc" },
            select: {
              id: true,
              type: true,
              answerSpec: true,
              points: true,
              topics: { select: { topicId: true } },
            },
          },
        },
      });
      if (!lesson) throw new AppError("NOT_FOUND", "Quiz no encontrado.");

      const student = await prisma.studentProfile.findUnique({
        where: { id: studentProfileId },
        select: { gradeId: true, subjects: { select: { subjectId: true } } },
      });
      const enrolled = new Set(student?.subjects.map((s) => s.subjectId));
      const course = lesson.week.course;
      if (
        !student?.gradeId ||
        course.gradeId !== student.gradeId ||
        !enrolled.has(course.subjectId)
      ) {
        throw new AppError("FORBIDDEN", "Este quiz no está en tu camino.");
      }
      if (lesson.type !== "quiz") {
        throw new AppError("VALIDATION_ERROR", "Esta lección no es un quiz.");
      }

      // Gate de desbloqueo.
      const weeks = await prisma.week.findMany({
        where: { courseId: lesson.week.courseId },
        orderBy: { number: "asc" },
        select: {
          lessons: { orderBy: { order: "asc" }, select: { id: true } },
        },
      });
      const progressRows = await prisma.lessonProgress.findMany({
        where: { studentProfileId },
        select: { lessonId: true },
      });
      const unlocked = computeLessonStatuses(
        weeks,
        new Set(progressRows.map((p) => p.lessonId)),
      ).get(lessonId);
      if (unlocked === "locked" || unlocked === undefined) {
        throw new AppError("FORBIDDEN", "Este quiz está bloqueado.");
      }

      // ── Calificación (pura, server-side) ──────────────────────────────────
      const submitted = new Map(
        request.body.answers.map((a) => [a.questionId, a.answer]),
      );
      let score = 0;
      let maxScore = 0;
      const perQuestion: { questionId: string; correct: boolean }[] = [];
      const stored: {
        questionId: string;
        answer: string | number | boolean | null;
        correct: boolean;
        pointsEarned: number;
      }[] = [];
      const topicIds = new Set<string>();
      for (const q of lesson.questions) {
        const studentAnswer = submitted.get(q.id);
        const { correct, pointsEarned } = grade(
          q.type,
          q.answerSpec,
          studentAnswer,
          q.points,
        );
        score += pointsEarned;
        maxScore += q.points;
        perQuestion.push({ questionId: q.id, correct });
        stored.push({
          questionId: q.id,
          answer: studentAnswer ?? null,
          correct,
          pointsEarned,
        });
        for (const t of q.topics) topicIds.add(t.topicId);
      }
      const passed = maxScore > 0 && score / maxScore >= PASS_THRESHOLD;

      const timezone = await familyTimezoneForStudent(prisma, studentProfileId);
      const today = localDate(new Date(), timezone);
      const courseId = lesson.week.courseId;
      const touchedTopics = [...topicIds];

      const outcome = await prisma.$transaction(async (tx) => {
        await tx.quizAttempt.create({
          data: {
            studentProfileId,
            lessonId,
            answers: stored as unknown as Prisma.InputJsonValue,
            score,
            maxScore,
          },
        });

        // XP no farmeable: aprobar da +20 UNA vez por quiz; un intento fallido da
        // +5 solo el primer fallo del día por quiz.
        let xp;
        if (passed) {
          await tx.lessonProgress.upsert({
            where: {
              studentProfileId_lessonId: { studentProfileId, lessonId },
            },
            create: { studentProfileId, lessonId },
            update: {},
          });
          xp = await append(
            tx,
            studentProfileId,
            XP_QUIZ_PASSED,
            "quiz_passed",
            lessonId,
            courseId,
          );
        } else {
          xp = await append(
            tx,
            studentProfileId,
            XP_QUIZ_ATTEMPT,
            "quiz_attempt",
            `${lessonId}:${today}`,
            courseId,
          );
        }
        const xpEarned = xp.created
          ? passed
            ? XP_QUIZ_PASSED
            : XP_QUIZ_ATTEMPT
          : 0;

        // Racha, insignias y maestría: SIEMPRE (reintentar cuenta como actividad).
        await recordActivity(tx, studentProfileId, timezone);
        const newBadges = await evaluate(tx, studentProfileId);

        const before = await tx.topicMastery.findMany({
          where: { studentProfileId, topicId: { in: touchedTopics } },
          select: { topicId: true, level: true },
        });
        const beforeByTopic = new Map(before.map((m) => [m.topicId, m.level]));
        const updated = await recalculate(tx, studentProfileId, touchedTopics);
        const masteryChanges = updated
          .filter((m) => (beforeByTopic.get(m.topicId) ?? null) !== m.level)
          .map((m) => ({
            topicId: m.topicId,
            from: beforeByTopic.get(m.topicId) ?? null,
            to: m.level,
          }));

        const totalXp = await getTotal(tx, studentProfileId);
        const streak = await tx.streak.findUnique({
          where: { studentProfileId },
        });
        return { xpEarned, totalXp, streak, newBadges, masteryChanges };
      });

      return {
        data: {
          score,
          maxScore,
          passed,
          perQuestion,
          xpEarned: outcome.xpEarned,
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
          masteryChanges: outcome.masteryChanges,
        },
      };
    },
  );
};
