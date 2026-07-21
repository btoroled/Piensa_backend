// Motor de XP y niveles (ISSUE-25). Libro append-only: los eventos solo se
// insertan (idempotentes por (studentProfileId, reason, refId)); nunca se
// actualizan ni borran (lo garantiza tests/gamification/xp-append-only.test.ts).

/** XP base de la curva v1. umbral(N) = LEVEL_XP_STEP · N · (N+1) / 2. */
export const LEVEL_XP_STEP = 100;

/** Nivel del alumno según su XP acumulado. Empieza en Nivel 1 (0 XP). */
export function getLevel(totalXp: number): number {
  let level = 1;
  while ((LEVEL_XP_STEP * level * (level + 1)) / 2 <= totalXp) level++;
  return level;
}
