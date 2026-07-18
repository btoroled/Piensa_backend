# ISSUE-14 — CRUD de lecciones y reordenamiento — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline), task por task.

**Goal:** CRUD de `/admin/lessons` con payload validado por `type`, `order` auto-asignado al crear, y `POST /admin/lessons/reorder` que reordena una semana de forma atómica (todo o nada).

**Architecture:** Rutas en el módulo `catalog` bajo `/api/v1/admin`, solo admin. La regla "payload ↔ type" se valida con un validador puro de servicio (`assertValidLessonPayload`). El `order` lo asigna el servidor (append). El reorder aplica una actualización en dos fases dentro de una transacción para no chocar con `@@unique([weekId, order])`.

**Tech Stack:** Fastify · Prisma · PostgreSQL · Vitest.

Diseño aprobado: arquitectura §2.6 (reorder) + decisiones de forma del CRUD aprobadas en la conversación (order auto, type inmutable, validador puro, reorder de conjunto exacto). Issue: `Issues.MD` ISSUE-14.

## Global Constraints

- TDD, commits por task, DoD (validación por ruta, errores del catálogo, no-admin → FORBIDDEN, CI verde).
- Seguridad: `requireRole('admin')`; `additionalProperties: false`; IDs con `UUID_PATTERN`; `embedUrl` restringido a `https://` (evita `javascript:`/`data:` embebidos).
- Errores del catálogo (`VALIDATION_ERROR`, `CONFLICT`, `NOT_FOUND`). Reusa `mapDeleteRestrict`/`isPrismaError` (ISSUE-13).
- Tests de BD auto-saltables; ESM con `.js`.

## File Structure

- **Create:** `src/modules/catalog/lessons.ts` — `assertValidLessonPayload`, `reorderLessons`.
- **Modify:** `src/modules/catalog/routes.ts` — rutas de lecciones + reorder.
- **Create tests:** `tests/catalog/lesson-payload.test.ts` (unit del validador), `tests/catalog/lessons.integration.test.ts` (CRUD + reorder, DB).

---

## Task 1: Validador de payload por tipo

**Files:** Create `src/modules/catalog/lessons.ts` (validador), `tests/catalog/lesson-payload.test.ts`.

**Interfaces:** Produces `assertValidLessonPayload(type: LessonType, payload: LessonPayload): void` — consumido por las rutas create/patch (Task 2).

- [ ] **Step 1: Test del validador (falla)**

Create `tests/catalog/lesson-payload.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { assertValidLessonPayload } from "../../src/modules/catalog/lessons.js";
import { AppError } from "../../src/plugins/errors.js";

const bad = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("VALIDATION_ERROR");
    return;
  }
  throw new Error("no lanzó VALIDATION_ERROR");
};

describe("assertValidLessonPayload", () => {
  test("video: embedUrl válido pasa", () => {
    expect(() =>
      assertValidLessonPayload("video", { embedUrl: "https://x.test/v" }),
    ).not.toThrow();
  });
  test("video sin embedUrl → error", () => {
    bad(() => assertValidLessonPayload("video", {}));
  });
  test("video con fileKey (cruzado) → error", () => {
    bad(() =>
      assertValidLessonPayload("video", {
        embedUrl: "https://x.test/v",
        fileKey: "k",
      }),
    );
  });

  test("reading con richContent pasa", () => {
    expect(() =>
      assertValidLessonPayload("reading", { richContent: "Hola" }),
    ).not.toThrow();
  });
  test("reading con fileKey pasa", () => {
    expect(() =>
      assertValidLessonPayload("reading", { fileKey: "lessons/x.pdf" }),
    ).not.toThrow();
  });
  test("reading vacío → error", () => {
    bad(() => assertValidLessonPayload("reading", {}));
  });
  test("reading con embedUrl (cruzado) → error", () => {
    bad(() =>
      assertValidLessonPayload("reading", {
        richContent: "Hola",
        embedUrl: "https://x.test/v",
      }),
    );
  });

  test("quiz vacío pasa", () => {
    expect(() => assertValidLessonPayload("quiz", {})).not.toThrow();
  });
  test("quiz con cualquier campo → error", () => {
    bad(() => assertValidLessonPayload("quiz", { embedUrl: "https://x.test/v" }));
    bad(() => assertValidLessonPayload("quiz", { fileKey: "k" }));
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run tests/catalog/lesson-payload.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 3: Implementar `src/modules/catalog/lessons.ts` (validador)**

```typescript
// Lógica de dominio de las lecciones del catálogo (ISSUE-14). Funciones puras /
// de servicio, sin acoplarse a Fastify. El validador de payload por tipo y el
// reordenamiento atómico viven acá; las rutas (routes.ts) las cablean.

