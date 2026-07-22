// Camino del alumno (ISSUE-20): cálculo puro del estado de desbloqueo. Regla v1:
// la semana 1 está abierta; la semana N+1 se abre al completar la N; dentro de
// una semana abierta, las lecciones se desbloquean en orden. Una lección
// completada es la que tiene LessonProgress.

export type LessonStatus = "locked" | "available" | "completed";

/** Estado de cada lección (por id) dadas las semanas ORDENADAS de un curso (con
 *  sus lecciones ORDENADAS) y el conjunto de lecciones completadas. */
export function computeLessonStatuses(
  weeks: { lessons: { id: string }[] }[],
  completed: ReadonlySet<string>,
): Map<string, LessonStatus> {
  const status = new Map<string, LessonStatus>();
  let weekUnlocked = true;
  for (const week of weeks) {
    if (weekUnlocked) {
      // La primera lección no completada de la semana queda `available`; las
      // posteriores, `locked` hasta completarla.
      let prevDone = true;
      for (const lesson of week.lessons) {
        if (completed.has(lesson.id)) {
          status.set(lesson.id, "completed");
        } else if (prevDone) {
          status.set(lesson.id, "available");
          prevDone = false;
        } else {
          status.set(lesson.id, "locked");
        }
      }
      // La siguiente semana se abre solo si esta quedó completa (vacía = completa).
      weekUnlocked = week.lessons.every((l) => completed.has(l.id));
    } else {
      for (const lesson of week.lessons) status.set(lesson.id, "locked");
    }
  }
  return status;
}
