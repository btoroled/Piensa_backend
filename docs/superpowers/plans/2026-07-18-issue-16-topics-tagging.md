# ISSUE-16 — Topics y etiquetado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline), task por task.

**Goal:** `CRUD /admin/topics` + etiquetar/desetiquetar lecciones y preguntas con topics (agregar/quitar individual). Borrar un topic en uso → rechazo explícito (`CONFLICT`).

**Architecture:** Rutas en un archivo nuevo `src/modules/catalog/topics-routes.ts` (para no engordar más `catalog/routes.ts`), bajo `/api/v1/admin`, solo admin. El etiquetado usa las tablas de join `LessonTopic`/`QuestionTopic` (ISSUE-12): `Cascade` hacia lección/pregunta, `Restrict` hacia el `Topic` → borrar un topic en uso da `P2003` → `CONFLICT` vía `mapDeleteRestrict`.

**Tech Stack:** Fastify · Prisma · PostgreSQL · Vitest.

Diseño aprobado: arquitectura §2.3 (delete→CONFLICT) + forma A del etiquetado (conversación). Issue: `Issues.MD` ISSUE-16.

## Global Constraints

- TDD, commits por task, DoD. `requireRole('admin')`; `additionalProperties: false`; IDs con `UUID_PATTERN`.
- Errores del catálogo; reusa `isPrismaError`/`mapDeleteRestrict` (ISSUE-13).
- Etiquetar es **idempotente** (ya etiquetado → 200 sin duplicar). Tests de BD auto-saltables; ESM `.js`.

## File Structure

- **Create:** `src/modules/catalog/topics-routes.ts` — plugin: topics CRUD + etiquetado.
- **Modify:** `src/app.ts` — registrar `topicsRoutes`.
- **Create test:** `tests/catalog/topics.integration.test.ts`.

---

## Task 1: CRUD de topics

- [ ] **Step 1: Crear `src/modules/catalog/topics-routes.ts` con el CRUD de topics**

```typescript
// Topics y etiquetado (ISSUE-16), bajo /api/v1/admin. Solo admin. Un topic en
// uso no se puede borrar (FK Restrict de LessonTopic/QuestionTopic → CONFLICT).

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { isPrismaError, mapDeleteRestrict } from "../../lib/prisma-errors.js";

export interface TopicsRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const topicBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
} as const;

const tagBodySchema = {
  type: "object",
  required: ["topicId"],
  additionalProperties: false,
  properties: { topicId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const tagParamsSchema = {
  type: "object",
  required: ["id", "topicId"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    topicId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

interface IdParams {
  id: string;
}
interface TopicBody {
  name: string;
}
interface TagBody {
  topicId: string;
}
interface TagParams {
  id: string;
  topicId: string;
}

const topicSelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const topicsRoutes: FastifyPluginAsync<TopicsRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];

  // ── Topics ────────────────────────────────────────────────────────────────
  app.post<{ Body: TopicBody }>(
    "/admin/topics",
    { schema: { body: topicBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      try {
        const topic = await prisma.topic.create({
          data: { name: request.body.name },
          select: topicSelect,
        });
        reply.code(201);
        return { data: topic };
      } catch (err) {
        if (isPrismaError(err, "P2002"))
          throw new AppError("CONFLICT", "Ya existe un topic con ese nombre.");
        throw err;
      }
    },
  );

  app.get("/admin/topics", { preHandler: adminOnly }, async () => ({
    data: await prisma.topic.findMany({
      select: topicSelect,
      orderBy: { name: "asc" },
    }),
  }));

  app.get<{ Params: IdParams }>(
    "/admin/topics/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const topic = await prisma.topic.findUnique({
        where: { id: request.params.id },
        select: topicSelect,
      });
      if (!topic) throw new AppError("NOT_FOUND", "Topic no encontrado.");
      return { data: topic };
    },
  );

  app.patch<{ Params: IdParams; Body: TopicBody }>(
    "/admin/topics/:id",
    {
      schema: { params: idParamsSchema, body: topicBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        const topic = await prisma.topic.update({
          where: { id: request.params.id },
          data: { name: request.body.name },
          select: topicSelect,
        });
        return { data: topic };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Topic no encontrado.");
        if (isPrismaError(err, "P2002"))
          throw new AppError("CONFLICT", "Ya existe un topic con ese nombre.");
        throw err;
      }
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/topics/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.topic.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Topic no encontrado.");
        mapDeleteRestrict(
          err,
          "No se puede borrar el topic: está en uso por lecciones o preguntas.",
        );
      }
    },
  );

  // (etiquetado: Task 2)
};
```

