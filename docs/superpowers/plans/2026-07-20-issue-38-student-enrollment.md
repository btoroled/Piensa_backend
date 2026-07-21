# ISSUE-38 — Inscripción del alumno (año + materias) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline), task por task.

**Goal:** Asignar a cada alumno su **año** (`gradeId`) + sus **materias** (`StudentSubject`), promoverlo de año, y consultar los cursos accesibles ("para abajo"). Cierra Milestone 2.5.

**Architecture:** Extiende la creación de familias (ISSUE-18) con `subjectIds` opcional (atómico). Nuevos endpoints a nivel alumno en `src/modules/families/students-routes.ts` (`/admin/students/:id`), solo admin: promoción de año, inscripción de materias (individual `POST/DELETE` + bulk `PUT`), y `GET .../courses` con el acceso "para abajo".

**Tech Stack:** Fastify · Prisma · argon2 · Vitest.

Diseño aprobado (conversación): endpoints planos `/admin/students/:id`; materias individual + bulk; promoción = `PATCH { gradeId }`; acceso "para abajo" = materia ∈ inscritas ∧ `grade.level ≤` año actual (todo por año, opción A). Issue: `Issues.MD` ISSUE-38.

## Global Constraints

- TDD, commits por task, DoD. `requireRole('admin')`; `additionalProperties: false`; IDs con `UUID_PATTERN`.
- Idempotente al inscribir (ya inscrita → 200); materia inexistente → `VALIDATION_ERROR`; alumno inexistente → `NOT_FOUND`; año inexistente al promover → `VALIDATION_ERROR`.
- Bulk (`PUT` y `subjectIds` al crear) es **atómico**: si una materia es inválida, no se cambia nada.
- Tests de BD auto-saltables; ESM `.js`.

## File Structure

- **Modify:** `src/modules/families/service.ts` — `StudentInput.subjectIds`; enrolar en `createFamily`/`addStudent`.
- **Modify:** `src/modules/families/routes.ts` — `subjectIds` en los schemas de crear familia / agregar alumno.
- **Create:** `src/modules/families/students-routes.ts` — endpoints `/admin/students/:id`.
- **Modify:** `src/app.ts` — registrar `studentsRoutes`.
- **Create tests:** extender `tests/families/families.integration.test.ts` (subjectIds al crear) + `tests/families/students.integration.test.ts` (endpoints de alumno).

---

## Task 1: `subjectIds` al crear/agregar alumno

- [ ] **Step 1: `families/service.ts`**

- `StudentInput` gana `subjectIds?: string[]`.
- `hashedStudents`: cada alumno agrega `subjects` anidado si trae subjectIds:

```typescript
async function hashedStudents(students: StudentInput[]) {
  return Promise.all(
    students.map(async (s) => ({
      name: s.name,
      avatar: s.avatar,
      pinHash: await hashPassword(s.pin),
      gradeId: s.gradeId,
      ...(s.subjectIds && s.subjectIds.length > 0
        ? { subjects: { create: s.subjectIds.map((id) => ({ subjectId: id })) } }
        : {}),
    })),
  );
}
```

- `addStudent`: crear con `subjects` anidado igual (si `input.subjectIds?.length`).
- Generalizar el mensaje de `P2003` en `createFamily` y `addStudent`: `"El grado o alguna materia indicada no existe."` (ahora el P2003 puede venir del grado o de una materia).

- [ ] **Step 2: `families/routes.ts` — schemas**

En `studentSchema` (usado por crear familia y agregar alumno) agregar:

```typescript
    subjectIds: {
      type: "array",
      maxItems: 50,
      uniqueItems: true,
      items: { type: "string", pattern: UUID_PATTERN },
    },
```
y en la interfaz `StudentBody` agregar `subjectIds?: string[]`.

- [ ] **Step 3: Test (extender `families.integration.test.ts`)**

