// Lógica de dominio de los cursos (ISSUE-37). Detección de ciclos en el grafo de
// prerrequisitos: pura, recibe una función para leer los prereqs directos.

/**
 * ¿Agregar "courseId requiere requiresCourseId" crearía un ciclo? Se forma un
 * ciclo si requiresCourseId ya alcanza (transitivamente) a courseId por sus
 * prerrequisitos, o si son el mismo curso. `getRequires` devuelve los
 * prerrequisitos directos de un curso.
 */
export async function wouldCreatePrereqCycle(
  getRequires: (courseId: string) => Promise<string[]>,
  courseId: string,
  requiresCourseId: string,
): Promise<boolean> {
  if (courseId === requiresCourseId) return true;
  const seen = new Set<string>();
  const stack: string[] = [requiresCourseId];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === courseId) return true; // requiresCourseId alcanza a courseId.
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of await getRequires(cur)) stack.push(r);
  }
  return false;
}
