import { describe, expect, test } from "vitest";
import { levelProgress } from "../../src/modules/progress/summary.js";

// Umbrales de la curva: L1=0, L2=100, L3=300, L4=600.
describe("levelProgress — progreso dentro del nivel", () => {
  test("nivel 1: 0 y 50 XP", () => {
    expect(levelProgress(0)).toEqual({
      level: 1,
      intoLevel: 0,
      forNextLevel: 100,
    });
    expect(levelProgress(50)).toEqual({
      level: 1,
      intoLevel: 50,
      forNextLevel: 100,
    });
  });

  test("nivel 2: al entrar (100) y a mitad (150)", () => {
    expect(levelProgress(100)).toEqual({
      level: 2,
      intoLevel: 0,
      forNextLevel: 200, // 300 - 100
    });
    expect(levelProgress(150)).toEqual({
      level: 2,
      intoLevel: 50,
      forNextLevel: 200,
    });
  });

  test("nivel 3: al entrar (300)", () => {
    expect(levelProgress(300)).toEqual({
      level: 3,
      intoLevel: 0,
      forNextLevel: 300, // 600 - 300
    });
  });
});
