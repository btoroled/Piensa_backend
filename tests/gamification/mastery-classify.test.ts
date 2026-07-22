import { describe, expect, test } from "vitest";
import { classify } from "../../src/modules/gamification/mastery.js";

describe("classify — umbrales de maestría v1", () => {
  test("sin respuestas → null", () => {
    expect(classify(0, 0)).toBeNull();
  });

  test("attempted: ≥1 respuesta pero bajo los demás umbrales", () => {
    expect(classify(1, 1)).toBe("attempted"); // 100% pero total < 5
    expect(classify(2, 5)).toBe("attempted"); // 40%, no llega a familiar
  });

  test("familiar: ≥60% con ≥5, pero no proficient", () => {
    expect(classify(3, 5)).toBe("familiar"); // 60%, total 5
    expect(classify(8, 10)).toBe("proficient"); // control: 80%/10 sí sube
    expect(classify(4, 5)).toBe("familiar"); // 80% pero total 5 < 10
  });

  test("proficient: ≥80% con ≥10, pero no mastered", () => {
    expect(classify(8, 10)).toBe("proficient");
    expect(classify(7, 10)).toBe("familiar"); // 70% baja a familiar
    expect(classify(14, 15)).toBe("proficient"); // 93.3% < 95, total 15
  });

  test("mastered: ≥95% con ≥15", () => {
    expect(classify(15, 15)).toBe("mastered");
    expect(classify(19, 20)).toBe("mastered"); // 95%
    expect(classify(18, 20)).toBe("proficient"); // 90% no llega a mastered
  });

  test("descenso: mismo topic con peor ratio da nivel menor", () => {
    expect(classify(10, 10)).toBe("proficient"); // 100%/10
    expect(classify(6, 10)).toBe("familiar"); // cae a 60%
    expect(classify(3, 10)).toBe("attempted"); // cae a 30%
  });
});
