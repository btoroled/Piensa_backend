import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Validación de entrada y autenticación de POST /auth/student-session. No toca
// la BD: la validación por JSON Schema y la verificación del Bearer cortan antes
// de llegar a Prisma, así que estos tests corren sin Postgres. La pertenencia y
// el PIN contra la BD se cubren en el test de integración.

const SECRET = "test-secret-at-least-16-chars-long";
const UUID = "11111111-1111-1111-1111-111111111111";

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp({ jwtSecret: SECRET });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function post(payload: unknown, bearer?: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/student-session",
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    payload: payload as object,
  });
}

describe("POST /auth/student-session — autenticación del padre", () => {
  test("sin Authorization → 401 UNAUTHORIZED", async () => {
    const res = await post({ studentProfileId: UUID, pin: "1234" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  test("Bearer inválido → 401 UNAUTHORIZED", async () => {
    const res = await post(
      { studentProfileId: UUID, pin: "1234" },
      "no-es-un-jwt-valido",
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  test("token de alumno (no padre) → 403 FORBIDDEN", async () => {
    const studentToken = await createAccessToken(SECRET, {
      studentProfileId: UUID,
      role: "student",
      familyId: "f1",
    });
    const res = await post(
      { studentProfileId: UUID, pin: "1234" },
      studentToken,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("token de admin (no padre) → 403 FORBIDDEN", async () => {
    const adminToken = await createAccessToken(SECRET, {
      userId: "a1",
      role: "admin",
    });
    const res = await post({ studentProfileId: UUID, pin: "1234" }, adminToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});

describe("POST /auth/student-session — validación", () => {
  test("falta pin → VALIDATION_ERROR", async () => {
    const res = await post({ studentProfileId: UUID });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("pin de 3 dígitos → VALIDATION_ERROR", async () => {
    const res = await post({ studentProfileId: UUID, pin: "123" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("pin no numérico → VALIDATION_ERROR", async () => {
    const res = await post({ studentProfileId: UUID, pin: "abcd" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("studentProfileId sin formato uuid → VALIDATION_ERROR", async () => {
    const res = await post({ studentProfileId: "no-es-uuid", pin: "1234" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("propiedad extra → VALIDATION_ERROR (additionalProperties: false)", async () => {
    const res = await post({
      studentProfileId: UUID,
      pin: "1234",
      familyId: "x",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});