- [ ] **Step 2: Registrar en `src/app.ts`**

Import: `import { topicsRoutes } from "./modules/catalog/topics-routes.js";`

Registro (junto a `catalogRoutes`):

```typescript
  app.register(
    async (scope) => {
      await topicsRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
```

- [ ] **Step 3: Test de integración de topics CRUD (DB)**

Create `tests/catalog/topics.integration.test.ts` con el scaffold habitual (admin + parent con familia). Casos de CRUD:

```typescript
  test("crear/leer/actualizar/listar topic (admin)", async () => {
    const c = await call("POST", "/admin/topics", adminToken, { name: `Frac-${tag}` });
    expect(c.statusCode).toBe(201);
    const id = c.json().data.id;
    topicIds.push(id);
    const r = await call("GET", `/admin/topics/${id}`, adminToken);
    expect(r.json().data.name).toBe(`Frac-${tag}`);
    const u = await call("PATCH", `/admin/topics/${id}`, adminToken, { name: `Fracciones-${tag}` });
    expect(u.json().data.name).toBe(`Fracciones-${tag}`);
  });

  test("nombre duplicado → CONFLICT", async () => {
    await call("POST", "/admin/topics", adminToken, { name: `Dup-${tag}` });
    const dup = await call("POST", "/admin/topics", adminToken, { name: `Dup-${tag}` });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CONFLICT");
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/topics", parentToken, { name: "X" });
    expect(res.statusCode).toBe(403);
  });
```

- [ ] **Step 4: Verificar + commit**

Run: `npm run typecheck && npm run lint && npx vitest run tests/catalog/topics.integration.test.ts`

```bash
git add src/modules/catalog/topics-routes.ts src/app.ts tests/catalog/topics.integration.test.ts
git commit -m "feat(catalog): CRUD de topics por admin (ISSUE-16)"
```

---

## Task 2: Etiquetado de lecciones y preguntas

- [ ] **Step 1: Agregar las rutas de etiquetado a `topics-routes.ts`** (reemplazar `// (etiquetado: Task 2)`)

```typescript
  // ── Etiquetado ──────────────────────────────────────────────────────────
  // Helper: etiquetar es idempotente (ya etiquetado → 200). Un id inexistente
  // (lección/pregunta o topic) → VALIDATION_ERROR.
  const tag = async (
    link: () => Promise<unknown>,
    reply: import("fastify").FastifyReply,
    payload: object,
  ) => {
    try {
      await link();
      reply.code(201);
    } catch (err) {
      if (isPrismaError(err, "P2002")) {
        reply.code(200); // ya etiquetado: idempotente.
      } else if (isPrismaError(err, "P2003")) {
        throw new AppError(
          "VALIDATION_ERROR",
          "El recurso o el topic indicado no existe.",
        );
      } else {
        throw err;
      }
    }
    return { data: payload };
  };

  // Lecciones ↔ topics
  app.post<{ Params: IdParams; Body: TagBody }>(
    "/admin/lessons/:id/topics",
    { schema: { params: idParamsSchema, body: tagBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      const { id: lessonId } = request.params;
      const { topicId } = request.body;
      return tag(
        () => prisma.lessonTopic.create({ data: { lessonId, topicId } }),
        reply,
        { lessonId, topicId, tagged: true },
      );
    },
  );

  app.delete<{ Params: TagParams }>(
    "/admin/lessons/:id/topics/:topicId",
    { schema: { params: tagParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const { id: lessonId, topicId } = request.params;
      try {
        await prisma.lessonTopic.delete({
          where: { lessonId_topicId: { lessonId, topicId } },
        });
        return { data: { lessonId, topicId, tagged: false } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "La etiqueta no existe.");
        throw err;
      }
    },
  );

  app.get<{ Params: IdParams }>(
    "/admin/lessons/:id/topics",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const links = await prisma.lessonTopic.findMany({
        where: { lessonId: request.params.id },
        select: { topic: { select: topicSelect } },
        orderBy: { topic: { name: "asc" } },
      });
      return { data: links.map((l) => l.topic) };
    },
  );

  // Preguntas ↔ topics
  app.post<{ Params: IdParams; Body: TagBody }>(
    "/admin/questions/:id/topics",
    { schema: { params: idParamsSchema, body: tagBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      const { id: questionId } = request.params;
      const { topicId } = request.body;
      return tag(
        () => prisma.questionTopic.create({ data: { questionId, topicId } }),
        reply,
        { questionId, topicId, tagged: true },
      );
    },
  );

  app.delete<{ Params: TagParams }>(
    "/admin/questions/:id/topics/:topicId",
    { schema: { params: tagParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const { id: questionId, topicId } = request.params;
      try {
        await prisma.questionTopic.delete({
          where: { questionId_topicId: { questionId, topicId } },
        });
        return { data: { questionId, topicId, tagged: false } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "La etiqueta no existe.");
        throw err;
      }
    },
  );

  app.get<{ Params: IdParams }>(
    "/admin/questions/:id/topics",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const links = await prisma.questionTopic.findMany({
        where: { questionId: request.params.id },
        select: { topic: { select: topicSelect } },
        orderBy: { topic: { name: "asc" } },
      });
      return { data: links.map((l) => l.topic) };
    },
  );
```

