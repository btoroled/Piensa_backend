// Registro de tipos de pregunta (ISSUE-15): el punto de extensión del catálogo.
// Cada tipo declara el JSON Schema de su `content` y su `answerSpec`; el CRUD
// valida contra ellos. Agregar un tipo = registrar schemas (+ su corrector en
// M3), CERO migraciones. La columna Question.type es String; ESTE registro es la
// fuente de verdad de qué tipos son válidos (fail-closed en el servidor).

import { Ajv, type ValidateFunction } from "ajv";
import { AppError } from "../../plugins/errors.js";

export interface QuestionTypeDef {
  contentSchema: Record<string, unknown>;
  answerSpecSchema: Record<string, unknown>;
  /** Coherencia cruzada que el JSON Schema no expresa; devuelve msg de error o null. */
  crossCheck?: (content: unknown, answerSpec: unknown) => string | null;
}

const ajv = new Ajv({ allErrors: true });

interface Compiled {
  def: QuestionTypeDef;
  content: ValidateFunction;
  answerSpec: ValidateFunction;
}
const registry = new Map<string, Compiled>();

export function registerQuestionType(type: string, def: QuestionTypeDef): void {
  registry.set(type, {
    def,
    content: ajv.compile(def.contentSchema),
    answerSpec: ajv.compile(def.answerSpecSchema),
  });
}

export function isRegisteredQuestionType(type: string): boolean {
  return registry.has(type);
}

/** Valida content/answerSpec contra el schema del tipo. Lanza VALIDATION_ERROR. */
export function assertValidQuestion(
  type: string,
  content: unknown,
  answerSpec: unknown,
): void {
  const entry = registry.get(type);
  if (!entry) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Tipo de pregunta no soportado: ${type}.`,
    );
  }
  if (!entry.content(content)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `content inválido: ${ajv.errorsText(entry.content.errors)}`,
    );
  }
  if (!entry.answerSpec(answerSpec)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `answerSpec inválido: ${ajv.errorsText(entry.answerSpec.errors)}`,
    );
  }
  const problem = entry.def.crossCheck?.(content, answerSpec);
  if (problem) throw new AppError("VALIDATION_ERROR", problem);
}

// ── Tipos v1 ────────────────────────────────────────────────────────────────
registerQuestionType("multiple_choice", {
  contentSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt", "options"],
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 2000 },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 10,
        items: { type: "string", minLength: 1, maxLength: 1000 },
      },
    },
  },
  answerSpecSchema: {
    type: "object",
    additionalProperties: false,
    required: ["correctIndex"],
    properties: { correctIndex: { type: "integer", minimum: 0 } },
  },
  crossCheck: (content, answerSpec) => {
    const c = content as { options: string[] };
    const a = answerSpec as { correctIndex: number };
    return a.correctIndex >= c.options.length
      ? "answerSpec.correctIndex está fuera del rango de options."
      : null;
  },
});

registerQuestionType("true_false", {
  contentSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: { prompt: { type: "string", minLength: 1, maxLength: 2000 } },
  },
  answerSpecSchema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "boolean" } },
  },
});

registerQuestionType("fill_blank", {
  contentSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: { prompt: { type: "string", minLength: 1, maxLength: 2000 } },
  },
  answerSpecSchema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: {
      answer: { type: "string", minLength: 1, maxLength: 1000 },
      caseSensitive: { type: "boolean" },
      accentSensitive: { type: "boolean" },
    },
  },
});
