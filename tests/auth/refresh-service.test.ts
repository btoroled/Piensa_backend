import { describe, expect, test } from "vitest";
import {
  INVALID_REFRESH_MESSAGE,
  refresh,
  type RefreshDeps,
  type RefreshTokenRecord,
} from "../../src/modules/auth/service.js";
import {
  generateRefreshToken,
  hashRefreshToken,
} from "../../src/modules/auth/refresh-token.js";
import { verifyAccessToken } from "../../src/modules/auth/tokens.js";

const SECRET = "test-secret-at-least-16-chars-long";

// Store de refresh tokens en memoria: reproduce rotación y revocación de sesión
// sin BD ni Fastify. Todas las `deps()` comparten el mismo estado.
class FakeStore {
  rows = new Map<string, RefreshTokenRecord>();
  now = new Date("2026-05-01T00:00:00Z");
  seq = 0;

  seedValid(token: string, over: Partial<RefreshTokenRecord> = {}): void {
    this.seq += 1;
    this.rows.set(hashRefreshToken(token), {
      id: over.id ?? `id-${this.seq}`,
      sessionId: over.sessionId ?? "session-1",
      userId: over.userId ?? "user-1",
      revokedAt: over.revokedAt ?? null,
      expiresAt: over.expiresAt ?? new Date(this.now.getTime() + 60_000),
    });
  }

  deps(role: "parent" | "admin" = "parent"): RefreshDeps {
    return {
      jwtSecret: SECRET,
      now: () => this.now,
      findRefreshTokenByHash: async (h) => this.rows.get(h) ?? null,
      findUserById: async (id) => ({ id, role }),
      findParentFamilyId: async () => "family-1",
      rotate: async (input) => {
        for (const rec of this.rows.values()) {
          if (rec.id === input.oldTokenId) rec.revokedAt = input.now;
        }
        this.seq += 1;
        this.rows.set(input.newTokenHash, {
          id: `id-${this.seq}`,
          sessionId: input.sessionId,
          userId: input.userId,
          revokedAt: null,
          expiresAt: input.expiresAt,
        });
      },
      revokeSession: async (sessionId, now) => {
        for (const rec of this.rows.values()) {
          if (rec.sessionId === sessionId && rec.revokedAt === null) {
            rec.revokedAt = now;
          }
        }
      },
    };
  }
}

describe("refresh (servicio) — rotación y detección de robo", () => {
  test("refresh válido emite tokens nuevos con los claims del usuario", async () => {
    const store = new FakeStore();
    const token = generateRefreshToken();
    store.seedValid(token);

    const res = await refresh(store.deps(), { refreshToken: token });

    expect(typeof res.accessToken).toBe("string");
    expect(res.refreshToken).not.toBe(token);
    const claims = await verifyAccessToken(SECRET, res.accessToken);
    expect(claims).toMatchObject({
      userId: "user-1",
      role: "parent",
      familyId: "family-1",
    });
  });

  test("el token anterior deja de servir tras rotar", async () => {
    const store = new FakeStore();
    const token = generateRefreshToken();
    store.seedValid(token);

    await refresh(store.deps(), { refreshToken: token });

    // Reusar el token ya rotado falla.
    await expect(
      refresh(store.deps(), { refreshToken: token }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("el nuevo refresh token permite una segunda rotación (la cadena sigue)", async () => {
    const store = new FakeStore();
    const tokenA = generateRefreshToken();
    store.seedValid(tokenA);

    const r1 = await refresh(store.deps(), { refreshToken: tokenA });
    const r2 = await refresh(store.deps(), { refreshToken: r1.refreshToken });

    expect(r2.refreshToken).not.toBe(r1.refreshToken);
  });

  test("reusar un token ya rotado revoca TODA la cadena de la sesión (robo)", async () => {
    const store = new FakeStore();
    const tokenA = generateRefreshToken();
    store.seedValid(tokenA, { sessionId: "s1" });

    // Rotación legítima A → B.
    const r1 = await refresh(store.deps(), { refreshToken: tokenA });
    const tokenB = r1.refreshToken;

    // Un atacante reusa A (ya revocado) → UNAUTHORIZED y se revoca la sesión.
    const reuse = await captureError(store.deps(), { refreshToken: tokenA });
    expect(reuse.code).toBe("UNAUTHORIZED");
    expect(reuse.message).toBe(INVALID_REFRESH_MESSAGE);

    // Como consecuencia, B (que era válido) también queda revocado.
    await expect(
      refresh(store.deps(), { refreshToken: tokenB }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("token inexistente → UNAUTHORIZED", async () => {
    const store = new FakeStore();
    await expect(
      refresh(store.deps(), { refreshToken: generateRefreshToken() }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test("token expirado → UNAUTHORIZED", async () => {
    const store = new FakeStore();
    const token = generateRefreshToken();
    store.seedValid(token, {
      expiresAt: new Date(store.now.getTime() - 1_000),
    });
    await expect(
      refresh(store.deps(), { refreshToken: token }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

interface AppErrorLike {
  code: string;
  message: string;
}

// Corre un refresh que se espera falle y devuelve el error capturado.
async function captureError(
  deps: RefreshDeps,
  input: { refreshToken: string },
): Promise<AppErrorLike> {
  try {
    await refresh(deps, input);
    throw new Error("se esperaba un UNAUTHORIZED de refresh");
  } catch (e) {
    return e as AppErrorLike;
  }
}
