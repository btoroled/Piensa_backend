// Camino del alumno (ISSUE-20): GET /me/path. Devuelve, agrupado por curso del
// grado asignado ∩ materias inscritas, las semanas y lecciones en orden con su
// estado (locked|available|completed). ≤3 queries, sin N+1. El alumno se toma
// del token (studentProfileId), nunca de params.

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { computeLessonStatuses } from "./path.js";

export interface PathRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

export const pathRoutes: FastifyPluginAsync<PathRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const studentOnly = [authz.authenticate, authz.requireRole("student")];

  app.get("/me/path", { preHandler: studentOnly }, async (request) => {
    const studentProfileId = request.authPrincipal?.studentProfileId;
    if (!studentProfileId) {
      throw new AppError("UNAUTHORIZED", "No autenticado como alumno.");
    }

    const student = await prisma.studentProfile.findUnique({
      where: { id: studentProfileId },
      select: {
        gradeId: true,
        grade: { select: { id: true, name: true, level: true } },
        subjects: { select: { subjectId: true } },
      },
    });
    if (!student?.gradeId || !student.grade) {
      throw new AppError(
        "NOT_FOUND",
        "No tienes un grado asignado. Pídele al administrador que te asigne uno.",
      );
    }

    const subjectIds = student.subjects.map((s) => s.subjectId);
    const courses = subjectIds.length
      ? await prisma.course.findMany({
          where: { gradeId: student.gradeId, subjectId: { in: subjectIds } },
          orderBy: { subject: { name: "asc" } },
          select: {
            id: true,
            title: true,
            subject: { select: { id: true, name: true } },
            weeks: {
              orderBy: { number: "asc" },
              select: {
                id: true,
                number: true,
                title: true,
                lessons: {
                  orderBy: { order: "asc" },
                  select: { id: true, order: true, type: true },
                },
              },
            },
          },
        })
      : [];

    const progress = await prisma.lessonProgress.findMany({
      where: { studentProfileId },
      select: { lessonId: true },
    });
    const completed = new Set(progress.map((p) => p.lessonId));

    const data = {
      grade: student.grade,
      courses: courses.map((c) => {
        const statuses = computeLessonStatuses(c.weeks, completed);
        return {
          id: c.id,
          subject: c.subject,
          title: c.title,
          weeks: c.weeks.map((w) => ({
            number: w.number,
            title: w.title,
            lessons: w.lessons.map((l) => ({
              id: l.id,
              order: l.order,
              type: l.type,
              status: statuses.get(l.id) ?? "locked",
            })),
          })),
        };
      }),
    };
    return { data };
  });
};
