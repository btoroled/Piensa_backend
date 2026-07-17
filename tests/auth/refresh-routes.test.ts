import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";

// Validación de entrada de POST /auth/refresh. No toca la BD (la validación por
// JSON Schema corta antes de Prisma), así que corre en cualquier entorno.

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp({ jwtSecret: "test-secret-at-least-16-chars-long" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function post(payload: unknown) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/refresh",
    payload: payload as object,
  });
}

describe("POST /auth/refresh — validación", () => {
  test("falta refreshToken → VALIDATION_ERROR", async () => {
    const res = await post({});
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("refreshToken con caracteres no url-safe → VALIDATION_ERROR", async () => {
    const res = await post({ refreshToken: "no es base64url ++//" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("refreshToken numérico no se coacciona a válido → VALIDATION_ERROR", async () => {
    const res = await post({ refreshToken: 12345 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("propiedad extra → VALIDATION_ERROR (additionalProperties: false)", async () => {
    const res = await post({
      refreshToken: "A".repeat(43),
      extra: true,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});