import type { LessonType, PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";

/** Campos de contenido de una lección; solo aplica el del `type`. */
export interface LessonPayload {
  embedUrl?: string;
  richContent?: string;
  fileKey?: string;
}

const present = (v?: string): boolean => v !== undefined && v !== null;

/**
 * Valida que el payload coincida con el tipo (criterio ISSUE-14):
 * - video   → requiere embedUrl; nada de richContent/fileKey.
 * - reading → al menos uno de richContent/fileKey; nada de embedUrl.
 * - quiz    → ningún campo de contenido (se crea vacío).
 * Lanza VALIDATION_ERROR si no cumple.
 */
export function assertValidLessonPayload(
  type: LessonType,
  p: LessonPayload,
): void {
  if (type === "video") {
    if (!present(p.embedUrl))
      throw new AppError(
        "VALIDATION_ERROR",
        "Una lección de video requiere embedUrl.",
      );
    if (present(p.richContent) || present(p.fileKey))
      throw new AppError(
        "VALIDATION_ERROR",
        "Una lección de video solo admite embedUrl.",
      );
    return;
  }
  if (type === "reading") {
    if (!present(p.richContent) && !present(p.fileKey))
      throw new AppError(
        "VALIDATION_ERROR",
        "Una lección de lectura requiere richContent o fileKey.",
      );
    if (present(p.embedUrl))
      throw new AppError(
        "VALIDATION_ERROR",
        "Una lección de lectura no admite embedUrl.",
      );
    return;
  }
  // quiz
  if (present(p.embedUrl) || present(p.richContent) || present(p.fileKey))
    throw new AppError(
      "VALIDATION_ERROR",
      "Una lección de quiz no admite campos de contenido.",
    );
}
```

- [ ] **Step 4: Verificar verde**

Run: `npx vitest run tests/catalog/lesson-payload.test.ts` → PASS (11 casos).

- [ ] **Step 5: Commit**

```bash
git add src/modules/catalog/lessons.ts tests/catalog/lesson-payload.test.ts
git commit -m "feat(catalog): validador de payload de lección por tipo (ISSUE-14)"
```

---

## Task 2: CRUD de lecciones

**Files:** Modify `src/modules/catalog/routes.ts`; Create `tests/catalog/lessons.integration.test.ts`.

**Interfaces:** Consume `assertValidLessonPayload` (Task 1), `isPrismaError`/`mapDeleteRestrict` (ISSUE-13).

- [ ] **Step 1: Agregar schemas, tipos y rutas de lecciones a `catalog/routes.ts`**

Imports (agregar arriba):

```typescript
import type { LessonType } from "@prisma/client";
import {
  assertValidLessonPayload,
  reorderLessons,
} from "./lessons.js";
```

Schemas (junto a los de semanas):

```typescript
const lessonContentProps = {
  embedUrl: {
    type: "string",
    maxLength: 2000,
    pattern: "^https://[^\\s]+$",
  },
  richContent: { type: "string", maxLength: 100000 },
  fileKey: { type: "string", maxLength: 500 },
} as const;

const createLessonBodySchema = {
  type: "object",
  required: ["weekId", "type"],
  additionalProperties: false,
  properties: {
    weekId: { type: "string", pattern: UUID_PATTERN },
    type: { type: "string", enum: ["video", "reading", "quiz"] },
    ...lessonContentProps,
  },
} as const;

const updateLessonBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: { ...lessonContentProps },
} as const;

const lessonsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { weekId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const reorderBodySchema = {
  type: "object",
  required: ["weekId", "orderedIds"],
  additionalProperties: false,
  properties: {
    weekId: { type: "string", pattern: UUID_PATTERN },
    orderedIds: {
      type: "array",
      minItems: 1,
      maxItems: 1000,
      uniqueItems: true,
      items: { type: "string", pattern: UUID_PATTERN },
    },
  },
} as const;

interface CreateLessonBody {
  weekId: string;
  type: LessonType;
  embedUrl?: string;
  richContent?: string;
  fileKey?: string;
}
interface UpdateLessonBody {
  embedUrl?: string;
  richContent?: string;
  fileKey?: string;
}
interface LessonsQuery {
  weekId?: string;
}
interface ReorderBody {
  weekId: string;
  orderedIds: string[];
}

const lessonSelect = {
  id: true,
  weekId: true,
  order: true,
  type: true,
  embedUrl: true,
  richContent: true,
  fileKey: true,
  createdAt: true,
  updatedAt: true,
} as const;
```

Rutas (dentro del plugin, después de las de semanas). **La ruta `/admin/lessons/reorder` se declara ANTES que `/admin/lessons/:id`** para que Fastify no la matchee como `:id`:

```typescript
  // ── Lecciones ─────────────────────────────────────────────────────────────
  app.post<{ Body: CreateLessonBody }>(
    "/admin/lessons",
    { schema: { body: createLessonBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      const { weekId, type, embedUrl, richContent, fileKey } = request.body;
      assertValidLessonPayload(type, { embedUrl, richContent, fileKey });
      try {
        // order auto-asignado (append): max(order) de la semana + 1, atómico.
        const lesson = await prisma.$transaction(async (tx) => {
          const agg = await tx.lesson.aggregate({
            where: { weekId },
            _max: { order: true },
          });
          return tx.lesson.create({
            data: {
              weekId,
              type,
              order: (agg._max.order ?? 0) + 1,
              embedUrl,
              richContent,
              fileKey,
            },
            select: lessonSelect,
          });
        });
        reply.code(201);
        return { data: lesson };
      } catch (err) {
        if (isPrismaError(err, "P2003"))
          throw new AppError("VALIDATION_ERROR", "La semana indicada no existe.");
        throw err;
      }
    },
  );

  app.get<{ Querystring: LessonsQuery }>(
    "/admin/lessons",
    { schema: { querystring: lessonsQuerySchema }, preHandler: adminOnly },
    async (request) => ({
      data: await prisma.lesson.findMany({
        where: request.query.weekId ? { weekId: request.query.weekId } : {},
        select: lessonSelect,
        orderBy: [{ weekId: "asc" }, { order: "asc" }],
      }),
    }),
  );

  app.post<{ Body: ReorderBody }>(
    "/admin/lessons/reorder",
    { schema: { body: reorderBodySchema }, preHandler: adminOnly },
    async (request) => {
      await reorderLessons(prisma, request.body.weekId, request.body.orderedIds);
      return {
        data: await prisma.lesson.findMany({
          where: { weekId: request.body.weekId },
          select: lessonSelect,
          orderBy: { order: "asc" },
        }),
      };
    },
  );

  app.get<{ Params: IdParams }>(
    "/admin/lessons/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const lesson = await prisma.lesson.findUnique({
        where: { id: request.params.id },
        select: lessonSelect,
      });
      if (!lesson) throw new AppError("NOT_FOUND", "Lección no encontrada.");
      return { data: lesson };
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateLessonBody }>(
    "/admin/lessons/:id",
    {
      schema: { params: idParamsSchema, body: updateLessonBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      const existing = await prisma.lesson.findUnique({
        where: { id: request.params.id },
        select: { type: true },
      });
      if (!existing) throw new AppError("NOT_FOUND", "Lección no encontrada.");
      // PATCH reemplaza el contenido del tipo actual (type inmutable): el nuevo
      // conjunto de campos debe ser válido para ese tipo. Los campos ausentes
      // quedan en null.
      const { embedUrl, richContent, fileKey } = request.body;
      assertValidLessonPayload(existing.type, { embedUrl, richContent, fileKey });
      const lesson = await prisma.lesson.update({
        where: { id: request.params.id },
        data: {
          embedUrl: embedUrl ?? null,
          richContent: richContent ?? null,
          fileKey: fileKey ?? null,
        },
        select: lessonSelect,
      });
      return { data: lesson };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/lessons/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.lesson.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Lección no encontrada.");
        mapDeleteRestrict(
          err,
          "No se puede borrar la lección: tiene preguntas asociadas.",
        );
      }
    },
  );
