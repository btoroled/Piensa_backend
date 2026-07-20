import { describe, expect, test } from "vitest";
import { wouldCreatePrereqCycle } from "../../src/modules/catalog/courses.js";

// Grafo de prereqs en memoria: id → prerrequisitos directos.
const graph: Record<string, string[]> = {
  a: [], // 1° (sin prereq)
  b: ["a"], // 2° requiere 1°
  c: ["b"], // 3° requiere 2°
};
const getRequires = async (id: string) => graph[id] ?? [];

describe("wouldCreatePrereqCycle", () => {
  test("agregar una arista que no cierra ciclo → false", async () => {
    expect(await wouldCreatePrereqCycle(getRequires, "a", "d")).toBe(false);
  });
  test("auto-prerrequisito (A requiere A) → true", async () => {
    expect(await wouldCreatePrereqCycle(getRequires, "a", "a")).toBe(true);
  });
  test("cerrar el ciclo (1° requiere 3°, con 3°→2°→1°) → true", async () => {
    expect(await wouldCreatePrereqCycle(getRequires, "a", "c")).toBe(true);
  });
  test("ciclo directo (1° requiere 2°, con 2°→1°) → true", async () => {
    expect(await wouldCreatePrereqCycle(getRequires, "a", "b")).toBe(true);
  });
});
