# ISSUE-15 — CRUD de preguntas con registro de tipos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline), task por task.

**Goal:** `CRUD /admin/questions` validado por un `questionTypeRegistry` (JSON Schema de `content` y `answerSpec` por tipo). Agregar un tipo = registrar schemas, **cero migraciones**.

**Architecture:** `Question.type` pasa de enum a `String` (corrección spec↔ISSUE-12, aprobada): el registro es la fuente de verdad de qué tipos existen y valida `content`/`answerSpec` con un `Ajv` propio. Rutas en el módulo `catalog` bajo `/api/v1/admin`, solo admin; la pregunta solo cuelga de una lección `quiz` (`assertLessonAcceptsQuestions`, ISSUE-12).

**Tech Stack:** Fastify · Prisma · PostgreSQL · Ajv · Vitest.

Diseño aprobado: arquitectura §2.5 + formas de tipo v1 + decisión enum→String (conversación). Issue: `Issues.MD` ISSUE-15.

## Global Constraints

- TDD, commits por task, DoD. Seguridad: `requireRole('admin')`; el registro valida el tipo en el servidor (fail-closed) aunque la columna sea String.
- Errores del catálogo; `content`/`answerSpec` inválidos → `VALIDATION_ERROR` **indicando el campo** (vía `ajv.errorsText`).
- Tests de BD auto-saltables; ESM con `.js`.
- El admin **sí** ve `answerSpec` (lo crea); ocultarlo es de ISSUE-21.

## File Structure

- **Modify:** `prisma/schema.prisma` — `Question.type` a `String`; eliminar `enum QuestionType`.
- **Create:** `prisma/migrations/<ts>_question_type_string/migration.sql`.
- **Modify:** `tests/prisma/catalog-schema.test.ts` — ajustar aserciones de `QuestionType`.
- **Modify:** `package.json` — `ajv` en dependencies.
- **Create:** `src/modules/catalog/question-types.ts` — registro + `assertValidQuestion`.
- **Modify:** `src/modules/catalog/routes.ts` — rutas de preguntas.
- **Create tests:** `tests/catalog/question-types.test.ts`, `tests/catalog/questions.integration.test.ts`.

---

## Task 1: `Question.type` a String

- [ ] **Step 1: Ajustar el test estático de ISSUE-12 (falla)**

En `tests/prisma/catalog-schema.test.ts`:
- En el test de enums, **quitar** la aserción de `enum QuestionType` (dejar solo `LessonType`). Renombrar el test a "...tipo de lección".
- Agregar aserción de que `QuestionType` **ya no** es un enum: `expect(schema).not.toMatch(/enum\s+QuestionType/)`.
- En el test de `Question`, cambiar `expect(question).toMatch(/type\s+QuestionType/)` por `expect(question).toMatch(/type\s+String/)`.

- [ ] **Step 2: Correr → falla** (el schema todavía tiene el enum).

Run: `npx vitest run tests/prisma/catalog-schema.test.ts`

- [ ] **Step 3: Editar `prisma/schema.prisma`**

- En `model Question`: `type QuestionType` → `type String`. Actualizar el comentario (el tipo lo valida el registro, no un enum de BD; punto de extensión ISSUE-15).
- **Eliminar** el bloque `enum QuestionType { ... }`.

- [ ] **Step 4: Formatear/validar + test estático verde**

Run: `npx prisma format && DATABASE_URL="postgresql://u:u@localhost:5432/db" npx prisma validate && npx vitest run tests/prisma/catalog-schema.test.ts`

- [ ] **Step 5: Generar migración (offline) + cliente**

```bash
OLD="/tmp/old-15.prisma"; git show HEAD:prisma/schema.prisma > "$OLD"
TS=$(date +%Y%m%d%H%M%S); DIR="prisma/migrations/${TS}_question_type_string"; mkdir -p "$DIR"
npx prisma migrate diff --from-schema-datamodel "$OLD" --to-schema-datamodel prisma/schema.prisma --script > "$DIR/migration.sql"
DATABASE_URL="postgresql://u:u@localhost:5432/db" npx prisma generate
cat "$DIR/migration.sql"
```

