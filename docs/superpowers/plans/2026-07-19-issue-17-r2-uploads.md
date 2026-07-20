# ISSUE-17 — Subida de archivos a R2 con URL firmada — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline), task por task.

**Goal:** `POST /admin/uploads` que valida tipo (allowlist) y tamaño declarado y devuelve una **URL firmada de subida directa a R2** (presigned PUT) + `fileKey`. El archivo nunca pasa por el VPS.

**Architecture:** Adapter `src/lib/r2.ts` (config desde env, presigner inyectable). Servicio puro `src/modules/admin/uploads.ts` (allowlist + tamaño + fileKey). Ruta `src/modules/admin/uploads-routes.ts` bajo `/api/v1/admin`, solo admin. La URL firmada fija `Content-Type` y `Content-Length` (R2 rechaza cualquier otra cosa). Sin credenciales R2 la app arranca igual; en prod solo se setean las env vars. Tests con presigner mock (sin R2 real, sin DB: prisma stub).

**Tech Stack:** Fastify · `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` · Vitest.

Diseño aprobado: arquitectura §2.4 + forma del endpoint (conversación). Issue: `Issues.MD` ISSUE-17.

## Global Constraints

- TDD, commits por task, DoD. `requireRole('admin')`; `additionalProperties: false`.
- Seguridad: allowlist (deny-by-default); `fileKey` generado por el servidor (UUID); URL firmada fija Content-Type + Content-Length; expiración corta.
- R2 opcional: la app arranca sin credenciales; el endpoint responde error claro si se invoca sin config. Tests: presigner mock, prisma stub → corren en todo entorno (sin DB, sin skip).
- ESM `.js`.

## File Structure

- **Modify:** `package.json` — `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
- **Create:** `src/lib/r2.ts` — `loadR2Config`, `createPresignUpload`, tipos.
- **Create:** `src/modules/admin/uploads.ts` — `requestUpload` (servicio puro) + allowlist/constantes.
- **Create:** `src/modules/admin/uploads-routes.ts` — ruta `/admin/uploads`.
- **Modify:** `src/app.ts` — resolver el presigner (env o inyectado) y registrar la ruta.
- **Modify:** `.env.example` — documentar las vars R2 (opcionales).
- **Create tests:** `tests/admin/uploads-service.test.ts` (unit), `tests/admin/uploads.integration.test.ts` (ruta, mock).

---

## Task 1: Dependencias + adapter R2

- [ ] **Step 1: Instalar deps**

Run: `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`

- [ ] **Step 2: Test de `loadR2Config` (falla)**

Create `tests/lib/r2.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { loadR2Config } from "../../src/lib/r2.js";

const full = {
  R2_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
  R2_BUCKET: "piensa",
  R2_ACCESS_KEY_ID: "id",
  R2_SECRET_ACCESS_KEY: "secret",
};

describe("loadR2Config", () => {
  test("con todas las vars requeridas devuelve la config", () => {
    const cfg = loadR2Config({ ...full, R2_PUBLIC_BASE_URL: "https://cdn.x" });
    expect(cfg).toMatchObject({ bucket: "piensa", publicBaseUrl: "https://cdn.x" });
  });
  test("si falta una var requerida devuelve null (R2 no configurado)", () => {
    expect(loadR2Config({ ...full, R2_BUCKET: "" })).toBeNull();
    expect(loadR2Config({})).toBeNull();
  });
});
```

- [ ] **Step 3: Implementar `src/lib/r2.ts`**

```typescript
// Adapter de Cloudflare R2 (S3 API) — ISSUE-17. La config viene de env; sin
// credenciales la app arranca igual y el presigner no se construye. El presigner
// se inyecta en las rutas para poder mockearlo en tests (nunca se pega a R2 real).

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
}

export interface PresignUploadArgs {
  fileKey: string;
  contentType: string;
  contentLength: number;
  expiresInSeconds: number;
}

/** Firma una URL de subida (PUT) directa a R2. Devuelve la URL. */
export type PresignUpload = (args: PresignUploadArgs) => Promise<string>;

