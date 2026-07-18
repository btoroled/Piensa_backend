// Lógica de dominio de las lecciones del catálogo (ISSUE-14). Funciones puras /
// de servicio, sin acoplarse a Fastify. El validador de payload por tipo y el
// reordenamiento atómico viven acá; las rutas (routes.ts) las cablean.

import type { LessonType, PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";

/** Campos de contenido de una lección; solo aplica el del `type`. */
export interface LessonPayload {
  embedUrl?: string;
  richContent?: string;
  fileKey?: string;
}

const present = (v?: string): boolean => v !== undefined && v !== null;

/**
 * Valida que el payload coincida con el tipo (criterio ISSUE-14):
 * - video   → requiere embedUrl; nada de richContent/fileKey.
 * - reading → al menos uno de richContent/fileKey; nada de embedUrl.
 * - quiz    → ningún campo de contenido (se crea vacío).
 * Lanza VALIDATION_ERROR si no cumple.
 */
export function assertValidLessonPayload(
  type: LessonType,
  p: LessonPayload,
): void {
  if (type === "video") {
    if (!present(p.embedUrl))
      throw new AppError(
        "VALIDATION_ERROR",
        "Una lección de video requiere embedUrl.",
      );
    if (present(p.richContent) || present(p.fileKey))
      throw new AppError(
        "VALIDATION_ERROR",
        "Una lección de video solo admite embedUrl.",
      );
    return;
  }
  if (type === "reading") {
    if (!present(p.richContent) && !present(p.fileKey))
      throw new AppError(
        "VALIDATION_ERROR",
        "Una lección de lectura requiere richContent o fileKey.",
      );
    if (present(p.embedUrl))
      throw new AppError(
        "VALIDATION_ERROR",
        "Una lección de lectura no admite embedUrl.",
      );
    return;
  }
  // quiz
  if (present(p.embedUrl) || present(p.richContent) || present(p.fileKey))
    throw new AppError(
      "VALIDATION_ERROR",
      "Una lección de quiz no admite campos de contenido.",
    );
}

/**
 * Reordena las lecciones de una semana (ISSUE-14). `orderedIds` debe ser
 * EXACTAMENTE el conjunto de lecciones de la semana (ni ajenas ni faltantes) o
 * se rechaza entero (VALIDATION_ERROR), sin tocar nada. Se aplica en dos fases
 * dentro de una transacción para no chocar con @@unique([weekId, order]):
 * primero a órdenes temporales negativos, luego a 1..N.
 */
export async function reorderLessons(
  prisma: PrismaClient,
  weekId: string,
  orderedIds: string[],
): Promise<void> {
  const current = await prisma.lesson.findMany({
    where: { weekId },
    select: { id: true },
  });
  const currentIds = new Set(current.map((l) => l.id));
  const sameSize = currentIds.size === orderedIds.length;
  const allBelong = orderedIds.every((id) => currentIds.has(id));
  if (!sameSize || !allBelong) {
    throw new AppError(
      "VALIDATION_ERROR",
      "La lista debe ser exactamente las lecciones de la semana.",
    );
  }
  await prisma.$transaction([
    // Fase 1: órdenes temporales negativos (sin colisión con los positivos).
    ...orderedIds.map((id, i) =>
      prisma.lesson.update({ where: { id }, data: { order: -(i + 1) } }),
    ),
    // Fase 2: órdenes finales 1..N según la posición en orderedIds.
    ...orderedIds.map((id, i) =>
      prisma.lesson.update({ where: { id }, data: { order: i + 1 } }),
    ),
  ]);
}