Expected: `ALTER TABLE "Question" ALTER COLUMN "type" SET DATA TYPE TEXT` (con `USING` si Prisma lo agrega) + `DROP TYPE "QuestionType"`. **Verificar en Task 4** que aplica contra Postgres real; si el cast enum→text falla, agregar `USING "type"::text` a mano en el `migration.sql`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/prisma/catalog-schema.test.ts
git commit -m "refactor(catalog): Question.type a String para el punto de extensión (ISSUE-15)"
```

---

## Task 2: Registro de tipos de pregunta

- [ ] **Step 1: Agregar `ajv` a dependencies**

Run: `npm pkg set dependencies.ajv="^8.20.0" && npm install`
(ajv ya está resuelto vía Fastify; esto lo declara como dependencia directa.)

- [ ] **Step 2: Test del registro (falla)**

Create `tests/catalog/question-types.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import {
  assertValidQuestion,
  registerQuestionType,
  isRegisteredQuestionType,
} from "../../src/modules/catalog/question-types.js";
import { AppError } from "../../src/plugins/errors.js";

const bad = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    expect((err as AppError).code).toBe("VALIDATION_ERROR");
    return;
  }
  throw new Error("no lanzó VALIDATION_ERROR");
};

describe("questionTypeRegistry — tipos v1", () => {
  test("multiple_choice válido pasa", () => {
    expect(() =>
      assertValidQuestion(
        "multiple_choice",
        { prompt: "¿2+2?", options: ["3", "4"] },
        { correctIndex: 1 },
      ),
    ).not.toThrow();
  });
  test("multiple_choice: correctIndex fuera de rango → error", () => {
    bad(() =>
      assertValidQuestion(
        "multiple_choice",
        { prompt: "?", options: ["a", "b"] },
        { correctIndex: 5 },
      ),
    );
  });
  test("multiple_choice: content sin options → error", () => {
    bad(() =>
      assertValidQuestion("multiple_choice", { prompt: "?" }, { correctIndex: 0 }),
    );
  });
  test("true_false válido pasa; answer no-boolean → error", () => {
    expect(() =>
      assertValidQuestion("true_false", { prompt: "?" }, { answer: true }),
    ).not.toThrow();
    bad(() =>
      assertValidQuestion("true_false", { prompt: "?" }, { answer: "si" }),
    );
  });
  test("fill_blank válido (con flags opcionales) pasa; sin answer → error", () => {
    expect(() =>
      assertValidQuestion(
        "fill_blank",
        { prompt: "?" },
        { answer: "parís", accentSensitive: false },
      ),
    ).not.toThrow();
    bad(() => assertValidQuestion("fill_blank", { prompt: "?" }, {}));
  });
  test("tipo no registrado → error", () => {
    bad(() => assertValidQuestion("no_existe", {}, {}));
  });
});

describe("punto de extensión", () => {
  test("registrar un tipo ficticio: el registro lo valida sin cambios de esquema", () => {
    registerQuestionType("fake_slider", {
      contentSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: { prompt: { type: "string", minLength: 1 } },
      },
      answerSpecSchema: {
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { type: "integer" } },
      },
    });
    expect(isRegisteredQuestionType("fake_slider")).toBe(true);
    expect(() =>
      assertValidQuestion("fake_slider", { prompt: "?" }, { value: 5 }),
    ).not.toThrow();
    bad(() =>
      assertValidQuestion("fake_slider", { prompt: "?" }, { value: "no" }),
    );
  });
});
```

- [ ] **Step 3: Correr → falla** (módulo inexistente).

- [ ] **Step 4: Implementar `src/modules/catalog/question-types.ts`**

```typescript
// Registro de tipos de pregunta (ISSUE-15): el punto de extensión del catálogo.
// Cada tipo declara el JSON Schema de su `content` y su `answerSpec`; el CRUD
// valida contra ellos. Agregar un tipo = registrar schemas (+ su corrector en
// M3), CERO migraciones. La columna Question.type es String; ESTE registro es la
// fuente de verdad de qué tipos son válidos (fail-closed en el servidor).

import Ajv, { type ValidateFunction } from "ajv";
import { AppError } from "../../plugins/errors.js";

export interface QuestionTypeDef {
  contentSchema: Record<string, unknown>;
  answerSpecSchema: Record<string, unknown>;
  /** Coherencia cruzada que el JSON Schema no expresa; devuelve msg de error o null. */
  crossCheck?: (content: unknown, answerSpec: unknown) => string | null;
}