/** Lee la config de R2 del entorno; null si falta alguna var requerida. */
export function loadR2Config(
  source: NodeJS.ProcessEnv = process.env,
): R2Config | null {
  const endpoint = source.R2_ENDPOINT?.trim();
  const bucket = source.R2_BUCKET?.trim();
  const accessKeyId = source.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = source.R2_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  const publicBaseUrl = source.R2_PUBLIC_BASE_URL?.trim() || undefined;
  return { endpoint, bucket, accessKeyId, secretAccessKey, publicBaseUrl };
}

/** Construye el presigner real de subida a partir de la config. */
export function createPresignUpload(config: R2Config): PresignUpload {
  const client = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return async ({ fileKey, contentType, contentLength, expiresInSeconds }) => {
    // Firmar ContentType y ContentLength: R2 exige que la subida coincida, así
    // la URL no sirve para subir otro tipo ni otro tamaño.
    const command = new PutObjectCommand({
      Bucket: config.bucket,
      Key: fileKey,
      ContentType: contentType,
      ContentLength: contentLength,
    });
    return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
  };
}
```

- [ ] **Step 4: Verde + typecheck; Commit**

Run: `npx vitest run tests/lib/r2.test.ts && npm run typecheck`

```bash
git add package.json package-lock.json src/lib/r2.ts tests/lib/r2.test.ts
git commit -m "feat(uploads): adapter R2 (config por env, presigner inyectable) (ISSUE-17)"
```

---

## Task 2: Servicio de uploads (allowlist + tamaño + fileKey)

- [ ] **Step 1: Test del servicio (falla)**

Create `tests/admin/uploads-service.test.ts`:

```typescript
import { describe, expect, test, vi } from "vitest";
import {
  requestUpload,
  MAX_UPLOAD_BYTES_DEFAULT,
  type RequestUploadDeps,
} from "../../src/modules/admin/uploads.js";
import { AppError } from "../../src/plugins/errors.js";

const deps = (over: Partial<RequestUploadDeps> = {}): RequestUploadDeps => ({
  presignUpload: vi.fn(async () => "https://signed.example/put"),
  maxBytes: MAX_UPLOAD_BYTES_DEFAULT,
  expiresInSeconds: 300,
  ...over,
});

const bad = async (p: Promise<unknown>) => {
  await expect(p).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
};

describe("requestUpload", () => {
  test("pdf válido → fileKey documents/…​.pdf + url + expiración", async () => {
    const d = deps();
    const res = await requestUpload(d, {
      contentType: "application/pdf",
      sizeBytes: 1000,
    });
    expect(res.fileKey).toMatch(/^documents\/[0-9a-f-]+\.pdf$/);
    expect(res.uploadUrl).toBe("https://signed.example/put");
    expect(res.expiresInSeconds).toBe(300);
    expect(d.presignUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "application/pdf",
        contentLength: 1000,
      }),
    );
  });
  test("imágenes → prefijo images/ y extensión correcta", async () => {
    const png = await requestUpload(deps(), {
      contentType: "image/png",
      sizeBytes: 10,
    });
    expect(png.fileKey).toMatch(/^images\/[0-9a-f-]+\.png$/);
    const jpg = await requestUpload(deps(), {
      contentType: "image/jpeg",
      sizeBytes: 10,
    });
    expect(jpg.fileKey).toMatch(/\.jpg$/);
  });
  test("tipo no permitido → VALIDATION_ERROR (no firma)", async () => {
    const d = deps();
    await bad(
      requestUpload(d, { contentType: "image/svg+xml", sizeBytes: 10 }),
    );
    expect(d.presignUpload).not.toHaveBeenCalled();
  });
  test("tamaño mayor al máximo → VALIDATION_ERROR", async () => {
    await bad(
      requestUpload(deps({ maxBytes: 100 }), {
        contentType: "application/pdf",
        sizeBytes: 101,
      }),
    );
  });
  test("tamaño 0 o negativo → VALIDATION_ERROR", async () => {
    await bad(
      requestUpload(deps(), { contentType: "application/pdf", sizeBytes: 0 }),
    );
  });
});
```

- [ ] **Step 2: Implementar `src/modules/admin/uploads.ts`**

```typescript
// Servicio de solicitud de subida (ISSUE-17). Puro: valida el tipo (allowlist) y
// el tamaño declarado, arma el fileKey (prefijo por tipo + UUID) y delega la
// firma en el presigner inyectado. No toca Fastify ni R2 directo.

