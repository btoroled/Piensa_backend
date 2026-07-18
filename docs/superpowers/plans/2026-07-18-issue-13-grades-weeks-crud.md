# ISSUE-13 — CRUD de grados y semanas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline), task por task. Steps con checkbox.

**Goal:** CRUD de `/admin/grades` y `/admin/weeks` (solo admin), con validación por operación y borrado bloqueado (→ `CONFLICT` 409) cuando el recurso tiene contenido/uso.

**Architecture:** Rutas en el módulo `catalog` bajo `/api/v1/admin`, gateadas por `requireRole('admin')` (super_admin hereda). El borrado con dependientes lo bloquean las FK `onDelete: Restrict` de ISSUE-12 (`P2003`), traducido a `CONFLICT` con un helper compartido `mapDeleteRestrict`. Validación con `src/lib/validation.ts`.

**Tech Stack:** Fastify · Prisma · PostgreSQL · Vitest.

Diseño aprobado: `docs/superpowers/specs/2026-07-17-milestone-2-catalog-admin-architecture.md` §2.1/§2.3. Issue: `Issues.MD` ISSUE-13.

## Global Constraints

- **TDD**, commits por task, DoD (validación JSON Schema por ruta, errores del catálogo, no-admin → FORBIDDEN, CI verde).
- **Seguridad:** todas las rutas `requireRole('admin')`; `additionalProperties: false`; IDs con `UUID_PATTERN`.
- **Errores:** `AppError` del catálogo. Código nuevo `CONFLICT` (409).
- **Tests de BD** auto-saltables (patrón `makeClient()/probe()/skipIf`), corren en CI.
- **ESM** con `.js`.

## File Structure

- **Modify:** `src/plugins/errors.ts` — `CONFLICT` (409).
- **Create:** `src/lib/prisma-errors.ts` — `isPrismaError`, `mapDeleteRestrict`.
- **Create:** `src/modules/catalog/routes.ts` — plugin CRUD grades/weeks.
- **Modify:** `src/app.ts` — registrar `catalogRoutes`.
- **Create tests:** `tests/lib/prisma-errors.test.ts`, `tests/catalog/grades.integration.test.ts`, `tests/catalog/weeks.integration.test.ts`.

---

## Task 1: `CONFLICT` + `mapDeleteRestrict`

**Files:** Modify `src/plugins/errors.ts`; Create `src/lib/prisma-errors.ts`, `tests/lib/prisma-errors.test.ts`.

**Interfaces:** Produces `isPrismaError(err, code)`, `mapDeleteRestrict(err, message): never` — consumidos por `catalog/routes.ts`.

- [ ] **Step 1: `CONFLICT` en el catálogo de errores**

En `src/plugins/errors.ts`: agregar `"CONFLICT"` a `ERROR_CODES` (después de `"NOT_FOUND"`), `CONFLICT: 409` a `STATUS_BY_CODE`, y `CONFLICT: "El recurso no se puede modificar por su estado actual."` a `SAFE_MESSAGES`.

- [ ] **Step 2: Test del helper (falla)**

Create `tests/lib/prisma-errors.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { isPrismaError, mapDeleteRestrict } from "../../src/lib/prisma-errors.js";
import { AppError } from "../../src/plugins/errors.js";

describe("isPrismaError", () => {
  test("detecta el código de un error tipo Prisma", () => {
    expect(isPrismaError({ code: "P2003" }, "P2003")).toBe(true);
    expect(isPrismaError({ code: "P2025" }, "P2003")).toBe(false);
    expect(isPrismaError(new Error("x"), "P2003")).toBe(false);
    expect(isPrismaError(null, "P2003")).toBe(false);
  });
});

describe("mapDeleteRestrict", () => {
  test("P2003 → AppError CONFLICT", () => {
    expect(() => mapDeleteRestrict({ code: "P2003" }, "no se puede borrar")).toThrow(
      AppError,
    );
    try {
      mapDeleteRestrict({ code: "P2003" }, "no se puede borrar");
    } catch (err) {
      expect((err as AppError).code).toBe("CONFLICT");
    }
  });
  test("otro error se propaga sin tocar", () => {
    const original = { code: "P2025" };
    expect(() => mapDeleteRestrict(original, "x")).toThrow();
    try {
      mapDeleteRestrict(original, "x");
    } catch (err) {
      expect(err).toBe(original);
    }
  });
});
```

