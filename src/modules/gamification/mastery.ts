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

interface Outcome {
  questionId: string;
  correct: boolean;
}

/** Contrato con ISSUE-24: `QuizAttempt.answers` es un array de respuestas con al
 *  menos { questionId, correct }. Fail-closed: lo que no calce, se ignora. */
function parseOutcomes(answers: unknown): Outcome[] {
  if (!Array.isArray(answers)) return [];
  const out: Outcome[] = [];
  for (const a of answers) {
    if (a && typeof a === "object") {
      const q = (a as Record<string, unknown>).questionId;
      const c = (a as Record<string, unknown>).correct;
      if (typeof q === "string" && typeof c === "boolean")
        out.push({ questionId: q, correct: c });
    }
  }
  return out;
}

/** Recalcula la maestría del alumno en `topicIds` tras un quiz. Para cada topic:
 *  toma los últimos MASTERY_WINDOW intentos que lo tocan, cuenta aciertos/total
 *  de las respuestas a preguntas de ese topic, clasifica y hace upsert (puede
 *  bajar el nivel). Devuelve las maestrías actualizadas. */
export async function recalculate(
  db: PrismaClient,
  studentProfileId: string,
  topicIds: string[],
): Promise<TopicMastery[]> {
  const targets = [...new Set(topicIds)];
  if (targets.length === 0) return [];

  // Intentos del alumno, más recientes primero, con sus respuestas.
  const attempts = await db.quizAttempt.findMany({
    where: { studentProfileId },
    orderBy: { createdAt: "desc" },
    select: { answers: true },
  });
  const parsed = attempts.map((a) => parseOutcomes(a.answers));

  // Topics (de los buscados) de cada pregunta respondida.
  const questionIds = [...new Set(parsed.flat().map((o) => o.questionId))];
  const links = questionIds.length
    ? await db.questionTopic.findMany({
        where: { questionId: { in: questionIds }, topicId: { in: targets } },
        select: { questionId: true, topicId: true },
      })
    : [];
  const topicsByQuestion = new Map<string, Set<string>>();
  for (const l of links) {
    const set = topicsByQuestion.get(l.questionId) ?? new Set<string>();
    set.add(l.topicId);
    topicsByQuestion.set(l.questionId, set);
  }

  const results: TopicMastery[] = [];
  for (const topicId of targets) {
    let correct = 0;
    let total = 0;
    let seen = 0;
    for (const outcomes of parsed) {
      const touches = outcomes.some((o) =>
        topicsByQuestion.get(o.questionId)?.has(topicId),
      );
      if (!touches) continue;
      for (const o of outcomes) {
        if (topicsByQuestion.get(o.questionId)?.has(topicId)) {
          total++;
          if (o.correct) correct++;
        }
      }
      if (++seen >= MASTERY_WINDOW) break;
    }

    const level = classify(correct, total);
    if (!level) continue;
    const saved = await db.topicMastery.upsert({
      where: { studentProfileId_topicId: { studentProfileId, topicId } },
      create: { studentProfileId, topicId, level },
      update: { level },
    });
    results.push(saved);
  }
  return results;
}
