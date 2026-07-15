// Hashing de contraseñas de padres/admin (Spec §6: "contraseñas con argon2").
//
// Se usa @node-rs/argon2 (binding nativo con binarios precompilados vía N-API):
// evita compilar con node-gyp en CI y es agnóstico a la versión de Node. La
// variante por defecto de la librería es argon2id, la recomendada por OWASP.
// Los parámetros por defecto (memoria/iteraciones) son seguros para v1 y quedan
// centralizados aquí por si se ajustan más adelante.

import { hash, verify } from "@node-rs/argon2";

/** Deriva un hash argon2id (salteado) de una contraseña en claro. */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

/**
 * Verifica una contraseña contra su hash. Un hash malformado o cualquier fallo
 * de verificación resuelve `false` (nunca lanza): quien llama trata todo fallo
 * de credenciales igual, sin distinguir causas.
 */
export async function verifyPassword(
  hashStored: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(hashStored, plain);
  } catch {
    return false;
  }
}
