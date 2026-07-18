// Reglas de dominio de las preguntas del catálogo (Spec §4). Sin acoplarse a
// Fastify ni a Prisma: funciones puras que el CRUD (ISSUE-15) invoca.

import type { LessonType } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";

/**
 * Una Question solo puede colgar de una Lesson tipo `quiz` (criterio ISSUE-12).
 * PostgreSQL no puede restringir por el tipo de la fila padre, así que la regla
 * se valida en la capa de servicio antes de crear la pregunta.
 *
 * Lanza `AppError("VALIDATION_ERROR")` si la lección no es un quiz.
 */
export function assertLessonAcceptsQuestions(lesson: {
  type: LessonType;
}): void {
  if (lesson.type !== "quiz") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Solo las lecciones de tipo quiz pueden tener preguntas.",
    );
  }
}
