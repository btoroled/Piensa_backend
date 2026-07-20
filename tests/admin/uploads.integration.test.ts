import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";
import type { PresignUpload } from "../../src/lib/r2.js";

// Ruta /admin/uploads con presigner mock y prisma stub (sin DB, sin skip). El
// stub responde admin activo para authenticate; el mock firma una URL falsa.

const SECRET = "test-secret-at-least-16-chars-long";
const prismaStub = {
  family: { findUnique: async () => ({ status: "active" }) },
  user: { findUnique: async () => ({ status: "active" }) },
} as unknown as PrismaClient;

function appWith(presign?: PresignUpload) {
  return buildApp({
    jwtSecret: SECRET,
    prisma: prismaStub,
    r2Presign: presign,
  });
}

const adminToken = () =>
  createAccessToken(SECRET, { userId: "a1", role: "admin" });
const parentToken = () =>
  createAccessToken(SECRET, { userId: "p1", role: "parent", familyId: "f1" });

describe("POST /admin/uploads", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = appWith(async ({ fileKey }) => `https://signed.example/${fileKey}`);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (body: unknown, token?: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/admin/uploads",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body as object,
    });

  test("pdf permitido → url firmada + fileKey documents/…​.pdf", async () => {
    const res = await post(
      { contentType: "application/pdf", sizeBytes: 1000 },
      await adminToken(),
    );
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.fileKey).toMatch(/^documents\/[0-9a-f-]+\.pdf$/);
    expect(d.uploadUrl).toContain("signed.example");
    expect(d.expiresInSeconds).toBe(300);
  });

  test("tipo no permitido → VALIDATION_ERROR", async () => {
    const res = await post(
      { contentType: "application/x-msdownload", sizeBytes: 10 },
      await adminToken(),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("tamaño excesivo → VALIDATION_ERROR", async () => {
    const res = await post(
      { contentType: "image/png", sizeBytes: 999_000_000 },
      await adminToken(),
    );
    expect(res.statusCode).toBe(400);
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await post(
      { contentType: "image/png", sizeBytes: 10 },
      await parentToken(),
    );
    expect(res.statusCode).toBe(403);
  });

  test("sin R2 configurado → INTERNAL (config)", async () => {
    const noR2 = appWith(undefined);
    await noR2.ready();
    const res = await noR2.inject({
      method: "POST",
      url: "/api/v1/admin/uploads",
      headers: { authorization: `Bearer ${await adminToken()}` },
      payload: { contentType: "image/png", sizeBytes: 10 },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("INTERNAL");
    await noR2.close();
  });
});