```

- [ ] **Step 2: Placeholder de `reorderLessons`** (para que compile; se implementa en Task 3)

En `src/modules/catalog/lessons.ts` agregar temporalmente:

```typescript
export async function reorderLessons(
  _prisma: PrismaClient,
  _weekId: string,
  _orderedIds: string[],
): Promise<void> {
  throw new AppError("INTERNAL", "reorder no implementado");
}
```

(Task 3 reemplaza el cuerpo. Así Task 2 compila y sus tests de CRUD corren sin depender del reorder.)

- [ ] **Step 3: Test de integración de CRUD (DB)**

Create `tests/catalog/lessons.integration.test.ts` con el scaffold habitual (makeClient/probe/skipIf; `beforeAll` crea admin + parent con familia + un grade + una week base; `call()` igual a los otros). Casos de CRUD (el reorder se agrega en Task 3):

```typescript
  test("crear video/lectura/quiz con su payload; order auto-incremental", async () => {
    const v = await call("POST", "/admin/lessons", adminToken, {
      weekId, type: "video", embedUrl: "https://x.test/v",
    });
    expect(v.statusCode).toBe(201);
    expect(v.json().data.order).toBe(1);
    const r = await call("POST", "/admin/lessons", adminToken, {
      weekId, type: "reading", richContent: "Hola",
    });
    expect(r.json().data.order).toBe(2);
    const q = await call("POST", "/admin/lessons", adminToken, {
      weekId, type: "quiz",
    });
    expect(q.json().data.order).toBe(3);
  });

  test("payload de tipo cruzado → VALIDATION_ERROR", async () => {
    const res = await call("POST", "/admin/lessons", adminToken, {
      weekId, type: "video", fileKey: "k",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("embedUrl no-https → VALIDATION_ERROR (schema)", async () => {
    const res = await call("POST", "/admin/lessons", adminToken, {
      weekId, type: "video", embedUrl: "http://x.test/v",
    });
    expect(res.statusCode).toBe(400);
  });

  test("weekId inexistente → VALIDATION_ERROR", async () => {
    const res = await call("POST", "/admin/lessons", adminToken, {
      weekId: randomUUID(), type: "quiz",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/lessons", parentToken, {
      weekId, type: "quiz",
    });
    expect(res.statusCode).toBe(403);
  });

  test("PATCH cambia el contenido del tipo; cruzado → VALIDATION_ERROR", async () => {
    const l = await call("POST", "/admin/lessons", adminToken, {
      weekId, type: "reading", richContent: "A",
    });
    const id = l.json().data.id;
    const ok = await call("PATCH", `/admin/lessons/${id}`, adminToken, {
      fileKey: "lessons/x.pdf",
    });
    expect(ok.json().data.fileKey).toBe("lessons/x.pdf");
    expect(ok.json().data.richContent).toBeNull();
    const bad = await call("PATCH", `/admin/lessons/${id}`, adminToken, {
      embedUrl: "https://x.test/v",
    });
    expect(bad.statusCode).toBe(400);
  });

  test("borrar lección con preguntas → CONFLICT", async () => {
    const q = await call("POST", "/admin/lessons", adminToken, {
      weekId, type: "quiz",
    });
    const qid = q.json().data.id;
    await db.question.create({
      data: { lessonId: qid, order: 1, type: "true_false", content: {}, answerSpec: {} },
    });
    const del = await call("DELETE", `/admin/lessons/${qid}`, adminToken);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("CONFLICT");
  });
```

(`afterAll`: borrar en orden question → lesson → week → grade → family → users.)

- [ ] **Step 4: Verificar (typecheck/lint + tests con auto-skip) y commit**

Run: `npm run typecheck && npm run lint && npx vitest run tests/catalog/lessons.integration.test.ts`

```bash
git add src/modules/catalog/routes.ts src/modules/catalog/lessons.ts tests/catalog/lessons.integration.test.ts
git commit -m "feat(catalog): CRUD de lecciones con payload por tipo y order auto (ISSUE-14)"
```

---

## Task 3: Reorder atómico en dos fases

**Files:** Modify `src/modules/catalog/lessons.ts` (implementar `reorderLessons`); Modify `tests/catalog/lessons.integration.test.ts` (casos de reorder).

**Interfaces:** `reorderLessons(prisma, weekId, orderedIds)` — valida conjunto exacto y aplica en transacción.

- [ ] **Step 1: Implementar `reorderLessons`** (reemplaza el placeholder)

```typescript
/**
 * Reordena las lecciones de una semana (ISSUE-14). `orderedIds` debe ser
 * EXACTAMENTE el conjunto de lecciones de la semana (ni ajenas ni faltantes) o
 * se rechaza entero (VALIDATION_ERROR), sin tocar nada. Se aplica en dos fases
 * dentro de una transacción para no chocar con @@unique([weekId, order]):
 * primero a órdenes temporales negativos, luego a 1..N.
 */
export async function reorderLessons(
  prisma: PrismaClient,
  weekId: string,
  orderedIds: string[],
): Promise<void> {
  const current = await prisma.lesson.findMany({
    where: { weekId },
    select: { id: true },
  });
  const currentIds = new Set(current.map((l) => l.id));
  const sameSize = currentIds.size === orderedIds.length;
  const allBelong = orderedIds.every((id) => currentIds.has(id));
  if (!sameSize || !allBelong) {
    throw new AppError(
      "VALIDATION_ERROR",
      "La lista debe ser exactamente las lecciones de la semana.",
    );
  }
  await prisma.$transaction([
    // Fase 1: órdenes temporales negativos (sin colisión con los positivos).
    ...orderedIds.map((id, i) =>
      prisma.lesson.update({ where: { id }, data: { order: -(i + 1) } }),
    ),
    // Fase 2: órdenes finales 1..N según la posición en orderedIds.
    ...orderedIds.map((id, i) =>
      prisma.lesson.update({ where: { id }, data: { order: i + 1 } }),
    ),
  ]);
}
```

(Quitar el import placeholder si quedó sin usar; `PrismaClient` y `AppError` ya están importados.)

- [ ] **Step 2: Casos de reorder en el test de integración**

```typescript
  test("reorder aplica el nuevo orden (atómico)", async () => {
    // Semana fresca con 3 lecciones (orders 1,2,3).
    const w = await db.week.create({ data: { gradeId, number: 50, title: "R" } });
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const l = await db.lesson.create({
        data: { weekId: w.id, order: n, type: "quiz" },
      });
      ids.push(l.id);
    }
    const res = await call("POST", "/admin/lessons/reorder", adminToken, {
      weekId: w.id,
      orderedIds: [ids[2], ids[0], ids[1]],
    });
    expect(res.statusCode).toBe(200);
    const ordered = res.json().data.map((l: { id: string }) => l.id);
    expect(ordered).toEqual([ids[2], ids[0], ids[1]]);
  });

  test("reorder con un ID de otra semana → rechazo total, nada cambia", async () => {
    const w = await db.week.create({ data: { gradeId, number: 51, title: "R2" } });
    const a = await db.lesson.create({ data: { weekId: w.id, order: 1, type: "quiz" } });
    const b = await db.lesson.create({ data: { weekId: w.id, order: 2, type: "quiz" } });
    const foreign = await db.lesson.create({
      data: { weekId, order: 999, type: "quiz" },
    });
    const res = await call("POST", "/admin/lessons/reorder", adminToken, {
      weekId: w.id,
      orderedIds: [b.id, foreign.id],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    // Nada cambió: a=1, b=2 siguen igual.
    const after = await db.lesson.findMany({
      where: { weekId: w.id },
      orderBy: { order: "asc" },
      select: { id: true, order: true },
    });
    expect(after).toEqual([
      { id: a.id, order: 1 },
      { id: b.id, order: 2 },
    ]);
  });

  test("reorder incompleto (falta una) → rechazo", async () => {
    const w = await db.week.create({ data: { gradeId, number: 52, title: "R3" } });
    const a = await db.lesson.create({ data: { weekId: w.id, order: 1, type: "quiz" } });
    await db.lesson.create({ data: { weekId: w.id, order: 2, type: "quiz" } });
    const res = await call("POST", "/admin/lessons/reorder", adminToken, {
      weekId: w.id,
      orderedIds: [a.id],
    });
    expect(res.statusCode).toBe(400);
  });
```

- [ ] **Step 3: Verificar + commit**

Run: `npm run typecheck && npm run lint && npx vitest run tests/catalog/lessons.integration.test.ts`

```bash
git add src/modules/catalog/lessons.ts tests/catalog/lessons.integration.test.ts
git commit -m "feat(catalog): reorder atómico de lecciones en dos fases (ISSUE-14)"
```

---

## Task 4: Verificación final (con BD) + PR

- [ ] **Step 1:** Postgres desechable (5433) + `migrate deploy`.
- [ ] **Step 2:** `DATABASE_URL=... npx vitest run` → todo verde (lecciones + reorder corren de verdad).
- [ ] **Step 3:** `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 4:** limpiar contenedor; commitear el plan; `git push -u origin feat/issue-14-lessons-reorder`; PR hacia `main`; link y parar. Sin footer de atribución.

---

## Self-Review

- Crear lección de cada tipo con su payload; tipo cruzado → VALIDATION_ERROR → validador (Task 1) + create (Task 2) + tests. ✔
- Reorder con ID de otra semana → rechazo total, nada parcial (transacción) → Task 3 + test que verifica que nada cambió. ✔
- `order` auto (append), `type` inmutable en PATCH, reorder de conjunto exacto — decisiones aprobadas. ✔
- No-admin → FORBIDDEN; borrar lección con preguntas → CONFLICT (reusa mapDeleteRestrict). ✔
- Orden de rutas: `/admin/lessons/reorder` antes de `/admin/lessons/:id`. ✔
- Placeholders: `reorderLessons` es placeholder explícito en Task 2 y se implementa en Task 3 (no es un TODO colgante). ✔
