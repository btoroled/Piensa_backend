import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  createAccessToken,
  verifyAccessToken,
} from "../../src/modules/auth/tokens.js";

const SECRET = "test-secret-at-least-16-chars-long";

afterEach(() => {
  vi.useRealTimers();
});

describe("access token", () => {
  test("round-trip: incluye userId, role y familyId en los claims", async () => {
    const token = await createAccessToken(SECRET, {
      userId: "u1",
      role: "parent",
      familyId: "f1",
    });
    const claims = await verifyAccessToken(SECRET, token);
    expect(claims).toMatchObject({
      userId: "u1",
      role: "parent",
      familyId: "f1",
    });
  });

  test("token de alumno: role student, studentProfileId y familyId; sin userId", async () => {
    const token = await createAccessToken(SECRET, {
      studentProfileId: "s1",
      role: "student",
      familyId: "f1",
    });
    const claims = await verifyAccessToken(SECRET, token);
    expect(claims.role).toBe("student");
    expect(claims.studentProfileId).toBe("s1");
    expect(claims.familyId).toBe("f1");
    expect(claims.userId).toBeUndefined();
  });

  test("un admin no lleva familyId en los claims", async () => {
    const token = await createAccessToken(SECRET, {
      userId: "a1",
      role: "admin",
    });
    const claims = await verifyAccessToken(SECRET, token);
    expect(claims.userId).toBe("a1");
    expect(claims.role).toBe("admin");
    expect(claims.familyId).toBeUndefined();
  });

  test("el TTL declarado del access token es de 15 minutos", () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(15 * 60);
  });

  test("expira a los 15 minutos (reloj falso)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await createAccessToken(SECRET, {
      userId: "u1",
      role: "parent",
      familyId: "f1",
    });

    // Justo antes del corte sigue siendo válido.
    vi.setSystemTime(new Date("2026-01-01T00:14:30Z"));
    await expect(verifyAccessToken(SECRET, token)).resolves.toMatchObject({
      userId: "u1",
    });

    // Pasados los 15 minutos, se rechaza.
    vi.setSystemTime(new Date("2026-01-01T00:15:30Z"));
    await expect(verifyAccessToken(SECRET, token)).rejects.toThrow();
  });

  test("rechaza un token firmado con otro secreto", async () => {
    const token = await createAccessToken(SECRET, {
      userId: "u1",
      role: "parent",
    });
    await expect(
      verifyAccessToken("otro-secreto-distinto-de-16", token),
    ).rejects.toThrow();
  });
});
