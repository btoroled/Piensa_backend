import { afterEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.js";

// Rate limiting (ISSUE-11, Spec §6). Sin BD: el hook de rate-limit rechaza en
// `onRequest`, antes de la validación y del handler, así que un request limitado
// nunca toca la BD. Cada test construye su propia app para aislar los contadores
// en memoria del plugin.

const SECRET = "test-secret-at-least-16-chars-long";
const UUID = "11111111-1111-1111-1111-111111111111";

let app: FastifyInstance;

afterEach(async () => {
  await app?.close();
});

describe("rate limiting", () => {
  test("exceder el límite en /auth/login → RATE_LIMITED y NO toca la BD", async () => {
    let dbCalls = 0;
    const prisma = {
      user: {
        findUnique: async () => {
          dbCalls++;
          return null;
        },
      },
    } as unknown as PrismaClient;

    app = buildApp({
      jwtSecret: SECRET,
      prisma,
      rateLimit: {
        global: { max: 1000, timeWindow: 60_000 },
        auth: { max: 1, timeWindow: 60_000 },
      },
    });
    await app.ready();

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "a@b.com", password: "x" },
    });
    // El primer request alcanza el handler: consulta la BD y da 401.
    expect(first.statusCode).toBe(401);
    expect(dbCalls).toBe(1);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "a@b.com", password: "x" },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("RATE_LIMITED");
    // El request limitado NO llegó al handler: la BD no se tocó de nuevo.
    expect(dbCalls).toBe(1);
  });

  test("/auth/student-session también está limitado", async () => {
    app = buildApp({
      jwtSecret: SECRET,
      prisma: {} as PrismaClient,
      rateLimit: {
        global: { max: 1000, timeWindow: 60_000 },
        auth: { max: 1, timeWindow: 60_000 },
      },
    });
    await app.ready();

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/student-session",
      payload: { studentProfileId: UUID, pin: "1234" },
    });
    // Sin token: authenticate corta con 401 (no toca prisma).
    expect(first.statusCode).toBe(401);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/student-session",
      payload: { studentProfileId: UUID, pin: "1234" },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("RATE_LIMITED");
  });

  test("el límite global por IP aplica a rutas fuera de auth", async () => {
    app = buildApp({
      jwtSecret: SECRET,
      prisma: {} as PrismaClient,
      rateLimit: {
        global: { max: 1, timeWindow: 60_000 },
        auth: { max: 1000, timeWindow: 60_000 },
      },
    });
    await app.ready();

    const first = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("RATE_LIMITED");
  });
});
