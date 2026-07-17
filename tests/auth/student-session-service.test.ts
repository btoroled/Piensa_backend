import { beforeEach, describe, expect, test } from "vitest";
import { AppError } from "../../src/plugins/errors.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import { verifyAccessToken } from "../../src/modules/auth/tokens.js";
import {
  MAX_PIN_ATTEMPTS,
  PIN_LOCK_MS,
  createStudentSession,
  type StudentProfileRecord,
  type StudentSessionDeps,
} from "../../src/modules/auth/student-session.js";

// Lógica de sesión de alumno por PIN (ISSUE-08, Spec §2 §5 §6) probada en
// memoria: deps inyectadas, sin Fastify ni Prisma. La pertenencia se verifica
// comparando la familia del perfil con la del padre autenticado.

const SECRET = "test-secret-at-least-16-chars-long";
const CORRECT_PIN = "1234";
const FAMILY = "family-del-padre";
const NOW = new Date("2026-07-17T12:00:00Z");

// Perfil mutable + deps que lo leen/escriben, como haría el repositorio real.
function harness(overrides: Partial<StudentProfileRecord> = {}): {
  profile: StudentProfileRecord;
  deps: StudentSessionDeps;
} {
  const profile: StudentProfileRecord = {
    id: "student-1",
    familyId: FAMILY,
    pinHash: "se-rellena-en-beforeEach",
    failedPinAttempts: 0,
    pinLockedUntil: null,
    ...overrides,
  };
  const deps: StudentSessionDeps = {
    jwtSecret: SECRET,
    now: () => NOW,
    findStudentProfile: async (id) => (id === profile.id ? profile : null),
    updatePinState: async (id, state) => {
      if (id !== profile.id) return;
      profile.failedPinAttempts = state.failedPinAttempts;
      profile.pinLockedUntil = state.pinLockedUntil;
    },
  };
  return { profile, deps };
}

let pinHash: string;
beforeEach(async () => {
  pinHash = await hashPassword(CORRECT_PIN);
});

async function expectAppError(
  promise: Promise<unknown>,
  code: string,
): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
  throw new Error(`se esperaba AppError ${code} pero no se lanzó`);
}

describe("createStudentSession", () => {
  test("PIN correcto de un hijo propio → token de alumno y resetea intentos", async () => {
    const { profile, deps } = harness({ pinHash, failedPinAttempts: 3 });

    const result = await createStudentSession(deps, {
      parentFamilyId: FAMILY,
      studentProfileId: profile.id,
      pin: CORRECT_PIN,
    });

    const claims = await verifyAccessToken(SECRET, result.accessToken);
    expect(claims.role).toBe("student");
    expect(claims.studentProfileId).toBe(profile.id);
    expect(claims.familyId).toBe(FAMILY);
    // El acierto resetea el contador de intentos.
    expect(profile.failedPinAttempts).toBe(0);
    expect(profile.pinLockedUntil).toBeNull();
  });

  test("perfil de OTRA familia → FORBIDDEN (pertenencia contra BD)", async () => {
    const { profile, deps } = harness({ pinHash, familyId: "otra-familia" });

    await expectAppError(
      createStudentSession(deps, {
        parentFamilyId: FAMILY,
        studentProfileId: profile.id,
        pin: CORRECT_PIN,
      }),
      "FORBIDDEN",
    );
  });

  test("perfil inexistente → FORBIDDEN (no revela existencia)", async () => {
    const { deps } = harness({ pinHash });

    await expectAppError(
      createStudentSession(deps, {
        parentFamilyId: FAMILY,
        studentProfileId: "no-existe",
        pin: CORRECT_PIN,
      }),
      "FORBIDDEN",
    );
  });

  test("PIN incorrecto → INVALID_PIN e incrementa el contador de fallos", async () => {
    const { profile, deps } = harness({ pinHash, failedPinAttempts: 1 });

    await expectAppError(
      createStudentSession(deps, {
        parentFamilyId: FAMILY,
        studentProfileId: profile.id,
        pin: "0000",
      }),
      "INVALID_PIN",
    );
    expect(profile.failedPinAttempts).toBe(2);
    expect(profile.pinLockedUntil).toBeNull();
  });

  test("el 5º fallo consecutivo bloquea el PIN 15 min", async () => {
    const { profile, deps } = harness({
      pinHash,
      failedPinAttempts: MAX_PIN_ATTEMPTS - 1,
    });

    await expectAppError(
      createStudentSession(deps, {
        parentFamilyId: FAMILY,
        studentProfileId: profile.id,
        pin: "0000",
      }),
      "INVALID_PIN",
    );
    expect(profile.failedPinAttempts).toBe(MAX_PIN_ATTEMPTS);
    expect(profile.pinLockedUntil).toEqual(
      new Date(NOW.getTime() + PIN_LOCK_MS),
    );
  });

  test("estando bloqueado, incluso el PIN correcto → INVALID_PIN", async () => {
    const { profile, deps } = harness({
      pinHash,
      failedPinAttempts: MAX_PIN_ATTEMPTS,
      pinLockedUntil: new Date(NOW.getTime() + 60_000),
    });

    await expectAppError(
      createStudentSession(deps, {
        parentFamilyId: FAMILY,
        studentProfileId: profile.id,
        pin: CORRECT_PIN,
      }),
      "INVALID_PIN",
    );
  });

  test("tras expirar el bloqueo, un PIN correcto entra y resetea el contador", async () => {
    const { profile, deps } = harness({
      pinHash,
      failedPinAttempts: MAX_PIN_ATTEMPTS,
      pinLockedUntil: new Date(NOW.getTime() - 1),
    });

    const result = await createStudentSession(deps, {
      parentFamilyId: FAMILY,
      studentProfileId: profile.id,
      pin: CORRECT_PIN,
    });

    const claims = await verifyAccessToken(SECRET, result.accessToken);
    expect(claims.role).toBe("student");
    expect(profile.failedPinAttempts).toBe(0);
    expect(profile.pinLockedUntil).toBeNull();
  });
});
