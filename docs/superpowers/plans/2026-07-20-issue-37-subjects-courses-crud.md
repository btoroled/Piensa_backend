# ISSUE-37 — CRUD de materias y cursos + prerrequisitos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline), task por task.

**Goal:** `CRUD /admin/subjects` y `/admin/courses`, y gestión de prerrequisitos curso→curso con validación de que no haya ciclos (estilo Moodle). Solo admin.

**Architecture:** Rutas en `src/modules/catalog/subjects-courses-routes.ts` (para no engordar `catalog/routes.ts`), bajo `/api/v1/admin`. La detección de ciclos vive en `src/modules/catalog/courses.ts` (función pura, unit-testeada). Reusa `mapDeleteRestrict`/`isPrismaError` (ISSUE-13) y `UUID_PATTERN` (validation.ts). El re-anclaje de `/admin/weeks` a `courseId` ya se hizo en ISSUE-36.

**Tech Stack:** Fastify · Prisma · PostgreSQL · Vitest.

Diseño aprobado: `docs/superpowers/specs/2026-07-19-milestone-2.5-subjects-courses-enrollment.md` + forma del CRUD (conversación). Issue: `Issues.MD` ISSUE-37.

## Global Constraints

- TDD, commits por task, DoD. `requireRole('admin')`; `additionalProperties: false`; IDs con `UUID_PATTERN`.
- Errores del catálogo: borrar en uso → `CONFLICT`; duplicados → `CONFLICT`; FK inexistente → `VALIDATION_ERROR`; ciclo de prereq → `VALIDATION_ERROR`.
- Tests de BD auto-saltables; ESM `.js`. `subjectId`/`gradeId` de un curso inmutables en PATCH.

## File Structure

- **Create:** `src/modules/catalog/courses.ts` — `wouldCreatePrereqCycle` (pura).
- **Create:** `src/modules/catalog/subjects-courses-routes.ts` — CRUD + prereqs.
- **Modify:** `src/app.ts` — registrar `subjectsCoursesRoutes`.
- **Create tests:** `tests/catalog/prereq-cycle.test.ts` (unit), `tests/catalog/subjects-courses.integration.test.ts` (DB).

---

## Task 1: Detección de ciclos de prerrequisitos

- [ ] **Step 1: Test (falla)**

Create `tests/catalog/prereq-cycle.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { wouldCreatePrereqCycle } from "../../src/modules/catalog/courses.js";

// Grafo de prereqs en memoria: id → prerrequisitos directos.
const graph: Record<string, string[]> = {
  a: [], // 1° (sin prereq)
  b: ["a"], // 2° requiere 1°
  c: ["b"], // 3° requiere 2°
};
const getRequires = async (id: string) => graph[id] ?? [];

describe("wouldCreatePrereqCycle", () => {
  test("agregar una arista que no cierra ciclo → false", async () => {
    // c ya requiere b→a; agregar "a requiere <nuevo d>" no cierra ciclo.
    expect(await wouldCreatePrereqCycle(getRequires, "a", "d")).toBe(false);
  });
  test("auto-prerrequisito (A requiere A) → true", async () => {
    expect(await wouldCreatePrereqCycle(getRequires, "a", "a")).toBe(true);
  });
  test("cerrar el ciclo (1° requiere 3°, con 3°→2°→1°) → true", async () => {
    // a ya es alcanzado por c; agregar "a requiere c" cierra a→c→b→a.
    expect(await wouldCreatePrereqCycle(getRequires, "a", "c")).toBe(true);
  });
  test("ciclo directo (2° requiere... y luego 1° requiere 2°) → true", async () => {
    expect(await wouldCreatePrereqCycle(getRequires, "a", "b")).toBe(true);
  });
});
```

- [ ] **Step 2: Correr → falla.** `npx vitest run tests/catalog/prereq-cycle.test.ts`

- [ ] **Step 3: Implementar `src/modules/catalog/courses.ts`**

