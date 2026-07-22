import { describe, expect, test } from "vitest";
import {
  isValidTimeZone,
  localDate,
} from "../../src/modules/gamification/streak.js";

describe("localDate — día calendario en la zona de la familia (DST-safe)", () => {
  const LIMA = "America/Lima"; // UTC-5, sin horario de verano

  test("23:59 y 00:01 del día siguiente son fechas locales distintas", () => {
    const a = new Date("2026-07-21T23:59:00-05:00");
    const b = new Date("2026-07-22T00:01:00-05:00");
    expect(localDate(a, LIMA)).toBe("2026-07-21");
    expect(localDate(b, LIMA)).toBe("2026-07-22");
  });

  test("cruce de medianoche UTC vs local: mismo instante, distinto día", () => {
    // 2026-07-22T02:00Z = 2026-07-21 21:00 en Lima (UTC-5).
    const instant = new Date("2026-07-22T02:00:00Z");
    expect(localDate(instant, "UTC")).toBe("2026-07-22");
    expect(localDate(instant, LIMA)).toBe("2026-07-21");
  });
});

describe("isValidTimeZone", () => {
  test("acepta zonas IANA válidas", () => {
    expect(isValidTimeZone("America/Lima")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Madrid")).toBe(true);
  });
  test("rechaza basura", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("America/Nowhere")).toBe(false);
  });
});
