// Resumen del alumno (ISSUE-29): cálculo puro del progreso dentro del nivel.
// Reusa la curva de XP (ISSUE-25) sin duplicar constantes.

import { LEVEL_XP_STEP, getLevel } from "../gamification/xp.js";

export interface LevelProgress {
  level: number;
  /** XP acumulado dentro del nivel actual. */
  intoLevel: number;
  /** XP que exige el tramo del nivel actual (para llegar al siguiente). */
  forNextLevel: number;
}

/** XP acumulado necesario para ESTAR en el nivel n+1 (umbral de la curva). */
const threshold = (n: number): number => (LEVEL_XP_STEP * n * (n + 1)) / 2;

/** Nivel y progreso hacia el siguiente dado el XP total. */
export function levelProgress(totalXp: number): LevelProgress {
  const level = getLevel(totalXp);
  const floor = threshold(level - 1); // XP con el que se entró al nivel actual
  const next = threshold(level); // XP para pasar al siguiente
  return {
    level,
    intoLevel: totalXp - floor,
    forNextLevel: next - floor,
  };
}
