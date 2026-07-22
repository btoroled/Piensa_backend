import { describe, expect, test } from "vitest";
import { computeLessonStatuses } from "../../src/modules/progress/path.js";

// Semanas de ejemplo: semana 1 [l1,l2], semana 2 [l3,l4].
const weeks = [
  { lessons: [{ id: "l1" }, { id: "l2" }] },
  { lessons: [{ id: "l3" }, { id: "l4" }] },
];

describe("computeLessonStatuses — desbloqueo por curso", () => {
  test("alumno nuevo: solo la 1ª lección de la semana 1 available", () => {
    const s = computeLessonStatuses(weeks, new Set());
    expect(s.get("l1")).toBe("available");
    expect(s.get("l2")).toBe("locked");
    expect(s.get("l3")).toBe("locked");
    expect(s.get("l4")).toBe("locked");
  });

  test("completar en orden desbloquea la siguiente lección", () => {
    const s = computeLessonStatuses(weeks, new Set(["l1"]));
    expect(s.get("l1")).toBe("completed");
    expect(s.get("l2")).toBe("available");
    expect(s.get("l3")).toBe("locked");
  });

  test("la semana 2 sigue bloqueada hasta completar toda la semana 1", () => {
    const s = computeLessonStatuses(weeks, new Set(["l1", "l2"]));
    expect(s.get("l2")).toBe("completed");
    expect(s.get("l3")).toBe("available"); // semana 2 abierta, 1ª lección
    expect(s.get("l4")).toBe("locked");
  });

  test("una semana vacía no bloquea la siguiente", () => {
    const s = computeLessonStatuses(
      [{ lessons: [] }, { lessons: [{ id: "x" }] }],
      new Set(),
    );
    expect(s.get("x")).toBe("available");
  });
});
