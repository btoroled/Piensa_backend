import { afterAll, beforeAll, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

test("GET /api/v1/health devuelve el envelope { data: { status: 'ok' } }", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/health" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ data: { status: "ok" } });
});
