import { afterAll, beforeAll, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { AppError } from "../src/plugins/errors.js";

// Captura de logs estructurados del servidor para verificar correlación.
interface LogLine {
  level: number;
  reqId?: string;
  msg?: string;
  err?: { type?: string; message?: string; stack?: string };
  [key: string]: unknown;
}

const logLines: LogLine[] = [];
const captureStream = {
  write(line: string): void {
    logLines.push(JSON.parse(line) as LogLine);
  },
};

const SECRET_SQL = "SELECT * FROM users WHERE secret = 'p4ssw0rd'";

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp({ logger: { level: "info", stream: captureStream } });

  // Ruta de éxito.
  app.get("/api/v1/__ok", async () => ({ data: { hello: "world" } }));

  // Ruta que lanza un error interno con detalle sensible (simula SQL).
  app.get("/api/v1/__boom", async () => {
    throw new Error(SECRET_SQL);
  });

  // Ruta que lanza un AppError tipado del catálogo.
  app.get("/api/v1/__forbidden", async () => {
    throw new AppError("FORBIDDEN", "No tienes acceso a este recurso.");
  });

  // Ruta con validación JSON Schema de entrada.
  app.post(
    "/api/v1/__echo",
    {
      schema: {
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
    async (request) => ({ data: request.body }),
  );

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

test("respuesta de éxito usa el envelope { data } y expone x-request-id", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/__ok" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ data: { hello: "world" } });
  expect(response.headers["x-request-id"]).toBeTruthy();
});

test("error de validación produce VALIDATION_ERROR con requestId", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/__echo",
    payload: { note: "sin el campo requerido name" },
  });

  expect(response.statusCode).toBe(400);
  const body = response.json();
  expect(body.data).toBeUndefined();
  expect(body.error.code).toBe("VALIDATION_ERROR");
  expect(typeof body.error.message).toBe("string");
  expect(body.error.requestId).toBe(response.headers["x-request-id"]);
});

test("AppError tipado se serializa con su código y estado HTTP", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/__forbidden",
  });

  expect(response.statusCode).toBe(403);
  expect(response.json().error.code).toBe("FORBIDDEN");
  expect(response.json().error.message).toBe(
    "No tienes acceso a este recurso.",
  );
});

test("error interno no filtra stack ni SQL al cliente pero sí lo registra en el log", async () => {
  logLines.length = 0;
  const response = await app.inject({ method: "GET", url: "/api/v1/__boom" });

  expect(response.statusCode).toBe(500);
  const body = response.json();
  const rawBody = response.body;

  // Envelope de error correcto.
  expect(body.error.code).toBe("INTERNAL");
  expect(typeof body.error.message).toBe("string");
  const requestId = body.error.requestId;
  expect(requestId).toBe(response.headers["x-request-id"]);

  // Nada interno filtrado al cliente.
  expect(rawBody).not.toContain(SECRET_SQL);
  expect(rawBody).not.toContain("SELECT");
  expect(rawBody.toLowerCase()).not.toContain("stack");

  // El detalle completo sí está en el log del servidor, bajo el mismo requestId.
  const detailLine = logLines.find(
    (line) =>
      line.reqId === requestId &&
      line.level >= 50 &&
      (line.err?.message?.includes(SECRET_SQL) ||
        line.err?.stack?.includes(SECRET_SQL)),
  );
  expect(detailLine).toBeDefined();
});

test("ruta inexistente responde NOT_FOUND con envelope", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/no-existe",
  });

  expect(response.statusCode).toBe(404);
  expect(response.json().error.code).toBe("NOT_FOUND");
  expect(response.json().error.requestId).toBe(
    response.headers["x-request-id"],
  );
});

test("cada request recibe un requestId de correlación distinto", async () => {
  const a = await app.inject({ method: "GET", url: "/api/v1/__ok" });
  const b = await app.inject({ method: "GET", url: "/api/v1/__ok" });

  expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
});
