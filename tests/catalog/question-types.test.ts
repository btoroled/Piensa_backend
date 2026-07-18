import { describe, expect, test } from "vitest";
import {
  assertValidQuestion,
  registerQuestionType,
  isRegisteredQuestionType,
} from "../../src/modules/catalog/question-types.js";
import { AppError } from "../../src/plugins/errors.js";

const bad = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    expect((err as AppError).code).toBe("VALIDATION_ERROR");
    return;
  }
  throw new Error("no lanzó VALIDATION_ERROR");
};

describe("questionTypeRegistry — tipos v1", () => {
  test("multiple_choice válido pasa", () => {
    expect(() =>
      assertValidQuestion(
        "multiple_choice",
        { prompt: "¿2+2?", options: ["3", "4"] },
        { correctIndex: 1 },
      ),
    ).not.toThrow();
  });
  test("multiple_choice: correctIndex fuera de rango → error", () => {
    bad(() =>
      assertValidQuestion(
        "multiple_choice",
        { prompt: "?", options: ["a", "b"] },
        { correctIndex: 5 },
      ),
    );
  });
  test("multiple_choice: content sin options → error", () => {
    bad(() =>
      assertValidQuestion(
        "multiple_choice",
        { prompt: "?" },
        { correctIndex: 0 },
      ),
    );
  });
  test("true_false válido pasa; answer no-boolean → error", () => {
    expect(() =>
      assertValidQuestion("true_false", { prompt: "?" }, { answer: true }),
    ).not.toThrow();
    bad(() =>
      assertValidQuestion("true_false", { prompt: "?" }, { answer: "si" }),
    );
  });
  test("fill_blank válido (con flags) pasa; sin answer → error", () => {
    expect(() =>
      assertValidQuestion(
        "fill_blank",
        { prompt: "?" },
        { answer: "parís", accentSensitive: false },
      ),
    ).not.toThrow();
    bad(() => assertValidQuestion("fill_blank", { prompt: "?" }, {}));
  });
  test("tipo no registrado → error", () => {
    bad(() => assertValidQuestion("no_existe", {}, {}));
  });
});

describe("punto de extensión", () => {
  test("registrar un tipo ficticio: el registro lo valida sin cambios de esquema", () => {
    registerQuestionType("fake_slider", {
      contentSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: { prompt: { type: "string", minLength: 1 } },
      },
      answerSpecSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "integer" } },
      },
    });
    expect(isRegisteredQuestionType("fake_slider")).toBe(true);
    expect(() =>
      assertValidQuestion("fake_slider", { prompt: "?" }, { value: 5 }),
    ).not.toThrow();
    bad(() =>
      assertValidQuestion("fake_slider", { prompt: "?" }, { value: "no" }),
    );
  });
});
