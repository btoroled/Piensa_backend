// Insignias (ISSUE-27). Evaluador declarativo: cada Badge tiene un `criteria`
// (JSON) con un `type` que resuelve a un predicado sobre el estado agregado del
// alumno. `evaluate` barre el catálogo y otorga las que faltan y cumplen —
// idempotente (unique en BD) y retroactivo (lee estado actual, p. ej. longest).

import type { Badge, Prisma, PrismaClient } from "@prisma/client";
import { isPrismaError } from "../../lib/prisma-errors.js";

/** Criterio declarativo de una insignia (unión discriminada por `type`). */
export type Criteria =
  | { type: "lessons_completed"; count: number }
  | { type: "week_complete" }
  | { type: "perfect_quiz" }
  | { type: "streak"; days: number };

type PredicateFn = (
  db: PrismaClient,
  studentProfileId: string,
  criteria: Record<string, unknown>,
) => Promise<boolean>;

/** Registro de predicados: `type` → función. Punto de extensión (un tipo nuevo
 *  se agrega aquí; una insignia nueva del mismo tipo es solo una fila Badge). */
const PREDICATES: Record<string, PredicateFn> = {
  lessons_completed: async (db, sid, c) => {
    const count = typeof c.count === "number" ? c.count : NaN;
    if (!Number.isFinite(count)) return false;
    const done = await db.lessonProgress.count({
      where: { studentProfileId: sid },
    });
    return done >= count;
  },

  week_complete: async (db, sid) => {
    const done = await db.lessonProgress.findMany({
      where: { studentProfileId: sid },
      select: { lesson: { select: { weekId: true } } },
    });
    if (done.length === 0) return false;
    const doneByWeek = new Map<string, number>();
    for (const r of done)
      doneByWeek.set(
        r.lesson.weekId,
        (doneByWeek.get(r.lesson.weekId) ?? 0) + 1,
      );
    const weeks = await db.week.findMany({
      where: { id: { in: [...doneByWeek.keys()] } },
      select: { id: true, _count: { select: { lessons: true } } },
    });
    // Una semana está completa si el alumno completó todas sus lecciones.
    return weeks.some(
      (w) => w._count.lessons > 0 && doneByWeek.get(w.id) === w._count.lessons,
    );
  },

  perfect_quiz: async (db, sid) => {
    const attempts = await db.quizAttempt.findMany({
      where: { studentProfileId: sid, maxScore: { gt: 0 } },
      select: { score: true, maxScore: true },
    });
    return attempts.some((a) => a.score >= a.maxScore);
  },

  streak: async (db, sid, c) => {
    const days = typeof c.days === "number" ? c.days : NaN;
    if (!Number.isFinite(days)) return false;
    const s = await db.streak.findUnique({ where: { studentProfileId: sid } });
    return (s?.longest ?? 0) >= days;
  },
};

/** True si el alumno cumple el criterio. Fail-closed: criterio malformado o de
 *  tipo desconocido → false; un error del predicado nunca revienta la actividad. */
export async function criteriaMet(
  db: PrismaClient,
  studentProfileId: string,
  criteria: unknown,
): Promise<boolean> {
  if (!criteria || typeof criteria !== "object") return false;
  const c = criteria as Record<string, unknown>;
  const type = typeof c.type === "string" ? c.type : "";
  const pred = PREDICATES[type];
  if (!pred) return false;
  try {
    return await pred(db, studentProfileId, c);
  } catch {
    return false;
  }
}

/** Evalúa todo el catálogo y otorga las insignias faltantes cuyo criterio se
 *  cumple. Devuelve las recién otorgadas. Idempotente (insert-catch-P2002). */
export async function evaluate(
  db: PrismaClient,
  studentProfileId: string,
): Promise<Badge[]> {
  const [badges, existing] = await Promise.all([
    db.badge.findMany(),
    db.badgeAward.findMany({
      where: { studentProfileId },
      select: { badgeId: true },
    }),
  ]);
  const awarded = new Set(existing.map((a) => a.badgeId));

  const newly: Badge[] = [];
  for (const badge of badges) {
    if (awarded.has(badge.id)) continue;
    if (!(await criteriaMet(db, studentProfileId, badge.criteria))) continue;
    try {
      await db.badgeAward.create({
        data: { studentProfileId, badgeId: badge.id },
      });
      newly.push(badge);
    } catch (err) {
      // P2002: otorgada por una carrera concurrente; no cuenta como nueva.
      if (!isPrismaError(err, "P2002")) throw err;
    }
  }
  return newly;
}

/** Catálogo de insignias v1 (Spec §4). */
export const V1_BADGES: {
  code: string;
  name: string;
  description: string;
  criteria: Criteria;
}[] = [
  {
    code: "first-lesson",
    name: "Primera lección",
    description: "Completaste tu primera lección.",
    criteria: { type: "lessons_completed", count: 1 },
  },
  {
    code: "week-complete",
    name: "Semana completa",
    description: "Completaste todas las lecciones de una semana.",
    criteria: { type: "week_complete" },
  },
  {
    code: "perfect-quiz",
    name: "Quiz perfecto",
    description: "Obtuviste el puntaje máximo en un quiz.",
    criteria: { type: "perfect_quiz" },
  },
  {
    code: "streak-7",
    name: "Racha de 7 días",
    description: "Mantuviste una racha de 7 días.",
    criteria: { type: "streak", days: 7 },
  },
  {
    code: "streak-30",
    name: "Racha de 30 días",
    description: "Mantuviste una racha de 30 días.",
    criteria: { type: "streak", days: 30 },
  },
];

/** Siembra (idempotente, upsert por code) el catálogo v1. */
export async function seedBadges(db: PrismaClient): Promise<void> {
  for (const b of V1_BADGES) {
    const criteria = b.criteria as Prisma.InputJsonValue;
    await db.badge.upsert({
      where: { code: b.code },
      create: {
        code: b.code,
        name: b.name,
        description: b.description,
        criteria,
      },
      update: { name: b.name, description: b.description, criteria },
    });
  }
}
