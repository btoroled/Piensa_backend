import { describe, expect, test } from "vitest";
import {
  REFRESH_TOKEN_TTL_MS,
  generateRefreshToken,
  hashRefreshToken,
} from "../../src/modules/auth/refresh-token.js";

describe("refresh token opaco", () => {
  test("genera tokens únicos de alta entropía (url-safe)", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    // base64url: sin '+', '/' ni '=', y suficientemente largo (>=32 bytes).
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(43);
  });

  test("el hash es determinista (SHA-256 hex) y distinto del token en claro", () => {
    const token = generateRefreshToken();
    const h1 = hashRefreshToken(token);
    const h2 = hashRefreshToken(token);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(token);
  });

  test("tokens distintos producen hashes distintos", () => {
    expect(hashRefreshToken(generateRefreshToken())).not.toBe(
      hashRefreshToken(generateRefreshToken()),
    );
  });

  test("el TTL del refresh token es de 30 días", () => {
    expect(REFRESH_TOKEN_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});
