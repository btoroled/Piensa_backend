// Access token JWT de la API (Spec §5 Auth, §6).
//
// Firmado con HS256 sobre un secreto simétrico (JWT_SECRET). Vida corta de
// 15 minutos: la sesión larga se sostiene con el refresh token rotativo
// (ISSUE-07). Claims mínimos y estables: `sub` = userId, `role` y, si aplica,
// `familyId`. La verificación (hook de autorización) llega en ISSUE-09; aquí se
// exponen `create`/`verify` como funciones puras del secreto para poder
// probar el vencimiento con reloj falso sin levantar Fastify.

import { SignJWT, jwtVerify } from "jose";
import type { UserRole } from "@prisma/client";

/** Duración del access token en segundos (constante documentada y ajustable). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

const ALG = "HS256";

/** Datos que viajan en el access token. `familyId` solo para padres. */
export interface AccessTokenClaims {
  userId: string;
  role: UserRole;
  familyId?: string;
}

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Firma un access token con vencimiento a los {@link ACCESS_TOKEN_TTL_SECONDS}.
 * `iat`/`exp` se calculan contra el reloj del sistema (testeable con timers
 * falsos).
 */
export async function createAccessToken(
  secret: string,
  claims: AccessTokenClaims,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { role: claims.role };
  if (claims.familyId !== undefined) {
    payload.familyId = claims.familyId;
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.userId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + ACCESS_TOKEN_TTL_SECONDS)
    .sign(encodeSecret(secret));
}

/**
 * Verifica firma y vencimiento y devuelve los claims tipados.
 * @throws si el token es inválido, fue manipulado o expiró.
 */
export async function verifyAccessToken(
  secret: string,
  token: string,
): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, encodeSecret(secret), {
    algorithms: [ALG],
  });

  return {
    userId: payload.sub as string,
    role: payload.role as UserRole,
    familyId:
      typeof payload.familyId === "string" ? payload.familyId : undefined,
  };
}
