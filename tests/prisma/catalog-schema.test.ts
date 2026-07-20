import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Verificación estática del modelo del catálogo (Spec §4, ISSUE-12). No requiere
// base de datos: audita que el schema declare los modelos, enums, unicidad y
// reglas de borrado exigidas. Los constraints reales se ejercitan contra la BD
// en catalog-constraints.test.ts (corre en CI).

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const schema = readFileSync(
  resolve(projectRoot, "prisma", "schema.prisma"),
  "utf8",
);

function modelBlock(name: string): string {
  const match = schema.match(
    new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  if (!match) {
    throw new Error(`No se encontró el modelo ${name} en schema.prisma`);
  }
  return match[1] as string;
}

describe("schema.prisma — modelo del catálogo", () => {
  test("declara el enum de tipo de lección con los valores del spec", () => {
    expect(schema).toMatch(
      /enum\s+LessonType\s*\{[\s\S]*?video[\s\S]*?reading[\s\S]*?quiz[\s\S]*?\}/,
    );
    // QuestionType dejó de ser enum: es el punto de extensión, la columna es
    // String y el registro (ISSUE-15) valida el tipo. No debe haber enum.
    expect(schema).not.toMatch(/enum\s+QuestionType/);
  });

  test("Week cuelga de Course con borrado restringido y número único por curso (M2.5)", () => {
    const week = modelBlock("Week");
    expect(week).toMatch(/courseId\s+String/);
    expect(week).toMatch(/title\s+String/);
    expect(week).toMatch(/description\s+String\?/);
    expect(week).toMatch(
      /@relation\([^)]*fields:\s*\[courseId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
    expect(week).toMatch(/@@unique\(\[courseId,\s*number\]\)/);
  });

  test("materias, cursos, prerrequisitos e inscripción (Milestone 2.5)", () => {
    const subject = modelBlock("Subject");
    expect(subject).toMatch(/name\s+String\s+@unique/);

    const course = modelBlock("Course");
    expect(course).toMatch(/@@unique\(\[subjectId,\s*gradeId\]\)/);
    expect(course).toMatch(
      /@relation\([^)]*fields:\s*\[subjectId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
    expect(course).toMatch(
      /@relation\([^)]*fields:\s*\[gradeId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );

    const prereq = modelBlock("CoursePrerequisite");
    expect(prereq).toMatch(/@@id\(\[courseId,\s*requiresCourseId\]\)/);
    // Cascade hacia el curso dueño de la arista; Restrict hacia el requerido.
    expect(prereq).toMatch(
      /@relation\([^)]*"CourseToPrereq"[^)]*onDelete:\s*Cascade[^)]*\)/,
    );
    expect(prereq).toMatch(
      /@relation\([^)]*"PrereqToCourse"[^)]*onDelete:\s*Restrict[^)]*\)/,
    );

    const studentSubject = modelBlock("StudentSubject");
    expect(studentSubject).toMatch(/@@id\(\[studentProfileId,\s*subjectId\]\)/);

    // Grade pasa a ser el año/nivel: gana `level` para ordenar años.
    const grade = modelBlock("Grade");
    expect(grade).toMatch(/level\s+Int\s+@unique/);
  });

  test("Lesson cuelga de Week (Restrict), tipa el type y guarda campos por tipo nullable", () => {
    const lesson = modelBlock("Lesson");
    expect(lesson).toMatch(/type\s+LessonType/);
    // Campos específicos por tipo: nullable, no un blob JSON.
    expect(lesson).toMatch(/embedUrl\s+String\?/);
    expect(lesson).toMatch(/richContent\s+String\?/);
    expect(lesson).toMatch(/fileKey\s+String\?/);
    expect(lesson).toMatch(
      /@relation\([^)]*fields:\s*\[weekId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
    // order único por semana.
    expect(lesson).toMatch(/@@unique\(\[weekId,\s*order\]\)/);
  });

  test("Question cuelga de Lesson (Restrict), con content/answerSpec JSON y order único por lección", () => {
    const question = modelBlock("Question");
    expect(question).toMatch(/type\s+String/);
    expect(question).toMatch(/content\s+Json/);
    expect(question).toMatch(/answerSpec\s+Json/);
    expect(question).toMatch(/points\s+Int/);
    expect(question).toMatch(
      /@relation\([^)]*fields:\s*\[lessonId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
    expect(question).toMatch(/@@unique\(\[lessonId,\s*order\]\)/);
  });

  test("Topic tiene name único; las tablas de etiquetado son join explícitos", () => {
    const topic = modelBlock("Topic");
    expect(topic).toMatch(/name\s+String\s+@unique/);

    const lessonTopic = modelBlock("LessonTopic");
    expect(lessonTopic).toMatch(/@@id\(\[lessonId,\s*topicId\]\)/);
    // El link muere con su lección (Cascade) pero protege al topic (Restrict).
    expect(lessonTopic).toMatch(
      /@relation\([^)]*fields:\s*\[lessonId\][^)]*onDelete:\s*Cascade[^)]*\)/,
    );
    expect(lessonTopic).toMatch(
      /@relation\([^)]*fields:\s*\[topicId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );

    const questionTopic = modelBlock("QuestionTopic");
    expect(questionTopic).toMatch(/@@id\(\[questionId,\s*topicId\]\)/);
    expect(questionTopic).toMatch(
      /@relation\([^)]*fields:\s*\[questionId\][^)]*onDelete:\s*Cascade[^)]*\)/,
    );
    expect(questionTopic).toMatch(
      /@relation\([^)]*fields:\s*\[topicId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
  });

  test("StudentProfile.gradeId queda cableado como FK a Grade con borrado restringido", () => {
    const profile = modelBlock("StudentProfile");
    // Sigue nullable (se asigna después), pero ahora es una relación real.
    expect(profile).toMatch(/gradeId\s+String\?/);
    expect(profile).toMatch(
      /@relation\([^)]*fields:\s*\[gradeId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
  });
});
