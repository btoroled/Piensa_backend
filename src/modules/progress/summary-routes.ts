// Resumen del alumno (ISSUE-29): GET /me/summary. Panel de solo lectura con XP y
// nivel, racha, insignias (ganadas y por ganar) y maestría por topic. Queries
// acotadas y en paralelo (sin N+1). El alumno se toma del token.

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { getTotal } from "../gamification/xp.js";
import { levelProgress } from "./summary.js";

export interface SummaryRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

export const summaryRoutes: FastifyPluginAsync<SummaryRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const studentOnly = [authz.authenticate, authz.requireRole("student")];

  app.get("/me/summary", { preHandler: studentOnly }, async (request) => {
    const studentProfileId = request.authPrincipal?.studentProfileId;
    if (!studentProfileId) {
      throw new AppError("UNAUTHORIZED", "No autenticado como alumno.");
    }

    const [totalXp, streak, badges, awards, mastery] = await Promise.all([
      getTotal(prisma, studentProfileId),
      prisma.streak.findUnique({ where: { studentProfileId } }),
      prisma.badge.findMany({
        select: { id: true, code: true, name: true, description: true },
        orderBy: { code: "asc" },
      }),
      prisma.badgeAward.findMany({
        where: { studentProfileId },
        select: { badgeId: true, awardedAt: true },
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
    ]);

    const awardedAt = new Map(awards.map((a) => [a.badgeId, a.awardedAt]));
    const earned: {
      code: string;
      name: string;
      description: string;
      awardedAt: Date;
    }[] = [];
    const available: { code: string; name: string; description: string }[] = [];
    for (const b of badges) {
      const at = awardedAt.get(b.id);
      const base = { code: b.code, name: b.name, description: b.description };
      if (at) earned.push({ ...base, awardedAt: at });
      else available.push(base);
    }

    return {
      data: {
        xp: { total: totalXp, ...levelProgress(totalXp) },
        streak: {
          current: streak?.current ?? 0,
          longest: streak?.longest ?? 0,
        },
        badges: { earned, available },
        mastery: mastery.map((m) => ({
          topicId: m.topicId,
          topic: m.topic.name,
          level: m.level,
        })),
      },
    };
  });
};