```typescript
// Lógica de dominio de los cursos (ISSUE-37). Detección de ciclos en el grafo de
// prerrequisitos: pura, recibe una función para leer los prereqs directos.

/**
 * ¿Agregar "courseId requiere requiresCourseId" crearía un ciclo? Se forma un
 * ciclo si requiresCourseId ya alcanza (transitivamente) a courseId por sus
 * prerrequisitos, o si son el mismo curso. `getRequires` devuelve los
 * prerrequisitos directos de un curso.
 */
export async function wouldCreatePrereqCycle(
  getRequires: (courseId: string) => Promise<string[]>,
  courseId: string,
  requiresCourseId: string,
): Promise<boolean> {
  if (courseId === requiresCourseId) return true;
  const seen = new Set<string>();
  const stack: string[] = [requiresCourseId];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === courseId) return true; // requiresCourseId alcanza a courseId.
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const r of await getRequires(cur)) stack.push(r);
  }
  return false;
}
```

- [ ] **Step 4: Verde + commit**

`npx vitest run tests/catalog/prereq-cycle.test.ts && npm run typecheck`

```bash
git add src/modules/catalog/courses.ts tests/catalog/prereq-cycle.test.ts
git commit -m "feat(catalog): detección de ciclos de prerrequisitos de cursos (ISSUE-37)"
```

---

## Task 2: CRUD de materias y cursos

- [ ] **Step 1: Crear `src/modules/catalog/subjects-courses-routes.ts`**

```typescript
// CRUD de materias y cursos + prerrequisitos (ISSUE-37), bajo /api/v1/admin.
// Solo admin. Borrar en uso → CONFLICT; duplicados → CONFLICT; FK mala →
// VALIDATION_ERROR; ciclo de prereq → VALIDATION_ERROR.

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { isPrismaError, mapDeleteRestrict } from "../../lib/prisma-errors.js";
import { wouldCreatePrereqCycle } from "./courses.js";

export interface SubjectsCoursesRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const subjectBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
} as const;

const createCourseBodySchema = {
  type: "object",
  required: ["subjectId", "gradeId", "title"],
  additionalProperties: false,
  properties: {
    subjectId: { type: "string", pattern: UUID_PATTERN },
    gradeId: { type: "string", pattern: UUID_PATTERN },
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2000 },
  },
} as const;

const updateCourseBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2000 },
  },
} as const;

const coursesQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    subjectId: { type: "string", pattern: UUID_PATTERN },
    gradeId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const prereqBodySchema = {
  type: "object",
  required: ["requiresCourseId"],
  additionalProperties: false,
  properties: { requiresCourseId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const prereqParamsSchema = {
  type: "object",
  required: ["id", "requiresCourseId"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    requiresCourseId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

interface IdParams {
  id: string;
}
interface SubjectBody {
  name: string;
}
interface CreateCourseBody {
  subjectId: string;
  gradeId: string;
  title: string;
  description?: string;
}
interface UpdateCourseBody {
  title?: string;
  description?: string;
}
interface CoursesQuery {
  subjectId?: string;
  gradeId?: string;
}
interface PrereqBody {
  requiresCourseId: string;
}
interface PrereqParams {
  id: string;
  requiresCourseId: string;
}

const subjectSelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;
const courseSelect = {
  id: true,
  subjectId: true,
  gradeId: true,
  title: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const subjectsCoursesRoutes: FastifyPluginAsync<
  SubjectsCoursesRoutesOptions
> = async (app, opts) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];

  // ── Materias ──────────────────────────────────────────────────────────────
  app.post<{ Body: SubjectBody }>(
    "/admin/subjects",
    { schema: { body: subjectBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      try {
        const subject = await prisma.subject.create({
          data: { name: request.body.name },
          select: subjectSelect,
        });
        reply.code(201);
        return { data: subject };
      } catch (err) {
        if (isPrismaError(err, "P2002"))
          throw new AppError("CONFLICT", "Ya existe una materia con ese nombre.");
        throw err;
      }
    },
  );

  app.get("/admin/subjects", { preHandler: adminOnly }, async () => ({
    data: await prisma.subject.findMany({
      select: subjectSelect,
      orderBy: { name: "asc" },
    }),
  }));

  app.get<{ Params: IdParams }>(
    "/admin/subjects/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const subject = await prisma.subject.findUnique({
        where: { id: request.params.id },
        select: subjectSelect,
      });
      if (!subject) throw new AppError("NOT_FOUND", "Materia no encontrada.");
      return { data: subject };
    },
  );

  app.patch<{ Params: IdParams; Body: SubjectBody }>(
    "/admin/subjects/:id",
    {
      schema: { params: idParamsSchema, body: subjectBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        const subject = await prisma.subject.update({
          where: { id: request.params.id },
          data: { name: request.body.name },
          select: subjectSelect,
        });
        return { data: subject };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Materia no encontrada.");
        if (isPrismaError(err, "P2002"))
          throw new AppError("CONFLICT", "Ya existe una materia con ese nombre.");
        throw err;
      }
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/subjects/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.subject.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Materia no encontrada.");
        mapDeleteRestrict(
          err,
          "No se puede borrar la materia: tiene cursos o inscripciones.",
        );
      }
    },
  );

  // ── Cursos ────────────────────────────────────────────────────────────────
  app.post<{ Body: CreateCourseBody }>(
    "/admin/courses",
    { schema: { body: createCourseBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      try {
        const course = await prisma.course.create({
          data: request.body,
          select: courseSelect,
        });
        reply.code(201);
        return { data: course };
      } catch (err) {
        if (isPrismaError(err, "P2002"))
          throw new AppError(
            "CONFLICT",
            "Ya existe un curso para esa materia y año.",
          );
        if (isPrismaError(err, "P2003"))
          throw new AppError(
            "VALIDATION_ERROR",
            "La materia o el año indicado no existe.",
          );
        throw err;
      }
    },
  );

  app.get<{ Querystring: CoursesQuery }>(
    "/admin/courses",
    { schema: { querystring: coursesQuerySchema }, preHandler: adminOnly },
    async (request) => ({
      data: await prisma.course.findMany({
        where: {
          ...(request.query.subjectId
            ? { subjectId: request.query.subjectId }
            : {}),
          ...(request.query.gradeId ? { gradeId: request.query.gradeId } : {}),
        },
        select: courseSelect,
        orderBy: [{ subjectId: "asc" }, { gradeId: "asc" }],
      }),
    }),
  );

  app.get<{ Params: IdParams }>(
    "/admin/courses/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const course = await prisma.course.findUnique({
        where: { id: request.params.id },
        select: courseSelect,
      });
      if (!course) throw new AppError("NOT_FOUND", "Curso no encontrado.");
      return { data: course };
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateCourseBody }>(
    "/admin/courses/:id",
    {
      schema: { params: idParamsSchema, body: updateCourseBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        // subjectId/gradeId inmutables: solo title/description.
        const course = await prisma.course.update({
          where: { id: request.params.id },
          data: {
            title: request.body.title,
            description: request.body.description,
          },
          select: courseSelect,
        });
        return { data: course };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Curso no encontrado.");
        throw err;
      }
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/courses/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.course.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Curso no encontrado.");
        mapDeleteRestrict(
          err,
          "No se puede borrar el curso: tiene semanas o es prerrequisito de otro.",
        );
      }
    },
  );

  // (prerrequisitos: Task 3)
};
```