- [ ] **Step 2: Tests de etiquetado (DB)** (agregar al test de integración; `beforeAll` crea grade→week→quiz lesson + una pregunta por Prisma)

```typescript
  test("una pregunta puede tener varios topics; etiquetar es idempotente", async () => {
    const t1 = (await call("POST", "/admin/topics", adminToken, { name: `T1-${tag}` })).json().data.id;
    const t2 = (await call("POST", "/admin/topics", adminToken, { name: `T2-${tag}` })).json().data.id;
    topicIds.push(t1, t2);
    expect((await call("POST", `/admin/questions/${questionId}/topics`, adminToken, { topicId: t1 })).statusCode).toBe(201);
    expect((await call("POST", `/admin/questions/${questionId}/topics`, adminToken, { topicId: t2 })).statusCode).toBe(201);
    // Idempotente: re-etiquetar → 200, sin duplicar.
    expect((await call("POST", `/admin/questions/${questionId}/topics`, adminToken, { topicId: t1 })).statusCode).toBe(200);
    const list = await call("GET", `/admin/questions/${questionId}/topics`, adminToken);
    expect(list.json().data.length).toBe(2);
  });

  test("etiquetar con topic inexistente → VALIDATION_ERROR", async () => {
    const res = await call("POST", `/admin/questions/${questionId}/topics`, adminToken, { topicId: randomUUID() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("borrar un topic en uso → CONFLICT; desetiquetar y luego sí borra", async () => {
    const tid = (await call("POST", "/admin/topics", adminToken, { name: `EnUso-${tag}` })).json().data.id;
    await call("POST", `/admin/lessons/${lessonId}/topics`, adminToken, { topicId: tid });
    const del = await call("DELETE", `/admin/topics/${tid}`, adminToken);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("CONFLICT");
    // Desetiquetar y ahora sí se borra.
    await call("DELETE", `/admin/lessons/${lessonId}/topics/${tid}`, adminToken);
    expect((await call("DELETE", `/admin/topics/${tid}`, adminToken)).statusCode).toBe(200);
  });

  test("desetiquetar algo no etiquetado → NOT_FOUND", async () => {
    const tid = (await call("POST", "/admin/topics", adminToken, { name: `Libre-${tag}` })).json().data.id;
    topicIds.push(tid);
    const res = await call("DELETE", `/admin/lessons/${lessonId}/topics/${tid}`, adminToken);
    expect(res.statusCode).toBe(404);
  });
```

(`afterAll`: borrar lessonTopic/questionTopic (o dejar que Cascade al borrar lesson/question), luego question → lesson → week → grade → topics → family → users.)

- [ ] **Step 3: Verificar + commit**

Run: `npm run typecheck && npm run lint && npx vitest run tests/catalog/topics.integration.test.ts`

```bash
git add src/modules/catalog/topics-routes.ts tests/catalog/topics.integration.test.ts
git commit -m "feat(catalog): etiquetado de lecciones y preguntas con topics (ISSUE-16)"
```

---

## Task 3: Verificación final (con BD) + PR

- [ ] **Step 1:** Postgres desechable (5433) + `migrate deploy`.
- [ ] **Step 2:** `DATABASE_URL=... npx vitest run` → todo verde.
- [ ] **Step 3:** `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 4:** limpiar contenedor; commitear el plan; `git push`; PR hacia `main`; link y parar. Sin footer.

---

## Self-Review

- CRUD /admin/topics con validación por operación; nombre duplicado → CONFLICT. ✔
- Una pregunta puede tener varios topics (test con 2); etiquetar idempotente. ✔
- Borrar un topic en uso → rechazo explícito CONFLICT (FK Restrict → mapDeleteRestrict); desetiquetar y luego borra. ✔
- No-admin → FORBIDDEN. Etiquetado forma A (agregar/quitar/listar) para lecciones y preguntas. ✔
- Archivo separado `topics-routes.ts` para no engordar `catalog/routes.ts`. ✔
