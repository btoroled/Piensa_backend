import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Verificación estática del modelo de progreso y juego (Spec §4, ISSUE-19). Sin
// BD; los constraints reales se ejercitan en progress-game-constraints.test.ts.

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const schema = readFileSync(
  resolve(projectRoot, "prisma", "schema.prisma"),
  "utf8",
);
function modelBlock(name: string): string {
  const m = schema.match(
    new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  if (!m) throw new Error(`No se encontró el modelo ${name}`);
  return m[1] as string;
}

describe("schema.prisma — progreso y juego (ISSUE-19)", () => {
  test("enums XpReason y MasteryLevel con los valores v1", () => {
    expect(schema).toMatch(
      /enum\s+XpReason\s*\{[\s\S]*?lesson_complete[\s\S]*?quiz_passed[\s\S]*?quiz_attempt[\s\S]*?\}/,
    );
    expect(schema).toMatch(
      /enum\s+MasteryLevel\s*\{[\s\S]*?attempted[\s\S]*?familiar[\s\S]*?proficient[\s\S]*?mastered[\s\S]*?\}/,
    );
  });

  test("LessonProgress: único por (alumno, lección), cascade desde el alumno", () => {
    const m = modelBlock("LessonProgress");
    expect(m).toMatch(/@@unique\(\[studentProfileId,\s*lessonId\]\)/);
    expect(m).toMatch(
      /@relation\([^)]*fields:\s*\[studentProfileId\][^)]*onDelete:\s*Cascade[^)]*\)/,
    );
  });

  test("QuizAttempt: answers Json, score/maxScore, sin unique (todos los intentos)", () => {
    const m = modelBlock("QuizAttempt");
    expect(m).toMatch(/answers\s+Json/);
    expect(m).toMatch(/score\s+Int/);
    expect(m).toMatch(/maxScore\s+Int/);
    expect(m).not.toMatch(/@@unique/);
  });

  test("XPEvent: append-only (reason enum, refId, courseId? SetNull), idempotente", () => {
    const m = modelBlock("XPEvent");
    expect(m).toMatch(/amount\s+Int/);
    expect(m).toMatch(/reason\s+XpReason/);
    expect(m).toMatch(/refId\s+String/);
    expect(m).toMatch(/courseId\s+String\?/);
    expect(m).toMatch(
      /@relation\([^)]*fields:\s*\[courseId\][^)]*onDelete:\s*SetNull[^)]*\)/,
    );
    expect(m).toMatch(/@@unique\(\[studentProfileId,\s*reason,\s*refId\]\)/);
  });

  test("Streak único por alumno; Badge.code único; BadgeAward y TopicMastery únicos", () => {
    expect(modelBlock("Streak")).toMatch(/studentProfileId\s+String\s+@unique/);
    expect(modelBlock("Badge")).toMatch(/code\s+String\s+@unique/);
    expect(modelBlock("BadgeAward")).toMatch(
      /@@unique\(\[studentProfileId,\s*badgeId\]\)/,
    );
    const tm = modelBlock("TopicMastery");
    expect(tm).toMatch(/level\s+MasteryLevel/);
    expect(tm).toMatch(/@@unique\(\[studentProfileId,\s*topicId\]\)/);
  });
});