- [ ] **Step 3: Verificar que falla**

Run: `npx vitest run tests/lib/prisma-errors.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 4: Implementar `src/lib/prisma-errors.ts`**

```typescript
// Traducción de errores conocidos de Prisma a errores de dominio (ISSUE-13).
// No importa el runtime de Prisma: hace duck-typing del `.code` (P2003, P2025…)
// para no acoplarse a la clase de error ni al bundling.

import { AppError } from "../plugins/errors.js";

/** True si `err` es un error tipo Prisma con el `code` indicado (p. ej. "P2003"). */
export function isPrismaError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

/**
 * Traduce el P2003 (violación de FK Restrict al borrar un recurso con
 * dependientes) al error de dominio CONFLICT (409). Cualquier otro error se
 * propaga intacto.
 */
export function mapDeleteRestrict(err: unknown, message: string): never {
  if (isPrismaError(err, "P2003")) {
    throw new AppError("CONFLICT", message);
  }
  throw err;
}
```

- [ ] **Step 5: Verificar verde + typecheck**

Run: `npx vitest run tests/lib/prisma-errors.test.ts && npm run typecheck`
Expected: PASS; typecheck sin errores (el `Record<ErrorCode, …>` obliga a `CONFLICT` en ambos mapas).

- [ ] **Step 6: Commit**

```bash
git add src/plugins/errors.ts src/lib/prisma-errors.ts tests/lib/prisma-errors.test.ts
git commit -m "feat(errors): CONFLICT (409) y mapDeleteRestrict para borrados con dependientes (ISSUE-13)"
```

---

## Task 2: CRUD de grados (`/admin/grades`)

**Files:** Create `src/modules/catalog/routes.ts`; Modify `src/app.ts`; Create `tests/catalog/grades.integration.test.ts`.

**Interfaces:** Produces el plugin `catalogRoutes({ prisma, jwtSecret })` con las rutas de grados (las de semanas se agregan en Task 3, en el mismo archivo).

- [ ] **Step 1: Crear `src/modules/catalog/routes.ts` con las rutas de grados**

```typescript
// CRUD de catálogo para el admin (ISSUE-13), bajo /api/v1/admin. Solo admin
// (super_admin hereda). El borrado con dependientes lo bloquean las FK Restrict
// (ISSUE-12) → CONFLICT vía mapDeleteRestrict.

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { isPrismaError, mapDeleteRestrict } from "../../lib/prisma-errors.js";

export interface CatalogRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const createGradeBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
} as const;

const updateGradeBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
} as const;

interface IdParams {
  id: string;
}
interface GradeBody {
  name: string;
}

const gradeSelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const catalogRoutes: FastifyPluginAsync<CatalogRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];

  // ── Grados ────────────────────────────────────────────────────────────────
  app.post<{ Body: GradeBody }>(
    "/admin/grades",
    { schema: { body: createGradeBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      const grade = await prisma.grade.create({
        data: { name: request.body.name },
        select: gradeSelect,
      });
      reply.code(201);
      return { data: grade };
    },
  );

  app.get(
    "/admin/grades",
    { preHandler: adminOnly },
    async () => ({
      data: await prisma.grade.findMany({
        select: gradeSelect,
        orderBy: { createdAt: "asc" },
      }),
    }),
  );

  app.get<{ Params: IdParams }>(
    "/admin/grades/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const grade = await prisma.grade.findUnique({
        where: { id: request.params.id },
        select: gradeSelect,
      });
      if (!grade) throw new AppError("NOT_FOUND", "Grado no encontrado.");
      return { data: grade };
    },
  );

  app.patch<{ Params: IdParams; Body: GradeBody }>(
    "/admin/grades/:id",
    {
      schema: { params: idParamsSchema, body: updateGradeBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        const grade = await prisma.grade.update({
          where: { id: request.params.id },
          data: { name: request.body.name },
          select: gradeSelect,
        });
        return { data: grade };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Grado no encontrado.");
        throw err;
      }
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/grades/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.grade.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Grado no encontrado.");
        // Semanas colgando o alumnos asignados (FK Restrict) → CONFLICT.
        mapDeleteRestrict(
          err,
          "No se puede borrar el grado: tiene semanas o alumnos asociados.",
        );
      }
    },
  );
};
```

- [ ] **Step 2: Registrar en `src/app.ts`**

Import: `import { catalogRoutes } from "./modules/catalog/routes.js";`

Registro (junto a `adminRoutes`):

```typescript
  app.register(
    async (scope) => {
      await catalogRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
```

- [ ] **Step 3: Test de integración de grados (necesita BD; auto-salta local)**

Create `tests/catalog/grades.integration.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

const SECRET = "test-secret-at-least-16-chars-long";

function makeClient(): PrismaClient | null {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "")
    return null;
  try {
    return new PrismaClient();
  } catch {
    return null;
  }
}
async function probe(c: PrismaClient | null): Promise<boolean> {
  if (!c) return false;
  try {
    await c.$queryRawUnsafe("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const prisma = makeClient();
const dbAvailable = await probe(prisma);
if (!dbAvailable)
  console.warn("[grades] BD no disponible: se saltan los tests (corren en CI).");
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("CRUD /admin/grades", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let parentToken: string;
  const gradeIds: string[] = [];

  beforeAll(async () => {
    app = buildApp({ jwtSecret: SECRET, prisma: db });
    await app.ready();
    const admin = await db.user.create({
      data: {
        email: `ad-${randomUUID()}@piensa.test`,
        passwordHash: "x",
        role: "admin",
      },
    });
    adminToken = await createAccessToken(SECRET, {
      userId: admin.id,
      role: "admin",
    });
    // Un parent con familia activa para el caso FORBIDDEN.
    const parent = await db.user.create({
      data: {
        email: `pa-${randomUUID()}@piensa.test`,
        passwordHash: "x",
        role: "parent",
      },
    });
    const fam = await db.family.create({
      data: { name: "Fam", parentUserId: parent.id },
    });
    parentToken = await createAccessToken(SECRET, {
      userId: parent.id,
      role: "parent",
      familyId: fam.id,
    });
  });

  afterAll(async () => {
    await db.week.deleteMany({ where: { gradeId: { in: gradeIds } } });
    await db.grade.deleteMany({ where: { id: { in: gradeIds } } });
    await db.family.deleteMany({ where: { name: "Fam" } });
    await db.user.deleteMany({
      where: { email: { contains: "@piensa.test" } },
    });
    await app.close();
    await db.$disconnect();
  });

  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.inject({
      method: method as "POST",
      url: `/api/v1${path}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body ? { payload: body as object } : {}),
    });

  test("crear/leer/actualizar un grado (admin)", async () => {
    const created = await call("POST", "/admin/grades", adminToken, {
      name: "3° Primaria",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id;
    gradeIds.push(id);

    const read = await call("GET", `/admin/grades/${id}`, adminToken);
    expect(read.json().data.name).toBe("3° Primaria");

    const upd = await call("PATCH", `/admin/grades/${id}`, adminToken, {
      name: "4° Primaria",
    });
    expect(upd.json().data.name).toBe("4° Primaria");
  });

  test("nombre vacío → VALIDATION_ERROR", async () => {
    const res = await call("POST", "/admin/grades", adminToken, { name: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("no-admin (parent) → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/grades", parentToken, {
      name: "X",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("borrar un grado con semanas → CONFLICT", async () => {
    const g = await call("POST", "/admin/grades", adminToken, { name: "Con sem" });
    const gid = g.json().data.id;
    gradeIds.push(gid);
    await db.week.create({ data: { gradeId: gid, number: 1, title: "S1" } });

    const del = await call("DELETE", `/admin/grades/${gid}`, adminToken);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("CONFLICT");
  });

  test("borrar un grado vacío → 200", async () => {
    const g = await call("POST", "/admin/grades", adminToken, { name: "Vacío" });
    const gid = g.json().data.id;
    const del = await call("DELETE", `/admin/grades/${gid}`, adminToken);
    expect(del.statusCode).toBe(200);
    const read = await call("GET", `/admin/grades/${gid}`, adminToken);
    expect(read.statusCode).toBe(404);
  });

  test("borrar un grado inexistente → NOT_FOUND", async () => {
    const res = await call("DELETE", `/admin/grades/${randomUUID()}`, adminToken);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});
```

- [ ] **Step 4: Verificar (con BD si está; si no, auto-salta) + typecheck/lint**

Run: `npx vitest run tests/catalog/grades.integration.test.ts && npm run typecheck && npm run lint`
Expected: PASS (o auto-skip local); typecheck/lint limpios.

- [ ] **Step 5: Commit**

```bash
git add src/modules/catalog/routes.ts src/app.ts tests/catalog/grades.integration.test.ts
git commit -m "feat(catalog): CRUD de grados por admin, borrado con contenido → CONFLICT (ISSUE-13)"
```

---

## Task 3: CRUD de semanas (`/admin/weeks`)

**Files:** Modify `src/modules/catalog/routes.ts`; Create `tests/catalog/weeks.integration.test.ts`.

**Interfaces:** Consumes el plugin de Task 2; agrega las rutas de semanas en el mismo archivo.

- [ ] **Step 1: Agregar schemas y rutas de semanas a `catalog/routes.ts`**

Agregar los schemas (junto a los de grados):

```typescript
const createWeekBodySchema = {
  type: "object",
  required: ["gradeId", "number", "title"],
  additionalProperties: false,
  properties: {
    gradeId: { type: "string", pattern: UUID_PATTERN },
    number: { type: "integer", minimum: 1, maximum: 1000 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2000 },
  },
} as const;

const updateWeekBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    number: { type: "integer", minimum: 1, maximum: 1000 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2000 },
  },
} as const;

const weeksQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { gradeId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const weekSelect = {
  id: true,
  gradeId: true,
  number: true,
  title: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface CreateWeekBody {
  gradeId: string;
  number: number;
  title: string;
  description?: string;
}
interface UpdateWeekBody {
  number?: number;
  title?: string;
  description?: string;
}
interface WeeksQuery {
  gradeId?: string;
}
```

Agregar las rutas dentro del plugin (después de las de grados):

```typescript
  // ── Semanas ─────────────────────────────────────────────────────────────
  app.post<{ Body: CreateWeekBody }>(
    "/admin/weeks",
    { schema: { body: createWeekBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      try {
        const week = await prisma.week.create({
          data: request.body,
          select: weekSelect,
        });
        reply.code(201);
        return { data: week };
      } catch (err) {
        if (isPrismaError(err, "P2003"))
          throw new AppError("VALIDATION_ERROR", "El grado indicado no existe.");
        if (isPrismaError(err, "P2002"))
          throw new AppError(
            "CONFLICT",
            "Ya existe una semana con ese número en el grado.",
          );
        throw err;
      }
    },
  );

  app.get<{ Querystring: WeeksQuery }>(
    "/admin/weeks",
    { schema: { querystring: weeksQuerySchema }, preHandler: adminOnly },
    async (request) => ({
      data: await prisma.week.findMany({
        where: request.query.gradeId ? { gradeId: request.query.gradeId } : {},
        select: weekSelect,
        orderBy: [{ gradeId: "asc" }, { number: "asc" }],
      }),
    }),
  );

  app.get<{ Params: IdParams }>(
    "/admin/weeks/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const week = await prisma.week.findUnique({
        where: { id: request.params.id },
        select: weekSelect,
      });
      if (!week) throw new AppError("NOT_FOUND", "Semana no encontrada.");
      return { data: week };
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateWeekBody }>(
    "/admin/weeks/:id",
    {
      schema: { params: idParamsSchema, body: updateWeekBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        const week = await prisma.week.update({
          where: { id: request.params.id },
          data: request.body,
          select: weekSelect,
        });
        return { data: week };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Semana no encontrada.");
        if (isPrismaError(err, "P2002"))
          throw new AppError(
            "CONFLICT",
            "Ya existe una semana con ese número en el grado.",
          );
        throw err;
      }
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/weeks/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.week.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Semana no encontrada.");
        mapDeleteRestrict(
          err,
          "No se puede borrar la semana: tiene lecciones asociadas.",
        );
      }
    },
  );
```

- [ ] **Step 2: Test de integración de semanas**

Create `tests/catalog/weeks.integration.test.ts` (mismo scaffold de skip/DB que grades; siembra un grado por Prisma). Casos:

```typescript
// (scaffold makeClient/probe/skipIf idéntico a grades.integration.test.ts;
//  beforeAll crea admin + un grade base; call() igual.)

  test("crear/listar/actualizar semana (admin)", async () => {
    const created = await call("POST", "/admin/weeks", adminToken, {
      gradeId,
      number: 1,
      title: "Intro",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id;

    const list = await call("GET", `/admin/weeks?gradeId=${gradeId}`, adminToken);
    expect(list.json().data.length).toBeGreaterThanOrEqual(1);

    const upd = await call("PATCH", `/admin/weeks/${id}`, adminToken, {
      title: "Introducción",
    });
    expect(upd.json().data.title).toBe("Introducción");
  });

  test("gradeId inexistente → VALIDATION_ERROR", async () => {
    const res = await call("POST", "/admin/weeks", adminToken, {
      gradeId: randomUUID(),
      number: 9,
      title: "X",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("número duplicado en el grado → CONFLICT", async () => {
    await call("POST", "/admin/weeks", adminToken, { gradeId, number: 5, title: "A" });
    const dup = await call("POST", "/admin/weeks", adminToken, {
      gradeId,
      number: 5,
      title: "B",
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CONFLICT");
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/weeks", parentToken, {
      gradeId,
      number: 2,
      title: "X",
    });
    expect(res.statusCode).toBe(403);
  });

  test("borrar semana con lecciones → CONFLICT", async () => {
    const w = await call("POST", "/admin/weeks", adminToken, {
      gradeId,
      number: 7,
      title: "Con lección",
    });
    const wid = w.json().data.id;
    await db.lesson.create({ data: { weekId: wid, order: 1, type: "video" } });
    const del = await call("DELETE", `/admin/weeks/${wid}`, adminToken);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("CONFLICT");
  });
```

(Cleanup en `afterAll`: borrar `lesson` → `week` → `grade` → users, en ese orden por las FK Restrict.)

- [ ] **Step 3: Verificar + typecheck/lint + commit**

Run: `npx vitest run tests/catalog/weeks.integration.test.ts && npm run typecheck && npm run lint`

```bash
git add src/modules/catalog/routes.ts tests/catalog/weeks.integration.test.ts
git commit -m "feat(catalog): CRUD de semanas por admin (ISSUE-13)"
```

---

## Task 4: Verificación final (con BD) + PR

- [ ] **Step 1:** Postgres desechable (5433) + `migrate deploy` (como en ISSUE-12/35).
- [ ] **Step 2:** `DATABASE_URL=... npx vitest run` → todo verde (grades/weeks integraciones corren).
- [ ] **Step 3:** `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 4:** limpiar contenedor; `git push -u origin feat/issue-13-grades-weeks-crud`; abrir PR hacia `main`; entregar link y parar. Sin footer de atribución.

---

## Self-Review

- CRUD completo con validación JSON Schema por operación (grados y semanas). ✔
- No-admin → FORBIDDEN (tests reales sobre los endpoints). ✔
- Borrado con contenido → rechazo explícito `CONFLICT` (grado con semanas/alumnos; semana con lecciones), vía `mapDeleteRestrict` sobre el `P2003` de las FK Restrict de ISSUE-12. ✔
- `CONFLICT` agregado al catálogo (Task 1). ✔
- Placeholders: ninguno; código completo salvo el scaffold de skip/DB del test de semanas, que replica el de grades (indicado). ✔
- Tipos: `CatalogRoutesOptions`, `gradeSelect`/`weekSelect`, handlers tipados; `isPrismaError`/`mapDeleteRestrict` consistentes con Task 1. ✔
