import { describe, expect, test } from "vitest";
import { grade, registerGrader } from "../../src/modules/catalog/grading.js";

describe("grading — multiple_choice", () => {
  const spec = { correctIndex: 2 };
  test("índice correcto → correcto, gana los puntos", () => {
    expect(grade("multiple_choice", spec, 2, 5)).toEqual({
      correct: true,
      pointsEarned: 5,
    });
  });
  test("índice incorrecto → incorrecto, 0 puntos", () => {
    expect(grade("multiple_choice", spec, 1, 5)).toEqual({
      correct: false,
      pointsEarned: 0,
    });
  });
  test("respuesta no numérica o spec malformado → incorrecto, sin excepción", () => {
    expect(grade("multiple_choice", spec, "2", 5).correct).toBe(false);
    expect(grade("multiple_choice", {}, 2, 5).correct).toBe(false);
    expect(grade("multiple_choice", null, 2, 5).correct).toBe(false);
  });
});

describe("grading — true_false", () => {
  const spec = { answer: true };
  test("bool correcto/incorrecto", () => {
    expect(grade("true_false", spec, true, 3).correct).toBe(true);
    expect(grade("true_false", spec, false, 3).correct).toBe(false);
  });
  test("no booleano o spec malformado → incorrecto", () => {
    expect(grade("true_false", spec, "true", 3).correct).toBe(false);
    expect(grade("true_false", {}, true, 3).correct).toBe(false);
  });
});

describe("grading — fill_blank", () => {
  test("coincidencia exacta y con trim", () => {
    expect(grade("fill_blank", { answer: "gato" }, "gato", 2).correct).toBe(
      true,
    );
    expect(grade("fill_blank", { answer: "gato" }, "  gato  ", 2).correct).toBe(
      true,
    );
  });
  test("case-insensitive por defecto; caseSensitive lo exige", () => {
    expect(grade("fill_blank", { answer: "Gato" }, "gato", 2).correct).toBe(
      true,
    );
    expect(
      grade("fill_blank", { answer: "Gato", caseSensitive: true }, "gato", 2)
        .correct,
    ).toBe(false);
  });
  test("accent-insensitive por defecto; accentSensitive lo exige", () => {
    expect(grade("fill_blank", { answer: "árbol" }, "arbol", 2).correct).toBe(
      true,
    );
    expect(
      grade(
        "fill_blank",
        { answer: "árbol", accentSensitive: true },
        "arbol",
        2,
      ).correct,
    ).toBe(false);
  });
  test("respuesta no-string o spec malformado → incorrecto", () => {
    expect(grade("fill_blank", { answer: "gato" }, 42, 2).correct).toBe(false);
    expect(grade("fill_blank", {}, "gato", 2).correct).toBe(false);
  });
});

describe("grading — general", () => {
  test("tipo no registrado → incorrecto, 0 puntos, sin excepción", () => {
    expect(grade("no_existe", { a: 1 }, "x", 9)).toEqual({
      correct: false,
      pointsEarned: 0,
    });
  });

  test("punto de extensión: registrar un corrector nuevo sin tocar existentes", () => {
    // Corrector ficticio: correcto si studentAnswer === answerSpec.expected.
    registerGrader("demo_echo", (spec, ans, points) => {
      const expected = (spec as Record<string, unknown>)?.expected;
      const correct = expected === ans;
      return { correct, pointsEarned: correct ? points : 0 };
    });
    expect(grade("demo_echo", { expected: "hi" }, "hi", 7)).toEqual({
      correct: true,
      pointsEarned: 7,
    });
    expect(grade("demo_echo", { expected: "hi" }, "bye", 7).correct).toBe(
      false,
    );
  });
});
