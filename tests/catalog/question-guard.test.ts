import { describe, expect, test } from "vitest";
import { assertLessonAcceptsQuestions } from "../../src/modules/catalog/questions.js";
import { AppError } from "../../src/plugins/errors.js";

// Regla de servicio (Spec §4, criterio ISSUE-12): una Question solo puede colgar
// de una Lesson tipo `quiz`. La DB no puede expresar "el tipo de la fila padre",
// así que se valida acá; ISSUE-15 la usa antes de crear cada pregunta.

describe("assertLessonAcceptsQuestions", () => {
  test("una lección quiz acepta preguntas (no lanza)", () => {
    expect(() => assertLessonAcceptsQuestions({ type: "quiz" })).not.toThrow();
  });

  test.each(["video", "reading"] as const)(
    "una lección %s rechaza preguntas con VALIDATION_ERROR",
    (type) => {
      let thrown: unknown;
      try {
        assertLessonAcceptsQuestions({ type });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    },
  );
});