- [ ] **Step 2: Registrar en `src/app.ts`**

Import + registro (junto a los otros módulos de catálogo):

```typescript
import { subjectsCoursesRoutes } from "./modules/catalog/subjects-courses-routes.js";
```
```typescript
  app.register(
    async (scope) => {
      await subjectsCoursesRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
```

- [ ] **Step 3: Test de integración (DB) — CRUD**

Create `tests/catalog/subjects-courses.integration.test.ts` (scaffold habitual; `beforeAll` crea admin + parent + dos `Grade` con `level` distinto). Casos de CRUD (los prereqs van en Task 3):

```typescript
  test("crear/leer/actualizar materia; nombre duplicado → CONFLICT", async () => {
    const c = await call("POST", "/admin/subjects", adminToken, { name: `Mat-${tag}` });
    expect(c.statusCode).toBe(201);
    subjectId = c.json().data.id;
    const dup = await call("POST", "/admin/subjects", adminToken, { name: `Mat-${tag}` });
    expect(dup.statusCode).toBe(409);
  });

  test("crear curso; duplicado (materia,año) → CONFLICT; subject/grade malo → VALIDATION_ERROR", async () => {
    const ok = await call("POST", "/admin/courses", adminToken, {
      subjectId, gradeId: grade3, title: "Mat 3°",
    });
    expect(ok.statusCode).toBe(201);
    courseId = ok.json().data.id;
    const dup = await call("POST", "/admin/courses", adminToken, {
      subjectId, gradeId: grade3, title: "Otro",
    });
    expect(dup.statusCode).toBe(409);
    const bad = await call("POST", "/admin/courses", adminToken, {
      subjectId: randomUUID(), gradeId: grade3, title: "X",
    });
    expect(bad.statusCode).toBe(400);
  });

  test("PATCH curso (title); borrar curso con semanas → CONFLICT", async () => {
    const upd = await call("PATCH", `/admin/courses/${courseId}`, adminToken, { title: "Mat 3° A" });
    expect(upd.json().data.title).toBe("Mat 3° A");
    await db.week.create({ data: { courseId, number: 1, title: "S1" } });
    const del = await call("DELETE", `/admin/courses/${courseId}`, adminToken);
    expect(del.statusCode).toBe(409);
  });

  test("borrar materia en uso (con cursos) → CONFLICT", async () => {
    const del = await call("DELETE", `/admin/subjects/${subjectId}`, adminToken);
    expect(del.statusCode).toBe(409);
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/subjects", parentToken, { name: "X" });
    expect(res.statusCode).toBe(403);
  });
```

