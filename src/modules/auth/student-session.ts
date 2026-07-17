// Sesión de alumno por PIN (ISSUE-08, Spec §2 Alumnos, §5 Auth, §6).
//
// Un alumno no es `User`: el padre autenticado abre una sesión de alumno sobre
// un `StudentProfile` propio presentando su PIN de 4 dígitos. Se emite un token
// de vida corta con role `student` (los TTL/claims viven en tokens.ts).
//
// Igual que el login (service.ts), la lógica recibe sus dependencias (repo,
// reloj, secreto) para probarse en memoria; el plugin de rutas la cablea contra
// Prisma y resuelve la familia del padre desde la BD.

import { AppError } from "../../plugins/errors.js";
import { verifyPassword } from "./password.js";
import { createAccessToken } from "./tokens.js";

/** Fallos consecutivos que bloquean el PIN (constante documentada y ajustable). */
export const MAX_PIN_ATTEMPTS = 5;

/** Duración del bloqueo del PIN tras agotar los intentos. */
export const PIN_LOCK_MS = 15 * 60 * 1000;

/**
 * Mensaje único para cualquier fallo de PIN (incorrecto o bloqueado): no revela
 * cuántos intentos quedan ni si el PIN está bloqueado (Spec §6, ISSUE-08).
 */
export const INVALID_PIN_MESSAGE = "PIN incorrecto.";

/** Mensaje de pertenencia: perfil ajeno o inexistente, sin distinguir cuál. */
export const FORBIDDEN_PROFILE_MESSAGE =
  "No tienes permiso para este perfil de alumno.";

/** Vista mínima del StudentProfile que necesita la apertura de sesión. */
export interface StudentProfileRecord {
  id: string;
  familyId: string;
  pinHash: string;
  failedPinAttempts: number;
  pinLockedUntil: Date | null;
}

/** Nuevo estado de intentos/bloqueo del PIN a persistir. */
export interface PinState {
  failedPinAttempts: number;
  pinLockedUntil: Date | null;
}

/** Dependencias de la sesión de alumno, inyectadas para probar sin BD. */
export interface StudentSessionDeps {
  jwtSecret: string;
  now: () => Date;
  findStudentProfile: (id: string) => Promise<StudentProfileRecord | null>;
  updatePinState: (id: string, state: PinState) => Promise<void>;
}

export interface StudentSessionInput {
  /** Familia del padre autenticado, resuelta contra la BD (no desde el token). */
  parentFamilyId: string;
  studentProfileId: string;
  pin: string;
}

export interface StudentSessionResult {
  accessToken: string;
}

/**
 * Abre una sesión de alumno: valida pertenencia y PIN, aplica el bloqueo por
 * intentos y emite un token de alumno (role `student`, 15 min).
 * @throws {AppError} FORBIDDEN si el perfil no existe o no es de la familia del
 *   padre — mismo error en ambos casos, para no revelar existencia.
 * @throws {AppError} INVALID_PIN si el PIN es incorrecto o está bloqueado —
 *   mismo error en ambos casos, sin revelar intentos restantes.
 */
export async function createStudentSession(
  deps: StudentSessionDeps,
  input: StudentSessionInput,
): Promise<StudentSessionResult> {
  const profile = await deps.findStudentProfile(input.studentProfileId);

  // Perfil inexistente o de otra familia: pertenencia verificada contra la BD.
  if (!profile || profile.familyId !== input.parentFamilyId) {
    throw forbiddenProfile();
  }

  const now = deps.now();

  // PIN bloqueado: se rechaza sin verificarlo, con el mismo INVALID_PIN.
  if (
    profile.pinLockedUntil !== null &&
    profile.pinLockedUntil.getTime() > now.getTime()
  ) {
    throw invalidPin();
  }

  const ok = await verifyPassword(profile.pinHash, input.pin);
  if (!ok) {
    const failedPinAttempts = profile.failedPinAttempts + 1;
    const locked = failedPinAttempts >= MAX_PIN_ATTEMPTS;
    await deps.updatePinState(profile.id, {
      failedPinAttempts,
      pinLockedUntil: locked ? new Date(now.getTime() + PIN_LOCK_MS) : null,
    });
    throw invalidPin();
  }

  // Acierto: el contador se resetea (también tras un desbloqueo) y se emite el
  // token de alumno con su perfil y familia.
  await deps.updatePinState(profile.id, {
    failedPinAttempts: 0,
    pinLockedUntil: null,
  });

  const accessToken = await createAccessToken(deps.jwtSecret, {
    studentProfileId: profile.id,
    role: "student",
    familyId: profile.familyId,
  });

  return { accessToken };
}

function invalidPin(): AppError {
  return new AppError("INVALID_PIN", INVALID_PIN_MESSAGE);
}

function forbiddenProfile(): AppError {
  return new AppError("FORBIDDEN", FORBIDDEN_PROFILE_MESSAGE);
}