```typescript
  test("crear familia con materias inscritas (subjectIds) atómico; materia mala → nada creado", async () => {
    const subject = await db.subject.create({ data: { name: `Mat-${uniq}` } });
    const created = await call("POST", "/admin/families", adminToken, {
      name: "Con materias",
      parent: { email: `pm-${uniq}@piensa.test`, password: "clave-temporal-123" },
      students: [{ name: "Z", avatar: "fox", pin: "2468", subjectIds: [subject.id] }],
    });
    expect(created.statusCode).toBe(201);
    const studentId = created.json().data.students[0].id;
    const enrolled = await db.studentSubject.findMany({ where: { studentProfileId: studentId } });
    expect(enrolled).toHaveLength(1);

    // subjectId inválido → VALIDATION_ERROR, nada creado.
    const bad = await call("POST", "/admin/families", adminToken, {
      name: "Mala",
      parent: { email: `pmb-${uniq}@piensa.test`, password: "clave-temporal-123" },
      students: [{ name: "W", avatar: "cat", pin: "1357", subjectIds: [randomUUID()] }],
    });
    expect(bad.statusCode).toBe(400);
    const gone = await call("POST", "/auth/login", undefined, {
      email: `pmb-${uniq}@piensa.test`, password: "clave-temporal-123",
    });
    expect(gone.statusCode).toBe(401);
  });
```

(`afterAll` de ese test ya limpia por `uniq`; agregar limpieza de `studentSubject` y `subject` por `uniq` antes de borrar alumnos/materias.)

- [ ] **Step 4: typecheck/lint + commit**

```bash
git add src/modules/families/service.ts src/modules/families/routes.ts tests/families/families.integration.test.ts
git commit -m "feat(families): inscribir materias (subjectIds) al crear/agregar alumno (ISSUE-38)"
```

---

## Task 2: Endpoints a nivel alumno (`/admin/students/:id`)

- [ ] **Step 1: Crear `src/modules/families/students-routes.ts`**

