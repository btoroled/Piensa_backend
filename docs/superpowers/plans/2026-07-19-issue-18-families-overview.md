# ISSUE-18 — Gestión de familias y overview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline), task por task.

**Goal:** `POST /admin/families` (crea User padre + Family + alumnos, atómico), listar/detallar familias, agregar alumnos, `suspend`/`reactivate`, y `GET /admin/overview` (conteos; sin actividad).

**Architecture:** Módulo `families` (`src/modules/families/`): `service.ts` (orquestación transaccional, reusa `hashPassword` de auth para password del padre y PIN de alumnos) + `routes.ts` (plugin bajo `/api/v1/admin`, solo admin). Suspend/reactivate flipan `Family.status`, que `authenticate` ya lee (ISSUE-10). Sin `DELETE` (familias se suspenden, no se borran — spec §2).

**Tech Stack:** Fastify · Prisma · argon2 (`hashPassword`) · Vitest.

Diseño aprobado: arquitectura §2.1 + forma del CRUD (conversación) + recorte de overview (M3). Issue: `Issues.MD` ISSUE-18.

## Global Constraints

- TDD, commits por task, DoD. `requireRole('admin')`; `additionalProperties: false`; IDs con `UUID_PATTERN`, email `EMAIL_PATTERN`, PIN `PIN_PATTERN` (de `src/lib/validation.ts`).
- **Nunca** devolver hashes (passwordHash/pinHash) al cliente.
- Creación **atómica** (transacción): email duplicado → `CONFLICT`; gradeId inexistente → `VALIDATION_ERROR`; nada creado si falla.
- Reusa `isPrismaError` (ISSUE-13). Tests de BD auto-saltables. ESM `.js`.

## File Structure

- **Create:** `src/modules/families/service.ts` — `createFamily`, `addStudent`, `setFamilyStatus`, `getOverview`.
- **Create:** `src/modules/families/routes.ts` — plugin de rutas.
- **Modify:** `src/app.ts` — registrar `familiesRoutes`.
- **Create test:** `tests/families/families.integration.test.ts` (incluye el e2e admin→padre→alumno).

---

## Task 1: Servicio de familias

- [ ] **Step 1: Crear `src/modules/families/service.ts`**

```typescript
// Gestión de familias por el admin (ISSUE-18). Orquesta la creación atómica de
// User padre + Family + alumnos, y los conteos del overview. Reusa hashPassword
// (argon2) para la contraseña temporal del padre y el PIN inicial de cada alumno.

import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { isPrismaError } from "../../lib/prisma-errors.js";
import { hashPassword } from "../auth/password.js";

export interface StudentInput {
  name: string;
  avatar: string;
  pin: string;
  gradeId?: string;
}
export interface CreateFamilyInput {
  name: string;
  parent: { email: string; password: string };
  students: StudentInput[];
}

const studentSelect = {
  id: true,
  name: true,
  avatar: true,
  gradeId: true,
  createdAt: true,
} as const;

const familyDetailSelect = {
  id: true,
  name: true,
  status: true,
  adminNote: true,
  createdAt: true,
  updatedAt: true,
  parentUser: { select: { id: true, email: true } },
  students: { select: studentSelect },
} as const;

async function hashedStudents(students: StudentInput[]) {
  return Promise.all(
    students.map(async (s) => ({
      name: s.name,
      avatar: s.avatar,
      pinHash: await hashPassword(s.pin),
      gradeId: s.gradeId,
    })),
  );
}

export async function createFamily(
  prisma: PrismaClient,
  input: CreateFamilyInput,
) {
  const passwordHash = await hashPassword(input.parent.password);
  const students = await hashedStudents(input.students);
  try {
    return await prisma.$transaction(async (tx) => {
      const parent = await tx.user.create({
        data: {
          email: input.parent.email,
          passwordHash,
          role: "parent",
        },
      });
      return tx.family.create({
        data: {
          name: input.name,
          parentUserId: parent.id,
          students: { create: students },
        },
        select: familyDetailSelect,
      });
    });
  } catch (err) {
    if (isPrismaError(err, "P2002"))
      throw new AppError("CONFLICT", "El email del padre ya está en uso.");
    if (isPrismaError(err, "P2003"))
      throw new AppError("VALIDATION_ERROR", "El grado indicado no existe.");
    throw err;
  }
}

export async function addStudent(
  prisma: PrismaClient,
  familyId: string,
  input: StudentInput,
) {
  const pinHash = await hashPassword(input.pin);
  try {
    return await prisma.studentProfile.create({
      data: {
        familyId,
        name: input.name,
        avatar: input.avatar,
        pinHash,
        gradeId: input.gradeId,
      },
      select: studentSelect,
    });
  } catch (err) {
    // familyId ya se verificó en la ruta (NOT_FOUND); acá solo puede ser el grado.
    if (isPrismaError(err, "P2003"))
      throw new AppError("VALIDATION_ERROR", "El grado indicado no existe.");
    throw err;
  }
}

export async function getOverview(prisma: PrismaClient) {
  const [active, suspended, students] = await Promise.all([
    prisma.family.count({ where: { status: "active" } }),
    prisma.family.count({ where: { status: "suspended" } }),
    prisma.studentProfile.count(),
  ]);
  return {
    families: { active, suspended, total: active + suspended },
    students: { total: students },
  };
}
```