(`afterAll`: borrar en orden week → coursePrerequisite → course → subject → grade → family → users, filtrando por `tag`.)

- [ ] **Step 4: Verificar + commit**

`npm run typecheck && npm run format && npm run lint && npx vitest run tests/catalog/subjects-courses.integration.test.ts`

```bash
git add src/modules/catalog/subjects-courses-routes.ts src/app.ts tests/catalog/subjects-courses.integration.test.ts
git commit -m "feat(catalog): CRUD de materias y cursos por admin (ISSUE-37)"
```

---

## Task 3: Prerrequisitos (agregar/quitar/listar) con validación de ciclos

- [ ] **Step 1: Agregar las rutas de prereqs a `subjects-courses-routes.ts`** (reemplazar `// (prerrequisitos: Task 3)`)

```typescript
  // ── Prerrequisitos ────────────────────────────────────────────────────────
  const requiresOf = (courseId: string) =>
    prisma.coursePrerequisite
      .findMany({ where: { courseId }, select: { requiresCourseId: true } })
      .then((rows) => rows.map((r) => r.requiresCourseId));

  app.post<{ Params: IdParams; Body: PrereqBody }>(
    "/admin/courses/:id/prerequisites",
    {
      schema: { params: idParamsSchema, body: prereqBodySchema },
      preHandler: adminOnly,
    },
    async (request, reply) => {
      const { id: courseId } = request.params;
      const { requiresCourseId } = request.body;
      if (await wouldCreatePrereqCycle(requiresOf, courseId, requiresCourseId)) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Ese prerrequisito crearía un ciclo.",
        );
      }
      try {
        await prisma.coursePrerequisite.create({
          data: { courseId, requiresCourseId },
        });
        reply.code(201);
      } catch (err) {
        if (isPrismaError(err, "P2002")) {
          reply.code(200); // ya era prerrequisito: idempotente.
        } else if (isPrismaError(err, "P2003")) {
          throw new AppError(
            "VALIDATION_ERROR",
            "El curso o el prerrequisito indicado no existe.",
          );
        } else {
          throw err;
        }
      }
      return { data: { courseId, requiresCourseId } };
    },
  );

  app.delete<{ Params: PrereqParams }>(
    "/admin/courses/:id/prerequisites/:requiresCourseId",
    { schema: { params: prereqParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const { id: courseId, requiresCourseId } = request.params;
      try {
        await prisma.coursePrerequisite.delete({
          where: {
            courseId_requiresCourseId: { courseId, requiresCourseId },
          },
        });
        return { data: { courseId, requiresCourseId, removed: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "El prerrequisito no existe.");
        throw err;
      }
    },
  );

  app.get<{ Params: IdParams }>(
    "/admin/courses/:id/prerequisites",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const rows = await prisma.coursePrerequisite.findMany({
        where: { courseId: request.params.id },
        select: { requires: { select: courseSelect } },
      });
      return { data: rows.map((r) => r.requires) };
    },
  );
```

