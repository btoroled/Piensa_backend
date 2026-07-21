import { describe, expect, test } from "vitest";
import { getLevel } from "../../src/modules/gamification/xp.js";

describe("getLevel — curva v1 (umbral(N)=50·N·(N+1))", () => {
  test("alumno nuevo empieza en Nivel 1", () => {
    expect(getLevel(0)).toBe(1);
    expect(getLevel(99)).toBe(1);
  });
  test("límites exactos entre niveles", () => {
    expect(getLevel(100)).toBe(2); // umbral(1)=100
    expect(getLevel(299)).toBe(2);
    expect(getLevel(300)).toBe(3); // umbral(2)=300
    expect(getLevel(599)).toBe(3);
    expect(getLevel(600)).toBe(4); // umbral(3)=600
    expect(getLevel(999)).toBe(4);
    expect(getLevel(1000)).toBe(5); // umbral(4)=1000
  });
});
