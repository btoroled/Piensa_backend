import { describe, expect, test } from "vitest";
import { assertValidLessonPayload } from "../../src/modules/catalog/lessons.js";
import { AppError } from "../../src/plugins/errors.js";

const bad = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("VALIDATION_ERROR");
    return;
  }
  throw new Error("no lanzó VALIDATION_ERROR");
};

describe("assertValidLessonPayload", () => {
  test("video: embedUrl válido pasa", () => {
    expect(() =>
      assertValidLessonPayload("video", { embedUrl: "https://x.test/v" }),
    ).not.toThrow();
  });
  test("video sin embedUrl → error", () => {
    bad(() => assertValidLessonPayload("video", {}));
  });
  test("video con fileKey (cruzado) → error", () => {
    bad(() =>
      assertValidLessonPayload("video", {
        embedUrl: "https://x.test/v",
        fileKey: "k",
      }),
    );
  });

  test("reading con richContent pasa", () => {
    expect(() =>
      assertValidLessonPayload("reading", { richContent: "Hola" }),
    ).not.toThrow();
  });
  test("reading con fileKey pasa", () => {
    expect(() =>
      assertValidLessonPayload("reading", { fileKey: "lessons/x.pdf" }),
    ).not.toThrow();
  });
  test("reading vacío → error", () => {
    bad(() => assertValidLessonPayload("reading", {}));
  });
  test("reading con embedUrl (cruzado) → error", () => {
    bad(() =>
      assertValidLessonPayload("reading", {
        richContent: "Hola",
        embedUrl: "https://x.test/v",
      }),
    );
  });

  test("quiz vacío pasa", () => {
    expect(() => assertValidLessonPayload("quiz", {})).not.toThrow();
  });
  test("quiz con cualquier campo → error", () => {
    bad(() =>
      assertValidLessonPayload("quiz", { embedUrl: "https://x.test/v" }),
    );
    bad(() => assertValidLessonPayload("quiz", { fileKey: "k" }));
  });
});
