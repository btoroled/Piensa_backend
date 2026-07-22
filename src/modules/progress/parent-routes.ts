// Endpoints del padre (ISSUE-30). El padre ve a SUS hijos:
//  - GET /family/students: lista compacta (XP/nivel, racha, insignias ganadas).
//  - GET /family/students/:id/progress: avance por semana, maestría, racha y
//    últimos intentos.
// La familia se resuelve por `parentUserId` contra la BD (no de los claims). El
// detalle verifica pertenencia con requireStudentOwnership (ISSUE-09).

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { getLevel } from "../gamification/xp.js";
import { PASS_THRESHOLD } from "./quiz-routes.js";

export interface ParentRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

export const parentRoutes: FastifyPluginAsync<ParentRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const parentOnly = [authz.authenticate, authz.requireRole("parent")];

  // ── GET /family/students ────────────────────────────────────────────────────
  app.get("/family/students", { preHandler: parentOnly }, async (request) => {
    const userId = request.authPrincipal?.userId;
    if (!userId) throw new AppError("UNAUTHORIZED", "No autenticado.");

    const family = await prisma.family.findFirst({
      where: { parentUserId: userId },
      select: {
        students: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            avatar: true,
            grade: { select: { level: true, name: true } },
          },
        },
      },
    });
    const children = family?.students ?? [];
    if (children.length === 0) return { data: [] };

    const childIds = children.map((c) => c.id);
    const [xpAgg, streaks, badgeAgg] = await Promise.all([
      prisma.xPEvent.groupBy({
        by: ["studentProfileId"],
        where: { studentProfileId: { in: childIds } },
        _sum: { amount: true },
      }),
      prisma.streak.findMany({
        where: { studentProfileId: { in: childIds } },
        select: { studentProfileId: true, current: true, longest: true },
      }),
      prisma.badgeAward.groupBy({
        by: ["studentProfileId"],
        where: { studentProfileId: { in: childIds } },
        _count: { _all: true },
      }),
    ]);
    const xpByChild = new Map(
      xpAgg.map((r) => [r.studentProfileId, r._sum.amount ?? 0]),
    );
    const streakByChild = new Map(streaks.map((s) => [s.studentProfileId, s]));
    const badgesByChild = new Map(
      badgeAgg.map((r) => [r.studentProfileId, r._count._all]),
    );

    return {
      data: children.map((c) => {
        const total = xpByChild.get(c.id) ?? 0;
        const s = streakByChild.get(c.id);
        return {
          id: c.id,
          name: c.name,
          avatar: c.avatar,
          grade: c.grade,
          xp: { total, level: getLevel(total) },
          streak: { current: s?.current ?? 0, longest: s?.longest ?? 0 },
          badgesEarned: badgesByChild.get(c.id) ?? 0,
        };
      }),
    };
  });

  // ── GET /family/students/:id/progress ───────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/family/students/:id/progress",
    {
      schema: { params: idParamsSchema },
      preHandler: [
        authz.authenticate,
        authz.requireRole("parent"),
        authz.requireStudentOwnership({ from: "params", key: "id" }),
      ],
    },
    async (request) => {
      const studentProfileId = request.params.id;

      const student = await prisma.studentProfile.findUnique({
        where: { id: studentProfileId },
        select: {
          id: true,
          name: true,
          avatar: true,
          gradeId: true,
          grade: { select: { id: true, level: true, name: true } },
          subjects: { select: { subjectId: true } },
        },
      });
      if (!student) throw new AppError("NOT_FOUND", "Alumno no encontrado.");

      const enrolled = student.subjects.map((s) => s.subjectId);
      const coursesQuery =
        student.gradeId && enrolled.length
          ? prisma.course.findMany({
              where: { gradeId: student.gradeId, subjectId: { in: enrolled } },
              orderBy: { subject: { name: "asc" } },
              select: {
                id: true,
                title: true,
                subject: { select: { id: true, name: true } },
                weeks: {
                  orderBy: { number: "asc" },
                  select: {
                    number: true,
                    title: true,
                    lessons: { select: { id: true } },
                  },
                },
              },
            })
          : Promise.resolve([]);

      const [streak, courses, progressRows, mastery, attempts] =
        await Promise.all([
          prisma.streak.findUnique({ where: { studentProfileId } }),
          coursesQuery,
          prisma.lessonProgress.findMany({
            where: { studentProfileId },
            select: { lessonId: true },
          }),
          prisma.topicMastery.findMany({
            where: { studentProfileId },
            select: {
              topicId: true,
              level: true,
              topic: { select: { name: true } },
            },
            orderBy: { topic: { name: "asc" } },
          }),
          prisma.quizAttempt.findMany({
            where: { studentProfileId },
            orderBy: { createdAt: "desc" },
            take: 10,
            select: {
              lessonId: true,
              score: true,
              maxScore: true,
              createdAt: true,
            },
          }),
        ]);

      const completed = new Set(progressRows.map((p) => p.lessonId));
      const progress = courses.map((c) => ({
        course: { id: c.id, title: c.title, subject: c.subject.name },
        weeks: c.weeks.map((w) => ({
          number: w.number,
          title: w.title,
          total: w.lessons.length,
          completed: w.lessons.filter((l) => completed.has(l.id)).length,
        })),
      }));

      return {
        data: {
          student: {
            id: student.id,
            name: student.name,
            avatar: student.avatar,
            grade: student.grade,
          },
          streak: {
            current: streak?.current ?? 0,
            longest: streak?.longest ?? 0,
          },
          progress,
          mastery: mastery.map((m) => ({
            topicId: m.topicId,
            topic: m.topic.name,
            level: m.level,
          })),
          recentAttempts: attempts.map((a) => ({
            lessonId: a.lessonId,
            score: a.score,
            maxScore: a.maxScore,
            passed: a.maxScore > 0 && a.score / a.maxScore >= PASS_THRESHOLD,
            createdAt: a.createdAt,
          })),
        },
      };
    },
  );
};