- [ ] **Step 2: typecheck; commit**

Run: `npm run typecheck`

```bash
git add src/modules/families/service.ts
git commit -m "feat(families): servicio de creación atómica de familias y overview (ISSUE-18)"
```

---

## Task 2: Rutas + wiring + tests de integración

- [ ] **Step 1: Crear `src/modules/families/routes.ts`**

```typescript
// Rutas de gestión de familias (ISSUE-18), bajo /api/v1/admin, solo admin.
// Crear/listar/detallar familias, agregar alumnos, suspender/reactivar, overview.
// Sin DELETE: las familias se suspenden, no se borran (spec §2).

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { isPrismaError } from "../../lib/prisma-errors.js";
import { UUID_PATTERN, EMAIL_PATTERN, PIN_PATTERN } from "../../lib/validation.js";
import {
  createFamily,
  addStudent,
  getOverview,
} from "./service.js";

export interface FamiliesRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const studentSchema = {
  type: "object",
  required: ["name", "avatar", "pin"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    avatar: { type: "string", minLength: 1, maxLength: 100 },
    pin: { type: "string", pattern: PIN_PATTERN },
    gradeId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const createFamilyBodySchema = {
  type: "object",
  required: ["name", "parent", "students"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    parent: {
      type: "object",
      required: ["email", "password"],
      additionalProperties: false,
      properties: {
        email: { type: "string", pattern: EMAIL_PATTERN, maxLength: 254 },
        password: { type: "string", minLength: 8, maxLength: 1024 },
      },
    },
    students: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: studentSchema,
    },
  },
} as const;

const suspendBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: { adminNote: { type: "string", maxLength: 500 } },
} as const;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

interface IdParams {
  id: string;
}
interface StudentBody {
  name: string;
  avatar: string;
  pin: string;
  gradeId?: string;
}
interface CreateFamilyBody {
  name: string;
  parent: { email: string; password: string };
  students: StudentBody[];
}
interface SuspendBody {
  adminNote?: string;
}

const familyListSelect = {
  id: true,
  name: true,
  status: true,
  adminNote: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { students: true } },
} as const;

const familyDetailSelect = {
  id: true,
  name: true,
  status: true,
  adminNote: true,
  createdAt: true,
  updatedAt: true,
  parentUser: { select: { id: true, email: true } },
  students: {
    select: {
      id: true,
      name: true,
      avatar: true,
      gradeId: true,
      createdAt: true,
    },
  },
} as const;

export const familiesRoutes: FastifyPluginAsync<FamiliesRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];

  app.post<{ Body: CreateFamilyBody }>(
    "/admin/families",
    { schema: { body: createFamilyBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      const family = await createFamily(prisma, request.body);
      reply.code(201);
      return { data: family };
    },
  );

  app.get("/admin/families", { preHandler: adminOnly }, async () => ({
    data: await prisma.family.findMany({
      select: familyListSelect,
      orderBy: { createdAt: "asc" },
    }),
  }));

  app.get<{ Params: IdParams }>(
    "/admin/families/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const family = await prisma.family.findUnique({
        where: { id: request.params.id },
        select: familyDetailSelect,
      });
      if (!family) throw new AppError("NOT_FOUND", "Familia no encontrada.");
      return { data: family };
    },
  );

  app.post<{ Params: IdParams; Body: StudentBody }>(
    "/admin/families/:id/students",
    { schema: { params: idParamsSchema, body: studentSchema }, preHandler: adminOnly },
    async (request, reply) => {
      const family = await prisma.family.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!family) throw new AppError("NOT_FOUND", "Familia no encontrada.");
      const student = await addStudent(prisma, request.params.id, request.body);
      reply.code(201);
      return { data: student };
    },
  );

  app.post<{ Params: IdParams; Body: SuspendBody }>(
    "/admin/families/:id/suspend",
    { schema: { params: idParamsSchema, body: suspendBodySchema }, preHandler: adminOnly },
    async (request) => {
      try {
        const family = await prisma.family.update({
          where: { id: request.params.id },
          data: { status: "suspended", adminNote: request.body.adminNote ?? null },
          select: familyListSelect,
        });
        return { data: family };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Familia no encontrada.");
        throw err;
      }
    },
  );

  app.post<{ Params: IdParams }>(
    "/admin/families/:id/reactivate",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        const family = await prisma.family.update({
          where: { id: request.params.id },
          data: { status: "active" },
          select: familyListSelect,
        });
        return { data: family };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Familia no encontrada.");
        throw err;
      }
    },
  );

  // Overview: conteos de familias y alumnos (sin actividad, diferida a M3).
  app.get("/admin/overview", { preHandler: adminOnly }, async () => ({
    data: await getOverview(prisma),
  }));
};
```

