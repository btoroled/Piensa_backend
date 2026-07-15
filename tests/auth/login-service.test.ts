import { beforeEach, describe, expect, test } from "vitest";
import {
  INVALID_CREDENTIALS_MESSAGE,
  login,
  type AuthDeps,
  type UserRecord,
} from "../../src/modules/auth/service.js";
import { AppError } from "../../src/plugins/errors.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import { hashRefreshToken } from "../../src/modules/auth/refresh-token.js";
import { verifyAccessToken } from "../../src/modules/auth/tokens.js";

const SECRET = "test-secret-at-least-16-chars-long";
const NOW = new Date("2026-03-01T12:00:00Z");

interface Persisted {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

// Fabrica unas dependencias en memoria: sin BD ni Fastify.
function makeDeps(
  user: UserRecord | null,
  familyId: string | null = null,
): { deps: AuthDeps; persisted: Persisted[] } {
  const persisted: Persisted[] = [];
  const deps: AuthDeps = {
    jwtSecret: SECRET,
    now: () => NOW,
    findUserByEmail: async (email) =>
      user && user.email === email ? user : null,
    findParentFamilyId: async () => familyId,
    persistRefreshToken: async (input) => {
      persisted.push(input);
    },
  };
  return { deps, persisted };
}

async function makeUser(
  overrides: Partial<UserRecord> = {},
): Promise<UserRecord> {
  return {
    id: "user-1",
    email: "papa@piensa.test",
    passwordHash: await hashPassword("correcta"),
    role: "parent",
    ...overrides,
  };
}

// Corre un login que se espera falle y devuelve el AppError capturado.
async function captureError(
  deps: AuthDeps,
  input: { email: string; password: string },
): Promise<AppError> {
  try {
    await login(deps, input);
    throw new Error("se esperaba un AppError de credenciales inválidas");
  } catch (e) {
    return e as AppError;
  }
}

let user: UserRecord;
beforeEach(async () => {
  user = await makeUser();
});

describe("login (servicio)", () => {
  test("credenciales válidas devuelven access y refresh token", async () => {
    const { deps, persisted } = makeDeps(user, "family-1");

    const result = await login(deps, {
      email: "papa@piensa.test",
      password: "correcta",
    });

    expect(typeof result.accessToken).toBe("string");
    expect(typeof result.refreshToken).toBe("string");

    const claims = await verifyAccessToken(SECRET, result.accessToken);
    expect(claims).toMatchObject({
      userId: "user-1",
      role: "parent",
      familyId: "family-1",
    });

    // Se persiste el HASH del refresh token, nunca el token en claro, con
    // expiración futura.
    expect(persisted).toHaveLength(1);
    const [row] = persisted;
    if (!row) throw new Error("no se persistió el refresh token");
    expect(row.userId).toBe("user-1");
    expect(row.tokenHash).toBe(hashRefreshToken(result.refreshToken));
    expect(row.tokenHash).not.toBe(result.refreshToken);
    expect(row.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test("un admin recibe token sin familyId y no consulta familia", async () => {
    const admin = await makeUser({
      id: "admin-1",
      email: "admin@piensa.test",
      role: "admin",
    });
    const { deps } = makeDeps(admin);

    const result = await login(deps, {
      email: "admin@piensa.test",
      password: "correcta",
    });

    const claims = await verifyAccessToken(SECRET, result.accessToken);
    expect(claims.userId).toBe("admin-1");
    expect(claims.role).toBe("admin");
    expect(claims.familyId).toBeUndefined();
  });

  test("contraseña incorrecta → UNAUTHORIZED, sin persistir refresh token", async () => {
    const { deps, persisted } = makeDeps(user);

    await expect(
      login(deps, { email: "papa@piensa.test", password: "incorrecta" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(persisted).toHaveLength(0);
  });

  test("email inexistente y contraseña incorrecta dan el MISMO mensaje (sin enumeración)", async () => {
    const wrongPassword = await captureError(makeDeps(user).deps, {
      email: "papa@piensa.test",
      password: "incorrecta",
    });
    const unknownEmail = await captureError(makeDeps(null).deps, {
      email: "nadie@piensa.test",
      password: "loquesea",
    });

    expect(wrongPassword).toBeInstanceOf(AppError);
    expect(unknownEmail).toBeInstanceOf(AppError);
    expect(wrongPassword.code).toBe("UNAUTHORIZED");
    expect(unknownEmail.code).toBe("UNAUTHORIZED");
    // Idéntico mensaje: el cliente no puede distinguir si el email existe.
    expect(wrongPassword.message).toBe(unknownEmail.message);
    expect(wrongPassword.message).toBe(INVALID_CREDENTIALS_MESSAGE);
  });
});
