// Motor de XP y niveles (ISSUE-25). Libro append-only: los eventos solo se
// insertan (idempotentes por (studentProfileId, reason, refId)); nunca se
// actualizan ni borran (lo garantiza tests/gamification/xp-append-only.test.ts).

import type { PrismaClient, XPEvent, XpReason } from "@prisma/client";
import { isPrismaError } from "../../lib/prisma-errors.js";

/** XP base de la curva v1. umbral(N) = LEVEL_XP_STEP · N · (N+1) / 2. */
export const LEVEL_XP_STEP = 100;

/** Nivel del alumno según su XP acumulado. Empieza en Nivel 1 (0 XP). */
export function getLevel(totalXp: number): number {
  let level = 1;
  while ((LEVEL_XP_STEP * level * (level + 1)) / 2 <= totalXp) level++;
  return level;
}

/** Registra un evento de XP. Idempotente por (studentProfileId, reason, refId):
 *  si ya existe, no inserta y devuelve created:false con el evento previo. */
export async function append(
  db: PrismaClient,
  studentProfileId: string,
  amount: number,
  reason: XpReason,
  refId: string,
  courseId?: string,
): Promise<{ event: XPEvent; created: boolean }> {
  if (amount <= 0)
    throw new Error(`XP amount debe ser positivo (recibí ${amount})`);
  try {
    const event = await db.xPEvent.create({
      data: {
        studentProfileId,
        amount,
        reason,
        refId,
        courseId: courseId ?? null,
      },
    });
    return { event, created: true };
  } catch (err) {
    if (isPrismaError(err, "P2002")) {
      const event = await db.xPEvent.findUniqueOrThrow({
        where: {
          studentProfileId_reason_refId: { studentProfileId, reason, refId },
        },
      });
      return { event, created: false };
    }
    throw err;
  }
}

/** XP total acumulado del alumno (todos los eventos). */
export async function getTotal(
  db: PrismaClient,
  studentProfileId: string,
): Promise<number> {
  const r = await db.xPEvent.aggregate({
    _sum: { amount: true },
    where: { studentProfileId },
  });
  return r._sum.amount ?? 0;
}

/** XP por curso (excluye eventos sin curso). Mapa courseId → total. */
export async function getCourseTotals(
  db: PrismaClient,
  studentProfileId: string,
): Promise<Record<string, number>> {
  const rows = await db.xPEvent.groupBy({
    by: ["courseId"],
    where: { studentProfileId, courseId: { not: null } },
    _sum: { amount: true },
  });
  return Object.fromEntries(
    rows.map((r) => [r.courseId as string, r._sum.amount ?? 0]),
  );
}
