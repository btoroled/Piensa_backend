import { describe, expect, test } from "vitest";
import {
  UUID_PATTERN,
  EMAIL_PATTERN,
  PIN_PATTERN,
} from "../../src/lib/validation.js";

const matches = (pattern: string, value: string) =>
  new RegExp(pattern).test(value);

describe("UUID_PATTERN", () => {
  test("acepta un UUID válido (minúsculas y mayúsculas)", () => {
    expect(matches(UUID_PATTERN, "3f1d2c4b-5a6e-7f80-9123-abcdef012345")).toBe(
      true,
    );
    expect(matches(UUID_PATTERN, "3F1D2C4B-5A6E-7F80-9123-ABCDEF012345")).toBe(
      true,
    );
  });
  test("rechaza basura, prefijos/sufijos y strings vacíos (anclado)", () => {
    expect(matches(UUID_PATTERN, "no-uuid")).toBe(false);
    expect(matches(UUID_PATTERN, " 3f1d2c4b-5a6e-7f80-9123-abcdef012345")).toBe(
      false,
    );
    expect(
      matches(UUID_PATTERN, "3f1d2c4b-5a6e-7f80-9123-abcdef012345;DROP"),
    ).toBe(false);
    expect(matches(UUID_PATTERN, "")).toBe(false);
  });
});

describe("EMAIL_PATTERN", () => {
  test("acepta un email conservador", () => {
    expect(matches(EMAIL_PATTERN, "ana@piensa.test")).toBe(true);
  });
  test("rechaza sin arroba, con espacios o sin dominio", () => {
    expect(matches(EMAIL_PATTERN, "ana-piensa.test")).toBe(false);
    expect(matches(EMAIL_PATTERN, "ana @piensa.test")).toBe(false);
    expect(matches(EMAIL_PATTERN, "ana@")).toBe(false);
  });
});

describe("PIN_PATTERN", () => {
  test("acepta exactamente 4 dígitos", () => {
    expect(matches(PIN_PATTERN, "0421")).toBe(true);
  });
  test("rechaza longitudes distintas o no-dígitos", () => {
    expect(matches(PIN_PATTERN, "042")).toBe(false);
    expect(matches(PIN_PATTERN, "04210")).toBe(false);
    expect(matches(PIN_PATTERN, "04a1")).toBe(false);
  });
});