```typescript
// Gestión de la inscripción del alumno (ISSUE-38), bajo /api/v1/admin/students.
// Solo admin: promover de año, inscribir/desinscribir materias (individual +
// bulk) y consultar los cursos accesibles ("para abajo").

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { isPrismaError } from "../../lib/prisma-errors.js";

export interface StudentsRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const subjectParamsSchema = {
  type: "object",
  required: ["id", "subjectId"],
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    subjectId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const updateStudentBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    avatar: { type: "string", minLength: 1, maxLength: 100 },
    gradeId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const enrollBodySchema = {
  type: "object",
  required: ["subjectId"],
  additionalProperties: false,
  properties: { subjectId: { type: "string", pattern: UUID_PATTERN } },
} as const;

const setSubjectsBodySchema = {
  type: "object",
  required: ["subjectIds"],
  additionalProperties: false,
  properties: {
    subjectIds: {
      type: "array",
      maxItems: 50,
      uniqueItems: true,
      items: { type: "string", pattern: UUID_PATTERN },
    },
  },
} as const;

interface IdParams {
  id: string;
}
interface SubjectParams {
  id: string;
  subjectId: string;
}
interface UpdateStudentBody {
  name?: string;
  avatar?: string;
  gradeId?: string;
}
interface EnrollBody {
  subjectId: string;
}
interface SetSubjectsBody {
  subjectIds: string[];
}

const studentSelect = {
  id: true,
  familyId: true,
  name: true,
  avatar: true,
  gradeId: true,
} as const;
const subjectSelect = { id: true, name: true } as const;
const courseSelect = {
  id: true,
  subjectId: true,
  gradeId: true,
  title: true,
  description: true,
} as const;

export const studentsRoutes: FastifyPluginAsync<StudentsRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];

  const requireStudent = async (id: string) => {
    const s = await prisma.studentProfile.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!s) throw new AppError("NOT_FOUND", "Alumno no encontrado.");
  };

  app.get<{ Params: IdParams }>(
    "/admin/students/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const s = await prisma.studentProfile.findUnique({
        where: { id: request.params.id },
        select: {
          ...studentSelect,
          subjects: { select: { subject: { select: subjectSelect } } },
        },
      });
      if (!s) throw new AppError("NOT_FOUND", "Alumno no encontrado.");
      return {
        data: { ...s, subjects: s.subjects.map((x) => x.subject) },
      };
    },
  );

  app.patch<{ Params: IdParams; Body: UpdateStudentBody }>(
    "/admin/students/:id",
    {
      schema: { params: idParamsSchema, body: updateStudentBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        const s = await prisma.studentProfile.update({
          where: { id: request.params.id },
          data: {
            name: request.body.name,
            avatar: request.body.avatar,
            gradeId: request.body.gradeId,
          },
          select: studentSelect,
        });
        return { data: s };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Alumno no encontrado.");
        if (isPrismaError(err, "P2003"))
          throw new AppError("VALIDATION_ERROR", "El grado indicado no existe.");
        throw err;
      }
    },
  );

  // ── Materias del alumno ─────────────────────────────────────────────────
  app.get<{ Params: IdParams }>(
    "/admin/students/:id/subjects",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      await requireStudent(request.params.id);
      const rows = await prisma.studentSubject.findMany({
        where: { studentProfileId: request.params.id },
        select: { subject: { select: subjectSelect } },
        orderBy: { subject: { name: "asc" } },
      });
      return { data: rows.map((r) => r.subject) };
    },
  );

  app.post<{ Params: IdParams; Body: EnrollBody }>(
    "/admin/students/:id/subjects",
    {
      schema: { params: idParamsSchema, body: enrollBodySchema },
      preHandler: adminOnly,
    },
    async (request, reply) => {
      await requireStudent(request.params.id); // NOT_FOUND si no existe
      try {
        await prisma.studentSubject.create({
          data: {
            studentProfileId: request.params.id,
            subjectId: request.body.subjectId,
          },
        });
        reply.code(201);
      } catch (err) {
        if (isPrismaError(err, "P2002")) {
          reply.code(200); // ya inscrita: idempotente
        } else if (isPrismaError(err, "P2003")) {
          throw new AppError("VALIDATION_ERROR", "La materia no existe.");
        } else {
          throw err;
        }
      }
      return {
        data: {
          studentProfileId: request.params.id,
          subjectId: request.body.subjectId,
        },
      };
    },
  );

  app.delete<{ Params: SubjectParams }>(
    "/admin/students/:id/subjects/:subjectId",
    { schema: { params: subjectParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.studentSubject.delete({
          where: {
            studentProfileId_subjectId: {
              studentProfileId: request.params.id,
              subjectId: request.params.subjectId,
            },
          },
        });
        return {
          data: {
            studentProfileId: request.params.id,
            subjectId: request.params.subjectId,
            removed: true,
          },
        };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "El alumno no tiene esa materia.");
        throw err;
      }
    },
  );

  app.put<{ Params: IdParams; Body: SetSubjectsBody }>(
    "/admin/students/:id/subjects",
    {
      schema: { params: idParamsSchema, body: setSubjectsBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      await requireStudent(request.params.id);
      const { subjectIds } = request.body;
      try {
        // Bulk atómico: reemplaza toda la inscripción.
        await prisma.$transaction([
          prisma.studentSubject.deleteMany({
            where: { studentProfileId: request.params.id },
          }),
          prisma.studentSubject.createMany({
            data: subjectIds.map((subjectId) => ({
              studentProfileId: request.params.id,
              subjectId,
            })),
          }),
        ]);
      } catch (err) {
        if (isPrismaError(err, "P2003"))
          throw new AppError(
            "VALIDATION_ERROR",
            "Alguna materia indicada no existe.",
          );
        throw err;
      }
      const rows = await prisma.studentSubject.findMany({
        where: { studentProfileId: request.params.id },
        select: { subject: { select: subjectSelect } },
        orderBy: { subject: { name: "asc" } },
      });
      return { data: rows.map((r) => r.subject) };
    },
  );

  // ── Cursos accesibles ("para abajo") ────────────────────────────────────
  app.get<{ Params: IdParams }>(
    "/admin/students/:id/courses",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const student = await prisma.studentProfile.findUnique({
        where: { id: request.params.id },
        select: {
          gradeId: true,
          grade: { select: { level: true } },
          subjects: { select: { subjectId: true } },
        },
      });
      if (!student) throw new AppError("NOT_FOUND", "Alumno no encontrado.");
      const subjectIds = student.subjects.map((s) => s.subjectId);
      // Sin año asignado o sin materias → nada accesible todavía.
      if (!student.grade || subjectIds.length === 0) return { data: [] };
      const courses = await prisma.course.findMany({
        where: {
          subjectId: { in: subjectIds },
          grade: { level: { lte: student.grade.level } },
        },
        select: courseSelect,
        orderBy: [{ subjectId: "asc" }, { gradeId: "asc" }],
      });
      return { data: courses };
    },
  );
};
```

- [ ] **Step 2: Registrar en `src/app.ts`** (import + register, junto a familias).

