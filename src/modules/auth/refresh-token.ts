// Refresh token opaco (Spec §5 Auth). No es un JWT: es un secreto aleatorio de
// alta entropía. Al cliente se le entrega en claro una sola vez; en la BD solo
// se guarda su hash SHA-256.
//
// Por qué SHA-256 y no argon2: el token ya tiene 256 bits de entropía (no es
// una clave débil a proteger contra fuerza bruta), así que un hash rápido y
// determinista basta y, además, permite localizarlo por igualdad de hash en el
// refresh (ISSUE-07). Guardar el hash evita que una fuga de BD entregue tokens
// usables.

import { createHash, randomBytes, randomUUID } from "node:crypto";

/** Vida del refresh token (constante documentada y ajustable). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Genera un refresh token opaco url-safe de 256 bits. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Genera el identificador de una sesión (cadena de refresh tokens, ISSUE-07). */
export function generateSessionId(): string {
  return randomUUID();
}

/** Hash determinista (SHA-256 hex) para persistir/localizar el token. */
export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
