import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";

// Validación de entrada de POST /auth/login. No toca la BD: la validación por
// JSON Schema corta antes de llegar a Prisma, así que estos tests corren en
// cualquier entorno (sin Postgres).

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
    url: "/api/v1/auth/login",
    payload: payload as object,
  });
}

describe("POST /auth/login — validación", () => {
  test("falta email → VALIDATION_ERROR", async () => {
    const res = await post({ password: "loquesea" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("falta password → VALIDATION_ERROR", async () => {
    const res = await post({ email: "a@b.com" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("email con formato inválido → VALIDATION_ERROR", async () => {
    const res = await post({ email: "no-es-un-email", password: "x" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("propiedad extra → VALIDATION_ERROR (additionalProperties: false)", async () => {
    const res = await post({
      email: "a@b.com",
      password: "x",
      role: "admin",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("un email numérico no se coacciona a string válido (coerceTypes)", async () => {
    // Con ajv coerceTypes, 12345 se volvería "12345"; el `pattern` de email lo
    // rechaza igual. Guarda contra la nota de review de ISSUE-03.
    const res = await post({ email: 12345, password: "x" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});
