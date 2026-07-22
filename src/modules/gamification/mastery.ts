// Maestría por topic (ISSUE-28). Tras cada quiz, `recalculate` reevalúa el nivel
// de dominio del alumno por topic usando las respuestas a preguntas de ese topic
// en los últimos MASTERY_WINDOW intentos que lo tocan. El nivel puede bajar.

import type { MasteryLevel, PrismaClient, TopicMastery } from "@prisma/client";

/** Cuántos intentos recientes (que tocan el topic) entran en la ventana. */
export const MASTERY_WINDOW = 10;

// Umbrales v1 (de mayor a menor), documentados y ajustables. Cada nivel exige
// un mínimo de respuestas y un mínimo de aciertos sobre esas respuestas.
const THRESHOLDS: {
  level: MasteryLevel;
  minAnswers: number;
  minPct: number;
}[] = [
  { level: "mastered", minAnswers: 15, minPct: 0.95 },
  { level: "proficient", minAnswers: 10, minPct: 0.8 },
  { level: "familiar", minAnswers: 5, minPct: 0.6 },
  { level: "attempted", minAnswers: 1, minPct: 0 },
];

/** Nivel de maestría según aciertos/total. `null` si no hay respuestas (no se
 *  crea ni modifica maestría). Un ratio peor devuelve un nivel menor (descenso). */
export function classify(correct: number, total: number): MasteryLevel | null {
  if (total < 1) return null;
  const pct = correct / total;
  for (const t of THRESHOLDS) {
    if (total >= t.minAnswers && pct >= t.minPct) return t.level;
  }
  return null;
}
