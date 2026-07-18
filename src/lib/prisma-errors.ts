// Traducción de errores conocidos de Prisma a errores de dominio (ISSUE-13).
// No importa el runtime de Prisma: hace duck-typing del `.code` (P2003, P2025…)
// para no acoplarse a la clase de error ni al bundling.

import { AppError } from "../plugins/errors.js";

/** True si `err` es un error tipo Prisma con el `code` indicado (p. ej. "P2003"). */
export function isPrismaError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

/**
 * Traduce el P2003 (violación de FK Restrict al borrar un recurso con
 * dependientes) al error de dominio CONFLICT (409). Cualquier otro error se
 * propaga intacto.
 */
export function mapDeleteRestrict(err: unknown, message: string): never {
  if (isPrismaError(err, "P2003")) {
    throw new AppError("CONFLICT", message);
  }
  throw err;
}
