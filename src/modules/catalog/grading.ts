// Motor de calificación (ISSUE-23). Módulo puro: para cada tipo de pregunta, un
// corrector `grade(answerSpec, studentAnswer, points) → { correct, pointsEarned }`.
// Es el compañero del questionTypeRegistry (uno valida schemas, este califica).
// Fail-closed: tipo desconocido o datos malformados → incorrecto, nunca lanza.

export interface GradeResult {
  correct: boolean;
  pointsEarned: number;
}

export type GraderFn = (
  answerSpec: unknown,
  studentAnswer: unknown,
  points: number,
) => GradeResult;

const registry = new Map<string, GraderFn>();

/** Registra el corrector de un tipo. Punto de extensión: un tipo nuevo se agrega
 *  aquí (o desde fuera) sin tocar los correctores existentes. */
export function registerGrader(type: string, fn: GraderFn): void {
  registry.set(type, fn);
}

/** Califica la respuesta del alumno. Fail-closed en todos los frentes. */
export function grade(
  type: string,
  answerSpec: unknown,
  studentAnswer: unknown,
  points: number,
): GradeResult {
  const grader = registry.get(type);
  if (!grader) return { correct: false, pointsEarned: 0 };
  try {
    return grader(answerSpec, studentAnswer, points);
  } catch {
    return { correct: false, pointsEarned: 0 };
  }
}

function result(correct: boolean, points: number): GradeResult {
  return { correct, pointsEarned: correct ? points : 0 };
}

function field(spec: unknown, key: string): unknown {
  return spec && typeof spec === "object"
    ? (spec as Record<string, unknown>)[key]
    : undefined;
}

/** Normaliza para fill_blank: trim siempre; quita acentos salvo accentSensitive;
 *  minúsculas salvo caseSensitive. */
function normalize(
  s: string,
  opts: { caseSensitive: boolean; accentSensitive: boolean },
): string {
  let out = s.trim();
  if (!opts.accentSensitive)
    out = out.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  if (!opts.caseSensitive) out = out.toLowerCase();
  return out;
}

// ── Correctores v1 ────────────────────────────────────────────────────────────
registerGrader("multiple_choice", (spec, ans, points) => {
  const correctIndex = field(spec, "correctIndex");
  const ok =
    typeof correctIndex === "number" &&
    typeof ans === "number" &&
    ans === correctIndex;
  return result(ok, points);
});

registerGrader("true_false", (spec, ans, points) => {
  const answer = field(spec, "answer");
  const ok =
    typeof answer === "boolean" && typeof ans === "boolean" && ans === answer;
  return result(ok, points);
});

registerGrader("fill_blank", (spec, ans, points) => {
  const answer = field(spec, "answer");
  if (typeof answer !== "string" || typeof ans !== "string")
    return result(false, points);
  const opts = {
    caseSensitive: field(spec, "caseSensitive") === true,
    accentSensitive: field(spec, "accentSensitive") === true,
  };
  return result(normalize(ans, opts) === normalize(answer, opts), points);
});