import { randomUUID } from "node:crypto";
import { AppError } from "../../plugins/errors.js";
import type { PresignUpload } from "../../lib/r2.js";

/** Tipos permitidos (deny-by-default): MIME → extensión + prefijo de carpeta. */
const ALLOWED: Record<string, { ext: string; prefix: string }> = {
  "application/pdf": { ext: "pdf", prefix: "documents" },
  "image/png": { ext: "png", prefix: "images" },
  "image/jpeg": { ext: "jpg", prefix: "images" },
  "image/webp": { ext: "webp", prefix: "images" },
};

export const MAX_UPLOAD_BYTES_DEFAULT = 20 * 1024 * 1024; // 20 MB
export const UPLOAD_URL_TTL_SECONDS_DEFAULT = 300; // 5 min

export interface RequestUploadDeps {
  presignUpload: PresignUpload;
  maxBytes: number;
  expiresInSeconds: number;
}

export interface UploadTicket {
  uploadUrl: string;
  fileKey: string;
  expiresInSeconds: number;
}

export async function requestUpload(
  deps: RequestUploadDeps,
  input: { contentType: string; sizeBytes: number },
): Promise<UploadTicket> {
  const kind = ALLOWED[input.contentType];
  if (!kind) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Tipo de archivo no permitido (pdf, png, jpg, webp).",
    );
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new AppError("VALIDATION_ERROR", "Tamaño de archivo inválido.");
  }
  if (input.sizeBytes > deps.maxBytes) {
    throw new AppError(
      "VALIDATION_ERROR",
      `El archivo supera el máximo permitido (${deps.maxBytes} bytes).`,
    );
  }
  const fileKey = `${kind.prefix}/${randomUUID()}.${kind.ext}`;
  const uploadUrl = await deps.presignUpload({
    fileKey,
    contentType: input.contentType,
    contentLength: input.sizeBytes,
    expiresInSeconds: deps.expiresInSeconds,
  });
  return { uploadUrl, fileKey, expiresInSeconds: deps.expiresInSeconds };
}
```

- [ ] **Step 3: Verde + Commit**

Run: `npx vitest run tests/admin/uploads-service.test.ts && npm run typecheck`

```bash
git add src/modules/admin/uploads.ts tests/admin/uploads-service.test.ts
git commit -m "feat(uploads): servicio de solicitud de subida (allowlist + fileKey) (ISSUE-17)"
```

---

## Task 3: Ruta `/admin/uploads` + wiring

- [ ] **Step 1: Crear `src/modules/admin/uploads-routes.ts`**

```typescript
// Ruta POST /admin/uploads (ISSUE-17), solo admin. Devuelve una URL firmada de
// subida directa a R2 + fileKey. El presigner se inyecta (undefined = R2 no
// configurado → error claro de config).

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import type { PresignUpload } from "../../lib/r2.js";
import {
  requestUpload,
  MAX_UPLOAD_BYTES_DEFAULT,
  UPLOAD_URL_TTL_SECONDS_DEFAULT,
} from "./uploads.js";

export interface UploadsRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
  presignUpload?: PresignUpload;
  maxBytes?: number;
}

const uploadBodySchema = {
  type: "object",
  required: ["contentType", "sizeBytes"],
  additionalProperties: false,
  properties: {
    contentType: { type: "string", minLength: 1, maxLength: 100 },
    sizeBytes: { type: "integer", minimum: 1 },
  },
} as const;

interface UploadBody {
  contentType: string;
  sizeBytes: number;
}

export const uploadsRoutes: FastifyPluginAsync<UploadsRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret, presignUpload } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES_DEFAULT;

  app.post<{ Body: UploadBody }>(
    "/admin/uploads",
    { schema: { body: uploadBodySchema }, preHandler: adminOnly },
    async (request) => {
      if (!presignUpload) {
        // Sin credenciales R2: error de servidor claro (no filtra detalles).
        throw new AppError(
          "INTERNAL",
          "El almacenamiento de archivos no está configurado.",
        );
      }
      const ticket = await requestUpload(
        { presignUpload, maxBytes, expiresInSeconds: UPLOAD_URL_TTL_SECONDS_DEFAULT },
        request.body,
      );
      return { data: ticket };
    },
  );
};
```

- [ ] **Step 2: Wiring en `src/app.ts`**

Imports:

```typescript
import { uploadsRoutes } from "./modules/admin/uploads-routes.js";
import { loadR2Config, createPresignUpload, type PresignUpload } from "./lib/r2.js";
```

Agregar a `BuildAppOptions`:

```typescript
  // Presigner de subida a R2; por defecto se arma desde el entorno si está
  // configurado. Los tests inyectan un mock (no pegan a R2 real).
  r2Presign?: PresignUpload;
