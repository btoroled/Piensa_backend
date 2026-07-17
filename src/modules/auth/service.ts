// Lógica de login de padre/admin (Spec §5 Auth, §6). Sin acoplarse a Fastify ni
// a Prisma: recibe sus dependencias (repositorio, reloj, secreto) para poder
// probarse en memoria. El plugin de rutas (routes.ts) las cablea contra Prisma.

import type { UserRole } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import { createAccessToken } from "./tokens.js";
import {
  REFRESH_TOKEN_TTL_MS,
  generateRefreshToken,
  generateSessionId,
  hashRefreshToken,
} from "./refresh-token.js";

/**
 * Mensaje único para credenciales inválidas: idéntico exista o no el email,
 * para no permitir enumeración de usuarios (Spec §6, criterio ISSUE-06).
 */
export const INVALID_CREDENTIALS_MESSAGE = "Email o contraseña incorrectos.";

/**
 * Mensaje único para cualquier fallo de refresh (token ausente, inválido,
 * expirado o revocado): no revela por qué falló ni si hubo detección de robo.
 */
export const INVALID_REFRESH_MESSAGE = "Sesión inválida o expirada.";

/** Vista mínima del User que necesita el login. */
export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
}

/** Datos que el login persiste por cada refresh token emitido. */
export interface PersistRefreshTokenInput {
  userId: string;
  tokenHash: string;
  /** Sesión (cadena de rotación) a la que pertenece este token (ISSUE-07). */
  sessionId: string;
  expiresAt: Date;
}

/** Dependencias del login, inyectadas para poder probarlo sin BD. */
export interface AuthDeps {
  jwtSecret: string;
  now: () => Date;
  findUserByEmail: (email: string) => Promise<UserRecord | null>;
  /** familyId del padre, o null si no aplica (p. ej. admin). */
  findParentFamilyId: (userId: string) => Promise<string | null>;
  persistRefreshToken: (input: PersistRefreshTokenInput) => Promise<void>;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
}

// Hash argon2id "señuelo" precalculado una sola vez. Cuando el email no existe
// se verifica igualmente contra él para no revelar por tiempo de respuesta si
// la cuenta existe (defensa de temporización sobre el criterio de no
// enumeración).
let decoyHash: Promise<string> | undefined;
function getDecoyHash(): Promise<string> {
  decoyHash ??= hashPassword("decoy-password-not-used-anywhere");
  return decoyHash;
}

/**
 * Autentica a un padre/admin por email + contraseña. Devuelve un access token
 * JWT (15 min) y un refresh token opaco (persistido hasheado).
 * @throws {AppError} UNAUTHORIZED con {@link INVALID_CREDENTIALS_MESSAGE} si las
 *   credenciales no son válidas — mismo mensaje exista o no el email.
 */
export async function login(
  deps: AuthDeps,
  input: LoginInput,
): Promise<LoginResult> {
  const user = await deps.findUserByEmail(input.email);

  if (!user) {
    // Trabajo equivalente al de una verificación real para igualar tiempos.
    await verifyPassword(await getDecoyHash(), input.password);
    throw invalidCredentials();
  }

  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) {
    throw invalidCredentials();
  }

  const familyId =
    user.role === "parent"
      ? ((await deps.findParentFamilyId(user.id)) ?? undefined)
      : undefined;

  const accessToken = await createAccessToken(deps.jwtSecret, {
    userId: user.id,
    role: user.role,
    familyId,
  });

  const refreshToken = generateRefreshToken();
  // Cada login abre una sesión nueva: su primer refresh token la inaugura.
  await deps.persistRefreshToken({
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    sessionId: generateSessionId(),
    expiresAt: new Date(deps.now().getTime() + REFRESH_TOKEN_TTL_MS),
  });

  return { accessToken, refreshToken };
}

function invalidCredentials(): AppError {
  return new AppError("UNAUTHORIZED", INVALID_CREDENTIALS_MESSAGE);
}

// --- Refresh con rotación y detección de robo (ISSUE-07, Spec §5 Auth, §6) ---

/** Vista mínima del refresh token persistido que necesita la rotación. */
export interface RefreshTokenRecord {
  id: string;
  sessionId: string;
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date;
}

/** Vista mínima del User para reemitir el access token. */
export interface RefreshUserRecord {
  id: string;
  role: UserRole;
}

/** Datos de una rotación atómica: revoca el token viejo e inserta el nuevo. */
export interface RotateInput {
  oldTokenId: string;
  sessionId: string;
  userId: string;
  newTokenHash: string;
  expiresAt: Date;
  now: Date;
}

/** Dependencias del refresh, inyectadas para poder probarlo sin BD. */
export interface RefreshDeps {
  jwtSecret: string;
  now: () => Date;
  findRefreshTokenByHash: (
    tokenHash: string,
  ) => Promise<RefreshTokenRecord | null>;
  findUserById: (userId: string) => Promise<RefreshUserRecord | null>;
  findParentFamilyId: (userId: string) => Promise<string | null>;
  /** Marca el token viejo como revocado e inserta el nuevo, atómicamente. */
  rotate: (input: RotateInput) => Promise<void>;
  /** Revoca todos los refresh vivos de una sesión (detección de robo). */
  revokeSession: (sessionId: string, now: Date) => Promise<void>;
}

export interface RefreshInput {
  refreshToken: string;
}

/**
 * Rota un refresh token: valida el vigente, emite un par nuevo e invalida el
 * anterior. Reusar un token ya rotado revoca toda la cadena de la sesión
 * (detección de robo).
 * @throws {AppError} UNAUTHORIZED con {@link INVALID_REFRESH_MESSAGE} ante
 *   cualquier token ausente, inválido, expirado o revocado.
 */
export async function refresh(
  deps: RefreshDeps,
  input: RefreshInput,
): Promise<LoginResult> {
  const record = await deps.findRefreshTokenByHash(
    hashRefreshToken(input.refreshToken),
  );
  if (!record) {
    throw invalidRefresh();
  }

  const now = deps.now();

  // Reuso de un token ya revocado/rotado: posible robo. Se revoca la cadena
  // entera de esa sesión y se rechaza.
  if (record.revokedAt !== null) {
    await deps.revokeSession(record.sessionId, now);
    throw invalidRefresh();
  }

  if (record.expiresAt.getTime() <= now.getTime()) {
    throw invalidRefresh();
  }

  const user = await deps.findUserById(record.userId);
  if (!user) {
    throw invalidRefresh();
  }

  const familyId =
    user.role === "parent"
      ? ((await deps.findParentFamilyId(user.id)) ?? undefined)
      : undefined;

  const newRefreshToken = generateRefreshToken();
  await deps.rotate({
    oldTokenId: record.id,
    sessionId: record.sessionId,
    userId: user.id,
    newTokenHash: hashRefreshToken(newRefreshToken),
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    now,
  });

  const accessToken = await createAccessToken(deps.jwtSecret, {
    userId: user.id,
    role: user.role,
    familyId,
  });

  return { accessToken, refreshToken: newRefreshToken };
}

function invalidRefresh(): AppError {
  return new AppError("UNAUTHORIZED", INVALID_REFRESH_MESSAGE);
}
