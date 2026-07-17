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

/**
 * Rol que porta el token. Superconjunto de {@link UserRole}: los alumnos no son
 * `User` (entran por PIN, ISSUE-08) pero también reciben un token con role
 * `student`. Un único par create/verify sirve a los tres roles y ISSUE-09 lo
 * reutiliza para autorizar.
 */
export type TokenRole = UserRole | "student";

/**
 * Datos que viajan en el access token. El sujeto (`sub`) es el `userId` para
 * admin/parent y el `studentProfileId` para alumnos; `role` lo desambigua.
 * `familyId` acompaña a padres y alumnos, nunca a admin.
 */
export interface AccessTokenClaims {
  /** Presente para admin/parent (exclusivo con `studentProfileId`). */
  userId?: string;
  /** Presente para alumnos (exclusivo con `userId`). */
  studentProfileId?: string;
  role: TokenRole;
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
  const subject = claims.userId ?? claims.studentProfileId;
  if (subject === undefined) {
    throw new Error(
      "AccessTokenClaims requiere userId (admin/parent) o studentProfileId (alumno).",
    );
  }
  const payload: Record<string, unknown> = { role: claims.role };
  if (claims.familyId !== undefined) {
    payload.familyId = claims.familyId;
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALG })
    .setSubject(subject)
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

  const role = payload.role as TokenRole;
  const subject = payload.sub as string;
  return {
    userId: role === "student" ? undefined : subject,
    studentProfileId: role === "student" ? subject : undefined,
    role,
    familyId:
      typeof payload.familyId === "string" ? payload.familyId : undefined,
  };
}