```

En `buildApp`, resolver el presigner y registrar la ruta (junto a `adminRoutes`):

```typescript
  const r2Config = loadR2Config();
  const r2Presign =
    opts.r2Presign ?? (r2Config ? createPresignUpload(r2Config) : undefined);

  app.register(
    async (scope) => {
      await uploadsRoutes(scope, { prisma, jwtSecret, r2Presign });
    },
    { prefix: "/api/v1" },
  );
```

(Nota: `uploadsRoutes` recibe `presignUpload`; pasar `presignUpload: r2Presign`.)

- [ ] **Step 3: Documentar env en `.env.example`**

Agregar al final:

```
# --- Cloudflare R2 (opcional; requerido solo para subir archivos, ISSUE-17) ---
# Sin estas variables la app arranca igual y /admin/uploads responde error de
# configuración. En producción, setear las 5 y funciona sin cambios de código.
# R2_ENDPOINT="https://<accountid>.r2.cloudflarestorage.com"
# R2_BUCKET="piensa"
# R2_ACCESS_KEY_ID=""
# R2_SECRET_ACCESS_KEY=""
# R2_PUBLIC_BASE_URL=""   # base pública/CDN para lecturas (se usa en ISSUE-21)
```

- [ ] **Step 4: Test de integración de la ruta (mock presigner + prisma stub, sin DB)**

Create `tests/admin/uploads.integration.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Ruta /admin/uploads con presigner mock y prisma stub (sin DB, sin skip). El
// stub responde admin activo para authenticate; el mock firma una URL falsa.

const SECRET = "test-secret-at-least-16-chars-long";
const prismaStub = {
  family: { findUnique: async () => ({ status: "active" }) },
  user: { findUnique: async () => ({ status: "active" }) },
} as unknown as PrismaClient;

function appWith(presign?: (a: { fileKey: string }) => Promise<string>) {
  return buildApp({
    jwtSecret: SECRET,
    prisma: prismaStub,
    r2Presign: presign as never,
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
```

> El `sizeBytes: 999_000_000` supera el default de 20 MB → VALIDATION_ERROR del servicio. El caso "sin R2" arma una app sin `r2Presign` y sin env → el presigner queda `undefined`.

- [ ] **Step 5: Verificar + commit**

Run: `npm run typecheck && npm run lint && npx vitest run tests/admin/uploads.integration.test.ts tests/admin/uploads-service.test.ts`

```bash
git add src/modules/admin/uploads-routes.ts src/app.ts .env.example tests/admin/uploads.integration.test.ts
git commit -m "feat(uploads): endpoint POST /admin/uploads con URL firmada de R2 (ISSUE-17)"
```

---

## Task 4: Verificación final + PR

- [ ] **Step 1:** `npm run test` (suite completa; los uploads corren sin DB) — o con Postgres para todo verde.
- [ ] **Step 2:** `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 3:** commitear el plan; `git push`; PR hacia `main`; link y parar. Sin footer.

---

## Self-Review

- Mock de R2 en tests: extensión no permitida → VALIDATION_ERROR; permitida → URL firmada con expiración corta y fileKey con prefijo por tipo. → Task 2 (servicio) + Task 3 (ruta), con presigner mock. ✔
- El archivo nunca pasa por el VPS (presigned PUT directo a R2). ✔
- Seguridad: allowlist deny-by-default; fileKey server-side (UUID); URL firma Content-Type + Content-Length; TTL 300s. ✔
- R2 opcional: app arranca sin credenciales; endpoint → error claro si no está configurado; prod = solo env vars. No-admin → FORBIDDEN. ✔
- Lectura firmada de GET: **diferida a ISSUE-21** (decisión aprobada). ✔