- [ ] **Step 2: Registrar en `src/app.ts`**

Import: `import { familiesRoutes } from "./modules/families/routes.js";`

Registro (junto a los otros módulos):

```typescript
  app.register(
    async (scope) => {
      await familiesRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
```

- [ ] **Step 3: Test de integración (DB), incluye el e2e admin→padre→alumno**

Create `tests/families/families.integration.test.ts` (scaffold habitual; `beforeAll` crea un admin). Casos:

```typescript
  const uniq = randomUUID();
  const parentEmail = `parent-${uniq}@piensa.test`;

  test("e2e: admin crea familia → padre hace login → crea sesión de alumno", async () => {
    const created = await call("POST", "/admin/families", adminToken, {
      name: "Los Prueba",
      parent: { email: parentEmail, password: "clave-temporal-123" },
      students: [{ name: "Ana", avatar: "fox", pin: "1234" }],
    });
    expect(created.statusCode).toBe(201);
    familyId = created.json().data.id;
    const studentId = created.json().data.students[0].id;
    // La respuesta no filtra hashes.
    expect(JSON.stringify(created.json())).not.toMatch(/passwordHash|pinHash/);

    // Padre hace login con la credencial temporal.
    const login = await call("POST", "/auth/login", undefined, {
      email: parentEmail,
      password: "clave-temporal-123",
    });
    expect(login.statusCode).toBe(200);
    const parentToken = login.json().data.accessToken;

    // Padre crea sesión de alumno con el PIN inicial.
    const session = await call("POST", "/auth/student-session", parentToken, {
      studentProfileId: studentId,
      pin: "1234",
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().data.accessToken).toBeTruthy();
  });

  test("email de padre duplicado → CONFLICT", async () => {
    const res = await call("POST", "/admin/families", adminToken, {
      name: "Otra",
      parent: { email: parentEmail, password: "clave-temporal-123" },
      students: [{ name: "Beto", avatar: "cat", pin: "5678" }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  test("gradeId inexistente → VALIDATION_ERROR (nada creado)", async () => {
    const res = await call("POST", "/admin/families", adminToken, {
      name: "Con grado malo",
      parent: { email: `p2-${randomUUID()}@piensa.test`, password: "clave-temporal-123" },
      students: [{ name: "C", avatar: "dog", pin: "1111", gradeId: randomUUID() }],
    });
    expect(res.statusCode).toBe(400);
  });

  test("suspend corta el acceso del padre; reactivate lo restaura", async () => {
    const login = await call("POST", "/auth/login", undefined, {
      email: parentEmail,
      password: "clave-temporal-123",
    });
    const parentToken = login.json().data.accessToken;
    const studentId = (
      await call("GET", `/admin/families/${familyId}`, adminToken)
    ).json().data.students[0].id;

    await call("POST", `/admin/families/${familyId}/suspend`, adminToken, {
      adminNote: "pendiente pago julio",
    });
    // Con token de padre vigente, crear sesión de alumno → FAMILY_SUSPENDED.
    const blocked = await call("POST", "/auth/student-session", parentToken, {
      studentProfileId: studentId,
      pin: "1234",
    });
    expect(blocked.json().error.code).toBe("FAMILY_SUSPENDED");

    await call("POST", `/admin/families/${familyId}/reactivate`, adminToken);
    const ok = await call("POST", "/auth/student-session", parentToken, {
      studentProfileId: studentId,
      pin: "1234",
    });
    expect(ok.statusCode).toBe(200);
  });

  test("agregar un alumno a una familia existente", async () => {
    const res = await call("POST", `/admin/families/${familyId}/students`, adminToken, {
      name: "Nuevo",
      avatar: "owl",
      pin: "4321",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.name).toBe("Nuevo");
  });

  test("overview devuelve conteos", async () => {
    const res = await call("GET", "/admin/overview", adminToken);
    expect(res.json().data.families.total).toBeGreaterThanOrEqual(1);
    expect(res.json().data.students.total).toBeGreaterThanOrEqual(1);
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/families", parentSelfToken, {
      name: "X",
      parent: { email: `z-${randomUUID()}@piensa.test`, password: "clave-temporal-123" },
      students: [{ name: "Y", avatar: "fox", pin: "0000" }],
    });
    expect(res.statusCode).toBe(403);
  });
```

