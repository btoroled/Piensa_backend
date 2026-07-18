import { describe, expect, test } from "vitest";
import {
  isPrismaError,
  mapDeleteRestrict,
} from "../../src/lib/prisma-errors.js";
import { AppError } from "../../src/plugins/errors.js";

describe("isPrismaError", () => {
  test("detecta el código de un error tipo Prisma", () => {
    expect(isPrismaError({ code: "P2003" }, "P2003")).toBe(true);
    expect(isPrismaError({ code: "P2025" }, "P2003")).toBe(false);
    expect(isPrismaError(new Error("x"), "P2003")).toBe(false);
    expect(isPrismaError(null, "P2003")).toBe(false);
  });
});

describe("mapDeleteRestrict", () => {
  test("P2003 → AppError CONFLICT", () => {
    expect(() =>
      mapDeleteRestrict({ code: "P2003" }, "no se puede borrar"),
    ).toThrow(AppError);
    try {
      mapDeleteRestrict({ code: "P2003" }, "no se puede borrar");
    } catch (err) {
      expect((err as AppError).code).toBe("CONFLICT");
    }
  });

  test("otro error se propaga sin tocar", () => {
    const original = { code: "P2025" };
    expect(() => mapDeleteRestrict(original, "x")).toThrow();
    try {
      mapDeleteRestrict(original, "x");
    } catch (err) {
      expect(err).toBe(original);
    }
  });
});