- [ ] **Step 3: Test de integración `tests/families/students.integration.test.ts`** (scaffold habitual; `beforeAll` crea admin + un alumno vía Prisma + 2 materias + grados con `level` 1/2/3 + cursos). Casos:

```typescript
  test("promover de año (PATCH gradeId); grado inexistente → VALIDATION_ERROR", async () => {
    const ok = await call("PATCH", `/admin/students/${studentId}`, adminToken, { gradeId: grade2 });
    expect(ok.json().data.gradeId).toBe(grade2);
    const bad = await call("PATCH", `/admin/students/${studentId}`, adminToken, { gradeId: randomUUID() });
    expect(bad.statusCode).toBe(400);
  });

  test("inscribir materia (idempotente); inexistente → VALIDATION_ERROR; listar", async () => {
    expect((await call("POST", `/admin/students/${studentId}/subjects`, adminToken, { subjectId: subA })).statusCode).toBe(201);
    expect((await call("POST", `/admin/students/${studentId}/subjects`, adminToken, { subjectId: subA })).statusCode).toBe(200);
    expect((await call("POST", `/admin/students/${studentId}/subjects`, adminToken, { subjectId: randomUUID() })).statusCode).toBe(400);
    const list = await call("GET", `/admin/students/${studentId}/subjects`, adminToken);
    expect(list.json().data.map((s: { id: string }) => s.id)).toEqual([subA]);
  });

  test("bulk PUT reemplaza la inscripción; materia mala → nada cambia", async () => {
    const ok = await call("PUT", `/admin/students/${studentId}/subjects`, adminToken, { subjectIds: [subA, subB] });
    expect(ok.json().data).toHaveLength(2);
    const bad = await call("PUT", `/admin/students/${studentId}/subjects`, adminToken, { subjectIds: [randomUUID()] });
    expect(bad.statusCode).toBe(400);
    const still = await call("GET", `/admin/students/${studentId}/subjects`, adminToken);
    expect(still.json().data).toHaveLength(2); // no cambió
  });

  test("cursos accesibles 'para abajo': materias inscritas × level ≤ año actual", async () => {
    // Alumno en año 2 (grade2), inscrito en subA que tiene cursos en años 1,2,3.
    await call("PATCH", `/admin/students/${studentId}`, adminToken, { gradeId: grade2 });
    await call("PUT", `/admin/students/${studentId}/subjects`, adminToken, { subjectIds: [subA] });
    const res = await call("GET", `/admin/students/${studentId}/courses`, adminToken);
    const ids = res.json().data.map((c: { id: string }) => c.id);
    // Ve subA 1° y 2°, no 3° (por encima de su año).
    expect(ids).toContain(courseA1);
    expect(ids).toContain(courseA2);
    expect(ids).not.toContain(courseA3);
  });

  test("no-admin → FORBIDDEN; alumno inexistente → NOT_FOUND", async () => {
    expect((await call("GET", `/admin/students/${studentId}`, parentToken)).statusCode).toBe(403);
    expect((await call("GET", `/admin/students/${randomUUID()}`, adminToken)).statusCode).toBe(404);
  });
```

- [ ] **Step 4: Verificar + commit**

```bash
git add src/modules/families/students-routes.ts src/app.ts tests/families/students.integration.test.ts
git commit -m "feat(families): endpoints de inscripción del alumno (año, materias, cursos accesibles) (ISSUE-38)"
```

---

## Task 3: Verificación final (con BD) + PR

- [ ] **Step 1:** Postgres desechable (5433) + `migrate deploy`.
- [ ] **Step 2:** `DATABASE_URL=... npx vitest run` → todo verde.
- [ ] **Step 3:** `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 4:** limpiar contenedor; commitear el plan; `git push`; PR hacia `main`; link y parar. Sin footer.

---

## Self-Review

- Crear alumno con año + materias (subjectIds, atómico) → Task 1. ✔
- Promover de año (PATCH gradeId); inscribir/desinscribir materias individual + **bulk PUT**; listar → Task 2. ✔
- Acceso "para abajo" consultable (materia ∈ inscritas ∧ `grade.level ≤` año actual; sin año → vacío) → Task 2 `GET .../courses`. ✔
- Idempotencia, NOT_FOUND/VALIDATION_ERROR, no-admin → FORBIDDEN. ✔
- Endpoints planos `/admin/students/:id` (decisión aprobada). Cierra Milestone 2.5. ✔