(`beforeAll` crea el admin + un `parentSelfToken` de un padre cualquiera para el caso FORBIDDEN. `afterAll`: borrar en orden studentProfile → family → user de las familias creadas — buscar por `email` con el `uniq`, y limpiar el admin.)

- [ ] **Step 4: Verificar + commit**

Run: `npm run typecheck && npm run format && npm run lint && npx vitest run tests/families/families.integration.test.ts`

```bash
git add src/modules/families/routes.ts src/app.ts tests/families/families.integration.test.ts
git commit -m "feat(families): CRUD de familias, suspend/reactivate y overview (ISSUE-18)"
```

---

## Task 3: Verificación final (con BD) + PR

- [ ] **Step 1:** Postgres desechable (5433) + `migrate deploy`.
- [ ] **Step 2:** `DATABASE_URL=... npx vitest run` → todo verde (el e2e corre de verdad).
- [ ] **Step 3:** `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 4:** limpiar contenedor; commitear el plan; `git push`; PR hacia `main`; link y parar. Sin footer.

---

## Self-Review

- E2E admin crea familia → padre login → sesión de alumno → Task 2 Step 3. ✔
- Suspend/reactivate reflejan ISSUE-10 (FAMILY_SUSPENDED con token vigente; reactivate restaura) vía los endpoints. ✔
- Overview: conteos activas/suspendidas + alumnos; **sin actividad** (diferida a M3). ✔
- Creación atómica; email dup → CONFLICT; gradeId malo → VALIDATION_ERROR; sin filtrar hashes. Sin DELETE (spec §2). No-admin → FORBIDDEN. ✔
- Password del padre y PIN de alumno hasheados con argon2 (`hashPassword`). ✔