- [ ] **Step 2: Tests de prereqs (DB)** (agregar al test de integración)

```typescript
  test("prerrequisitos: agregar, listar, idempotente, self y ciclo", async () => {
    // Tres cursos de una materia en años 1/2/3.
    const s = (await call("POST", "/admin/subjects", adminToken, { name: `Sub-${tag}` })).json().data.id;
    const c1 = (await call("POST", "/admin/courses", adminToken, { subjectId: s, gradeId: grade1, title: "1°" })).json().data.id;
    const c2 = (await call("POST", "/admin/courses", adminToken, { subjectId: s, gradeId: grade2, title: "2°" })).json().data.id;
    const c3 = (await call("POST", "/admin/courses", adminToken, { subjectId: s, gradeId: grade3, title: "3°" })).json().data.id;
    prereqCourses.push(c1, c2, c3);
    prereqSubject = s;

    // 2° requiere 1°, 3° requiere 2°.
    expect((await call("POST", `/admin/courses/${c2}/prerequisites`, adminToken, { requiresCourseId: c1 })).statusCode).toBe(201);
    expect((await call("POST", `/admin/courses/${c3}/prerequisites`, adminToken, { requiresCourseId: c2 })).statusCode).toBe(201);
    // Idempotente.
    expect((await call("POST", `/admin/courses/${c2}/prerequisites`, adminToken, { requiresCourseId: c1 })).statusCode).toBe(200);
    // Listar 3° → [2°].
    const list = await call("GET", `/admin/courses/${c3}/prerequisites`, adminToken);
    expect(list.json().data.map((x: { id: string }) => x.id)).toEqual([c2]);
    // Self-prereq → VALIDATION_ERROR.
    expect((await call("POST", `/admin/courses/${c1}/prerequisites`, adminToken, { requiresCourseId: c1 })).statusCode).toBe(400);
    // Ciclo: 1° requiere 3° (3°→2°→1°) → VALIDATION_ERROR.
    const cyc = await call("POST", `/admin/courses/${c1}/prerequisites`, adminToken, { requiresCourseId: c3 });
    expect(cyc.statusCode).toBe(400);
    expect(cyc.json().error.code).toBe("VALIDATION_ERROR");
    // Quitar el prereq de 3°.
    expect((await call("DELETE", `/admin/courses/${c3}/prerequisites/${c2}`, adminToken)).statusCode).toBe(200);
  });
```

(`afterAll`: limpiar `coursePrerequisite` de esos cursos, luego los cursos, la materia extra, etc.)

- [ ] **Step 3: Verificar + commit**

`npm run typecheck && npm run format && npm run lint && npx vitest run tests/catalog/subjects-courses.integration.test.ts`

```bash
git add src/modules/catalog/subjects-courses-routes.ts tests/catalog/subjects-courses.integration.test.ts
git commit -m "feat(catalog): prerrequisitos de cursos con validación de ciclos (ISSUE-37)"
```

---

## Task 4: Verificación final (con BD) + PR

- [ ] **Step 1:** Postgres desechable (5433) + `migrate deploy`.
- [ ] **Step 2:** `DATABASE_URL=... npx vitest run` → todo verde.
- [ ] **Step 3:** `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 4:** limpiar contenedor; commitear el plan; `git push`; PR hacia `main`; link y parar. Sin footer.

---

## Self-Review

- CRUD /admin/subjects y /admin/courses con validación por operación; borrar en uso → CONFLICT; duplicados → CONFLICT; FK mala → VALIDATION_ERROR. → Task 2. ✔
- Prerrequisitos como sub-recurso (agregar/quitar/listar), idempotente; **ciclo → VALIDATION_ERROR** (función pura `wouldCreatePrereqCycle`, Task 1). → Task 3. ✔
- `subjectId`/`gradeId` inmutables en PATCH de curso. No-admin → FORBIDDEN. ✔
- Grados 1-11 y materias extensibles (Inglés, Artes…) quedan soportados por el CRUD. ✔
- El re-anclaje de `/admin/weeks` a `courseId` ya está (ISSUE-36); no se repite. ✔