const ajv = new Ajv({ allErrors: true });

interface Compiled {
  def: QuestionTypeDef;
  content: ValidateFunction;
  answerSpec: ValidateFunction;
}
const registry = new Map<string, Compiled>();

export function registerQuestionType(type: string, def: QuestionTypeDef): void {
  registry.set(type, {
    def,
    content: ajv.compile(def.contentSchema),
    answerSpec: ajv.compile(def.answerSpecSchema),
  });
}

export function isRegisteredQuestionType(type: string): boolean {
  return registry.has(type);
}

/** Valida content/answerSpec contra el schema del tipo. Lanza VALIDATION_ERROR. */
export function assertValidQuestion(
  type: string,
  content: unknown,
  answerSpec: unknown,
): void {
  const entry = registry.get(type);
  if (!entry) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Tipo de pregunta no soportado: ${type}.`,
    );
  }
  if (!entry.content(content)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `content inválido: ${ajv.errorsText(entry.content.errors)}`,
    );
  }
  if (!entry.answerSpec(answerSpec)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `answerSpec inválido: ${ajv.errorsText(entry.answerSpec.errors)}`,
    );
  }
  const problem = entry.def.crossCheck?.(content, answerSpec);
  if (problem) throw new AppError("VALIDATION_ERROR", problem);
}

// ── Tipos v1 ────────────────────────────────────────────────────────────────
registerQuestionType("multiple_choice", {
  contentSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt", "options"],
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 2000 },
      options: {
        type: "array",
        minItems: 2,
        maxItems: 10,
        items: { type: "string", minLength: 1, maxLength: 1000 },
      },
    },
  },
  answerSpecSchema: {
    type: "object",
    additionalProperties: false,
    required: ["correctIndex"],
    properties: { correctIndex: { type: "integer", minimum: 0 } },
  },
  crossCheck: (content, answerSpec) => {
    const c = content as { options: string[] };
    const a = answerSpec as { correctIndex: number };
    return a.correctIndex >= c.options.length
      ? "answerSpec.correctIndex está fuera del rango de options."
      : null;
  },
});

registerQuestionType("true_false", {
  contentSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: { prompt: { type: "string", minLength: 1, maxLength: 2000 } },
  },
  answerSpecSchema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "boolean" } },
  },
});

registerQuestionType("fill_blank", {
  contentSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: { prompt: { type: "string", minLength: 1, maxLength: 2000 } },
  },
  answerSpecSchema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: {
      answer: { type: "string", minLength: 1, maxLength: 1000 },
      caseSensitive: { type: "boolean" },
      accentSensitive: { type: "boolean" },
    },
  },
});
```

> Nota: si `import Ajv from "ajv"` falla bajo la config ESM/NodeNext, usar `import { Ajv } from "ajv"` (ajv 8 exporta ambos). Verificar con `npm run typecheck`.

- [ ] **Step 5: Verde + typecheck; Commit**

Run: `npx vitest run tests/catalog/question-types.test.ts && npm run typecheck`

```bash
git add package.json package-lock.json src/modules/catalog/question-types.ts tests/catalog/question-types.test.ts
git commit -m "feat(catalog): questionTypeRegistry con schemas por tipo (ISSUE-15)"
```

---

## Task 3: CRUD de preguntas

- [ ] **Step 1: Agregar schemas, tipos y rutas de preguntas a `catalog/routes.ts`**

Imports:

```typescript
import { assertLessonAcceptsQuestions } from "./questions.js";
import { assertValidQuestion } from "./question-types.js";
```

Schemas + tipos:

```typescript
const createQuestionBodySchema = {
  type: "object",
  required: ["lessonId", "type", "content", "answerSpec"],
  additionalProperties: false,
  properties: {
    lessonId: { type: "string", pattern: UUID_PATTERN },
    type: { type: "string", minLength: 1, maxLength: 50 },
    content: { type: "object" },
    answerSpec: { type: "object" },
    points: { type: "integer", minimum: 1, maximum: 1000 },
  },
} as const;

const updateQuestionBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    content: { type: "object" },
    answerSpec: { type: "object" },
    points: { type: "integer", minimum: 1, maximum: 1000 },
  },
} as const;

const questionsQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { lessonId: { type: "string", pattern: UUID_PATTERN } },
} as const;

interface CreateQuestionBody {
  lessonId: string;
  type: string;
  content: Record<string, unknown>;
  answerSpec: Record<string, unknown>;
  points?: number;
}
interface UpdateQuestionBody {
  content?: Record<string, unknown>;
  answerSpec?: Record<string, unknown>;
  points?: number;
}
interface QuestionsQuery {
  lessonId?: string;
}

const questionSelect = {
  id: true,
  lessonId: true,
  order: true,
  type: true,
  content: true,
  answerSpec: true,
  points: true,
  createdAt: true,
  updatedAt: true,
} as const;
```

Rutas (dentro del plugin, después de las de lecciones):

```typescript
  // ── Preguntas ─────────────────────────────────────────────────────────────
  app.post<{ Body: CreateQuestionBody }>(
    "/admin/questions",
    { schema: { body: createQuestionBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      const { lessonId, type, content, answerSpec, points } = request.body;
      const lesson = await prisma.lesson.findUnique({
        where: { id: lessonId },
        select: { type: true },
      });
      if (!lesson)
        throw new AppError("VALIDATION_ERROR", "La lección indicada no existe.");
      assertLessonAcceptsQuestions({ type: lesson.type }); // solo quiz
      assertValidQuestion(type, content, answerSpec);
      const question = await prisma.$transaction(async (tx) => {
        const agg = await tx.question.aggregate({
          where: { lessonId },
          _max: { order: true },
        });
        return tx.question.create({
          data: {
            lessonId,
            type,
            content,
            answerSpec,
            points: points ?? 1,
            order: (agg._max.order ?? 0) + 1,
          },
          select: questionSelect,
        });
      });
      reply.code(201);
      return { data: question };
    },
  );

  app.get<{ Querystring: QuestionsQuery }>(
    "/admin/questions",
    { schema: { querystring: questionsQuerySchema }, preHandler: adminOnly },
    async (request) => ({
      data: await prisma.question.findMany({
        where: request.query.lessonId
          ? { lessonId: request.query.lessonId }
          : {},
        select: questionSelect,
        orderBy: [{ lessonId: "asc" }, { order: "asc" }],
      }),
    }),
  );

  app.get<{ Params: IdParams }>(
    "/admin/questions/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const question = await prisma.question.findUnique({
        where: { id: request.params.id },
        select: questionSelect,
      });
      if (!question) throw new AppError("NOT_FOUND", "Pregunta no encontrada.");
      return { data: question };
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateQuestionBody }>(
    "/admin/questions/:id",
    {
      schema: { params: idParamsSchema, body: updateQuestionBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      const existing = await prisma.question.findUnique({
        where: { id: request.params.id },
        select: { type: true, content: true, answerSpec: true },
      });
      if (!existing) throw new AppError("NOT_FOUND", "Pregunta no encontrada.");
      const nextContent = request.body.content ?? existing.content;
      const nextSpec = request.body.answerSpec ?? existing.answerSpec;
      // type inmutable: se valida el resultado contra el schema del tipo actual.
      assertValidQuestion(existing.type, nextContent, nextSpec);
      const question = await prisma.question.update({
        where: { id: request.params.id },
        data: {
          content: request.body.content,
          answerSpec: request.body.answerSpec,
          points: request.body.points,
        },
        select: questionSelect,
      });
      return { data: question };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/questions/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        // Sin dependientes que la bloqueen: sus QuestionTopic caen por Cascade.
        await prisma.question.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Pregunta no encontrada.");
        throw err;
      }
    },
  );
```

- [ ] **Step 2: Test de integración (DB)**

Create `tests/catalog/questions.integration.test.ts` (scaffold habitual; `beforeAll` crea admin + grade + week + una lección `quiz` y una `video`). Casos:

```typescript
  test("crear pregunta de cada tipo v1 (order auto)", async () => {
    const mc = await call("POST", "/admin/questions", adminToken, {
      lessonId: quizLessonId, type: "multiple_choice",
      content: { prompt: "¿2+2?", options: ["3", "4"] },
      answerSpec: { correctIndex: 1 },
    });
    expect(mc.statusCode).toBe(201);
    expect(mc.json().data.order).toBe(1);
    const tf = await call("POST", "/admin/questions", adminToken, {
      lessonId: quizLessonId, type: "true_false",
      content: { prompt: "¿El cielo es azul?" }, answerSpec: { answer: true },
    });
    expect(tf.json().data.order).toBe(2);
  });

  test("content inválido → VALIDATION_ERROR indicando el campo", async () => {
    const res = await call("POST", "/admin/questions", adminToken, {
      lessonId: quizLessonId, type: "multiple_choice",
      content: { prompt: "?" }, answerSpec: { correctIndex: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/content/);
  });

  test("pregunta bajo una lección NO quiz → VALIDATION_ERROR", async () => {
    const res = await call("POST", "/admin/questions", adminToken, {
      lessonId: videoLessonId, type: "true_false",
      content: { prompt: "?" }, answerSpec: { answer: true },
    });
    expect(res.statusCode).toBe(400);
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/questions", parentToken, {
      lessonId: quizLessonId, type: "true_false",
      content: { prompt: "?" }, answerSpec: { answer: true },
    });
    expect(res.statusCode).toBe(403);
  });

  test("PATCH cambia points sin reenviar content; borrar → 200", async () => {
    const q = await call("POST", "/admin/questions", adminToken, {
      lessonId: quizLessonId, type: "fill_blank",
      content: { prompt: "Capital de Francia" }, answerSpec: { answer: "París" },
    });
    const id = q.json().data.id;
    const upd = await call("PATCH", `/admin/questions/${id}`, adminToken, { points: 5 });
    expect(upd.json().data.points).toBe(5);
    const del = await call("DELETE", `/admin/questions/${id}`, adminToken);
    expect(del.statusCode).toBe(200);
  });

  test("punto de extensión: registrar tipo ficticio y crearlo por el CRUD (sin migración)", async () => {
    registerQuestionType("fake_slider", {
      contentSchema: { type: "object", additionalProperties: false, required: ["prompt"], properties: { prompt: { type: "string", minLength: 1 } } },
      answerSpecSchema: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "integer" } } },
    });
    const res = await call("POST", "/admin/questions", adminToken, {
      lessonId: quizLessonId, type: "fake_slider",
      content: { prompt: "Deslizá" }, answerSpec: { value: 7 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.type).toBe("fake_slider");
  });
```

(Import `registerQuestionType` en el test. `afterAll`: borrar question → lesson → week → grade → family → users.)

- [ ] **Step 3: Verificar + commit**

Run: `npm run typecheck && npm run lint && npx vitest run tests/catalog/questions.integration.test.ts`

```bash
git add src/modules/catalog/routes.ts tests/catalog/questions.integration.test.ts
git commit -m "feat(catalog): CRUD de preguntas validado por el registro de tipos (ISSUE-15)"
```

---

## Task 4: Verificación final (con BD) + PR

- [ ] **Step 1:** Postgres desechable (5433) + `migrate deploy`. **Verificar que la migración enum→String aplica**; si el cast falla, agregar `USING "type"::text` al `migration.sql` y reintentar.
- [ ] **Step 2:** `DATABASE_URL=... npx vitest run` → todo verde (incluye el tipo ficticio insertado por el CRUD).
- [ ] **Step 3:** `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 4:** limpiar contenedor; commitear el plan; `git push`; PR hacia `main`; link y parar. Sin footer de atribución.

---

## Self-Review

- Crear pregunta de cada tipo v1 con content/answerSpec válidos; inválidos → VALIDATION_ERROR indicando el campo → registro (Task 2) + CRUD (Task 3) + tests. ✔
- Test que registra un tipo ficticio y el CRUD lo acepta sin cambios de esquema → posible porque `type` es String (Task 1) + test de extensión unitario y de integración. ✔
- Pregunta solo bajo lección quiz (reusa assertLessonAcceptsQuestions); order auto; type inmutable; admin ve answerSpec. ✔
- `Question.type` enum→String: corrige el desajuste spec↔ISSUE-12 (regla SDD 1, aprobado). ✔
- Riesgo: cast enum→text en la migración (Task 1 Step 5 / Task 4 Step 1). ✔
