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
  hashRefreshToken,
} from "./refresh-token.js";

/**
 * Mensaje único para credenciales inválidas: idéntico exista o no el email,
 * para no permitir enumeración de usuarios (Spec §6, criterio ISSUE-06).
 */
export const INVALID_CREDENTIALS_MESSAGE = "Email o contraseña incorrectos.";

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
  await deps.persistRefreshToken({
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt: new Date(deps.now().getTime() + REFRESH_TOKEN_TTL_MS),
  });

  return { accessToken, refreshToken };
}

function invalidCredentials(): AppError {
  return new AppError("UNAUTHORIZED", INVALID_CREDENTIALS_MESSAGE);
}
