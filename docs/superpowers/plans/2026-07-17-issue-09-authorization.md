# Autorización por rol y pertenencia (ISSUE-09) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar primitivas reutilizables de autorización (rol + pertenencia contra BD) como preHandlers de Fastify, refactorizar el endpoint existente para usarlas y dejar una suite de matriz rol×endpoint extensible.

**Architecture:** Una factory `createAuthorization({ jwtSecret, prisma })` en `src/modules/auth/authorize.ts` devuelve tres preHandlers: `authenticate` (verifica el Bearer y puebla `request.authPrincipal`), `requireRole(...roles)` (rol contra la lista) y `requireStudentOwnership({from,key})` (pertenencia resuelta SIEMPRE contra la BD). Sigue el estilo de inyección de dependencias del resto del módulo auth.

**Tech Stack:** Node.js + TypeScript (ESM), Fastify, Prisma/PostgreSQL, Vitest, `jose` (JWT), `@node-rs/argon2`.

## Global Constraints

- ESM con extensiones `.js` en los imports relativos (NodeNext).
- Validación estricta ajv `removeAdditional:false` + `coerceTypes` activo: campos sensibles con `pattern`, no solo `type` (nota review ISSUE-03).
- Errores de dominio con `AppError(code, message)`; el `conventionsPlugin` los traduce al envelope `{ error: { code, message, requestId } }`. Códigos válidos: `UNAUTHORIZED` (401), `FORBIDDEN` (403), etc. (`src/plugins/errors.ts`).
- Los tests de integración auto-saltan sin `DATABASE_URL` (`describe.skipIf`), evidencia real en CI. Nada de verde fabricado.
- Sin footer de atribución en commits ni PRs.

---

### Task 1: Primitivas `authenticate` + `requireRole` (sin BD) y matriz de rol

**Files:**
- Create: `src/modules/auth/authorize.ts`
- Test: `tests/auth/authorization-matrix.test.ts`

**Interfaces:**
- Consumes: `verifyAccessToken`, `AccessTokenClaims`, `TokenRole` de `./tokens.js`; `AppError` de `../../plugins/errors.js`; `conventionsPlugin` de `../../plugins/conventions.js`.
- Produces: `createAuthorization(deps: { jwtSecret: string; prisma: PrismaClient }): Authorization` con `Authorization = { authenticate: preHandlerHookHandler; requireRole: (...roles: TokenRole[]) => preHandlerHookHandler; requireStudentOwnership: (source: { from: "params" | "body"; key: string }) => preHandlerHookHandler }`. Augmenta `FastifyRequest` con `authPrincipal?: AccessTokenClaims`.

- [ ] **Step 1: Write the failing test**

`tests/auth/authorization-matrix.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { conventionsPlugin } from "../../src/plugins/conventions.js";
import { createAuthorization } from "../../src/modules/auth/authorize.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Matriz rol×endpoint de las primitivas de autorización (ISSUE-09). Solo rol:
// no toca la BD (prisma nunca se invoca en endpoints protegidos solo por rol),
// así que corre en cualquier entorno. Los issues posteriores extienden esta
// matriz agregando filas (endpoints) y reusando `call`.

const SECRET = "test-secret-at-least-16-chars-long";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.register(conventionsPlugin);
  // prisma no se usa en endpoints solo-rol: un stub basta para construir.
  const authz = createAuthorization({
    jwtSecret: SECRET,
    prisma: {} as PrismaClient,
  });
  app.register(
    async (scope) => {
      const ok = async () => ({ data: { ok: true } });
      scope.get(
        "/__test/admin-only",
        { preHandler: [authz.authenticate, authz.requireRole("admin")] },
        ok,
      );
      scope.get(
        "/__test/parent-only",
        { preHandler: [authz.authenticate, authz.requireRole("parent")] },
        ok,
      );
      scope.get(
        "/__test/student-only",
        { preHandler: [authz.authenticate, authz.requireRole("student")] },
        ok,
      );
    },
    { prefix: "/api/v1" },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

async function tokenFor(role: "admin" | "parent" | "student"): Promise<string> {
  if (role === "admin") return createAccessToken(SECRET, { userId: "a1", role });
  if (role === "parent")
    return createAccessToken(SECRET, { userId: "p1", role, familyId: "f1" });
  return createAccessToken(SECRET, {
    studentProfileId: "s1",
    role,
    familyId: "f1",
  });
}

async function call(path: string, bearer?: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1${path}`,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

// endpoint → estado esperado por principal.
const MATRIX: Record<string, Record<string, number>> = {
  "/__test/admin-only": { admin: 200, parent: 403, student: 403 },
  "/__test/parent-only": { admin: 403, parent: 200, student: 403 },
  "/__test/student-only": { admin: 403, parent: 403, student: 200 },
};

describe("matriz rol×endpoint", () => {
  for (const [path, expected] of Object.entries(MATRIX)) {
    for (const [role, status] of Object.entries(expected)) {
      test(`${role} → ${path} → ${status}`, async () => {
        const res = await call(path, await tokenFor(role as "admin"));
        expect(res.statusCode).toBe(status);
      });
    }

    test(`sin token → ${path} → 401 UNAUTHORIZED`, async () => {
      const res = await call(path);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    });

    test(`token inválido → ${path} → 401 UNAUTHORIZED`, async () => {
      const res = await call(path, "no-es-un-jwt");
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth/authorization-matrix.test.ts`
Expected: FAIL — no resuelve `../../src/modules/auth/authorize.js` (módulo no existe).

- [ ] **Step 3: Write minimal implementation**

`src/modules/auth/authorize.ts` (solo `authenticate` + `requireRole`; `requireStudentOwnership` se completa en Task 2, pero se declara ya para fijar la interfaz):

```typescript
// Primitivas de autorización reutilizables (Spec §6, ISSUE-09).
//
// preHandlers de Fastify que separan autenticación (verificar el token) de
// autorización (rol y pertenencia). La pertenencia se resuelve SIEMPRE contra
// la BD, nunca confiando en los claims del token. Se exponen como una factory
// que recibe sus dependencias (jwtSecret, prisma) para cablearse por módulo y
// probarse en aislamiento.

import type { preHandlerHookHandler } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import {
  verifyAccessToken,
  type AccessTokenClaims,
  type TokenRole,
} from "./tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    // Principal autenticado; lo puebla `authenticate`. Ausente hasta entonces.
    authPrincipal?: AccessTokenClaims;
  }
}

export interface AuthorizationDeps {
  jwtSecret: string;
  prisma: PrismaClient;
}

export interface StudentIdSource {
  from: "params" | "body";
  key: string;
}

export interface Authorization {
  authenticate: preHandlerHookHandler;
  requireRole: (...roles: TokenRole[]) => preHandlerHookHandler;
  requireStudentOwnership: (source: StudentIdSource) => preHandlerHookHandler;
}

export function createAuthorization(deps: AuthorizationDeps): Authorization {
  const { jwtSecret, prisma } = deps;

  const authenticate: preHandlerHookHandler = async (request) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) {
      throw new AppError("UNAUTHORIZED", "Falta el token de autenticación.");
    }
    try {
      request.authPrincipal = await verifyAccessToken(jwtSecret, token);
    } catch {
      throw new AppError("UNAUTHORIZED", "Token de autenticación inválido.");
    }
  };

  const requireRole =
    (...roles: TokenRole[]): preHandlerHookHandler =>
    async (request) => {
      const principal = request.authPrincipal;
      if (!principal) {
        throw new AppError("UNAUTHORIZED", "No autenticado.");
      }
      if (!roles.includes(principal.role)) {
        throw new AppError("FORBIDDEN", "No tienes permiso para esta acción.");
      }
    };

  const familyIdOf = async (userId: string): Promise<string | null> => {
    const family = await prisma.family.findFirst({
      where: { parentUserId: userId },
      select: { id: true },
    });
    return family?.id ?? null;
  };

  const requireStudentOwnership =
    (source: StudentIdSource): preHandlerHookHandler =>
    async (request) => {
      const principal = request.authPrincipal;
      if (!principal) {
        throw new AppError("UNAUTHORIZED", "No autenticado.");
      }
      // Admin gestiona todas las familias: no se le aplica pertenencia.
      if (principal.role === "admin") {
        return;
      }

      const bag = (
        source.from === "params" ? request.params : request.body
      ) as Record<string, unknown> | undefined;
      const studentProfileId = bag?.[source.key];
      if (typeof studentProfileId !== "string") {
        throw forbiddenProfile();
      }

      const profile = await prisma.studentProfile.findUnique({
        where: { id: studentProfileId },
        select: { id: true, familyId: true },
      });
      if (!profile) {
        throw forbiddenProfile();
      }

      if (principal.role === "student") {
        if (profile.id !== principal.studentProfileId) {
          throw forbiddenProfile();
        }
        return;
      }

      // parent: la familia se resuelve desde la BD, no del claim del token.
      const parentFamilyId = principal.userId
        ? await familyIdOf(principal.userId)
        : null;
      if (parentFamilyId === null || profile.familyId !== parentFamilyId) {
        throw forbiddenProfile();
      }
    };

  return { authenticate, requireRole, requireStudentOwnership };
}

function forbiddenProfile(): AppError {
  return new AppError(
    "FORBIDDEN",
    "No tienes permiso para este perfil de alumno.",
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth/authorization-matrix.test.ts`
Expected: PASS (15 tests: 9 de rol + 6 de sin/mal token).

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/authorize.ts tests/auth/authorization-matrix.test.ts
git commit -m "feat(auth): primitivas authenticate + requireRole y matriz rol×endpoint (ISSUE-09)"
```

---

### Task 2: `requireStudentOwnership` contra BD (integración)

**Files:**
- Test: `tests/auth/authorization-ownership.integration.test.ts`
- (Implementación ya presente desde Task 1: `src/modules/auth/authorize.ts`.)

**Interfaces:**
- Consumes: `createAuthorization`, `createAccessToken`, `conventionsPlugin`, `hashPassword` de `../../src/modules/auth/password.js`, `PrismaClient`.
- Produces: nada nuevo (valida el preHandler `requireStudentOwnership` end-to-end contra la BD).

- [ ] **Step 1: Write the failing test**

`tests/auth/authorization-ownership.integration.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { conventionsPlugin } from "../../src/plugins/conventions.js";
import { createAuthorization } from "../../src/modules/auth/authorize.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";
import { hashPassword } from "../../src/modules/auth/password.js";

// Pertenencia contra BD (ISSUE-09) end-to-end. Sin BD se AUTO-SALTA (evidencia
// real en CI). Cubre: padre→hijo ajeno → FORBIDDEN aunque el ID exista.

const SECRET = "integration-secret-at-least-16-chars";

function makeClient(): PrismaClient | null {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "") {
    return null;
  }
  try {
    return new PrismaClient();
  } catch {
    return null;
  }
}

async function probe(client: PrismaClient | null): Promise<boolean> {
  if (!client) return false;
  try {
    await client.$queryRawUnsafe("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const prisma = makeClient();
const dbAvailable = await probe(prisma);

if (!dbAvailable) {
  console.warn(
    "[authorization-ownership.integration] BD no disponible: se salta la pertenencia end-to-end (se ejecuta en CI).",
  );
}

const client = prisma as PrismaClient;
let app: FastifyInstance;

const parentAEmail = `parentA-${randomUUID()}@piensa.test`;
const parentBEmail = `parentB-${randomUUID()}@piensa.test`;
let parentAId: string;
let parentBId: string;
let familyAId: string;
let familyBId: string;
let studentAId: string;
let studentBId: string;

beforeAll(async () => {
  if (!dbAvailable) return;
  app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.register(conventionsPlugin);
  const authz = createAuthorization({ jwtSecret: SECRET, prisma: client });
  app.register(
    async (scope) => {
      scope.get(
        "/__test/students/:id",
        {
          preHandler: [
            authz.authenticate,
            authz.requireRole("parent", "student"),
            authz.requireStudentOwnership({ from: "params", key: "id" }),
          ],
        },
        async () => ({ data: { ok: true } }),
      );
    },
    { prefix: "/api/v1" },
  );
  await app.ready();

  const pinHash = await hashPassword("4321");
  const parentA = await client.user.create({
    data: {
      email: parentAEmail,
      passwordHash: await hashPassword("x"),
      role: "parent",
    },
  });
  parentAId = parentA.id;
  const familyA = await client.family.create({
    data: { name: "Familia A", parentUserId: parentA.id },
  });
  familyAId = familyA.id;
  const studentA = await client.studentProfile.create({
    data: { familyId: familyA.id, name: "Hijo A", avatar: "🦊", pinHash },
  });
  studentAId = studentA.id;

  const parentB = await client.user.create({
    data: {
      email: parentBEmail,
      passwordHash: await hashPassword("x"),
      role: "parent",
    },
  });
  parentBId = parentB.id;
  const familyB = await client.family.create({
    data: { name: "Familia B", parentUserId: parentB.id },
  });
  familyBId = familyB.id;
  const studentB = await client.studentProfile.create({
    data: { familyId: familyB.id, name: "Hijo B", avatar: "🐼", pinHash },
  });
  studentBId = studentB.id;
});

afterAll(async () => {
  if (!dbAvailable) return;
  await client.studentProfile.deleteMany({
    where: { id: { in: [studentAId, studentBId] } },
  });
  await client.family.deleteMany({
    where: { id: { in: [familyAId, familyBId] } },
  });
  await client.user.deleteMany({
    where: { id: { in: [parentAId, parentBId] } },
  });
  await app.close();
  await client.$disconnect();
});

async function get(id: string, bearer: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/__test/students/${id}`,
    headers: { authorization: `Bearer ${bearer}` },
  });
}

describe.skipIf(!dbAvailable)("requireStudentOwnership contra BD", () => {
  test("padre → hijo propio → 200", async () => {
    const token = await createAccessToken(SECRET, {
      userId: parentAId,
      role: "parent",
      familyId: familyAId,
    });
    const res = await get(studentAId, token);
    expect(res.statusCode).toBe(200);
  });

  test("padre → hijo de OTRA familia → 403 (aunque el ID exista)", async () => {
    const token = await createAccessToken(SECRET, {
      userId: parentAId,
      role: "parent",
      familyId: familyAId,
    });
    const res = await get(studentBId, token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("alumno → su propio perfil → 200", async () => {
    const token = await createAccessToken(SECRET, {
      studentProfileId: studentAId,
      role: "student",
      familyId: familyAId,
    });
    const res = await get(studentAId, token);
    expect(res.statusCode).toBe(200);
  });

  test("alumno → otro perfil → 403", async () => {
    const token = await createAccessToken(SECRET, {
      studentProfileId: studentAId,
      role: "student",
      familyId: familyAId,
    });
    const res = await get(studentBId, token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
```

- [ ] **Step 2: Run test to verify it fails / auto-salta**

Run: `npx vitest run tests/auth/authorization-ownership.integration.test.ts`
Expected sin BD: los 4 tests SKIPPED con el `console.warn` (no falla, no verde fabricado). Con BD (CI): PASS los 4.

- [ ] **Step 3: Write minimal implementation**

Ninguna: `requireStudentOwnership` ya quedó implementado en Task 1. Este paso confirma que la interfaz declarada cubre el comportamiento.

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL="postgresql://piensa:piensa@localhost:5432/piensa_test?schema=public" npx vitest run tests/auth/authorization-ownership.integration.test.ts` (si hay BD local migrada); en su defecto, se valida en CI.
Expected: PASS los 4 con BD; SKIPPED sin BD.

- [ ] **Step 5: Commit**

```bash
git add tests/auth/authorization-ownership.integration.test.ts
git commit -m "test(auth): pertenencia contra BD end-to-end (ISSUE-09)"
```

---

### Task 3: Refactor de `/auth/student-session` a las primitivas

**Files:**
- Modify: `src/modules/auth/routes.ts` (elimina `requireParent` inline; usa `authenticate` + `requireRole("parent")`).

**Interfaces:**
- Consumes: `createAuthorization` de `./authorize.js`.
- Produces: contrato de `/auth/student-session` sin cambios observables (401 sin/ mal token, 403 no-padre, 400 validación).

- [ ] **Step 1: Confirmar el test existente que cubre el contrato**

Ya existe `tests/auth/student-session-routes.test.ts` (sin token → 401, token inválido → 401, alumno → 403, admin → 403, validaciones → 400). Sirve de red de seguridad del refactor. No se escribe test nuevo.

- [ ] **Step 2: Run para ver el estado verde previo**

Run: `npx vitest run tests/auth/student-session-routes.test.ts`
Expected: PASS (9 tests) con la implementación inline actual.

- [ ] **Step 3: Refactor**

En `src/modules/auth/routes.ts`:

1. Reemplazar los imports de la cabecera:

```typescript
import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { login, refresh } from "./service.js";
import { createStudentSession } from "./student-session.js";
import { createAuthorization } from "./authorize.js";
```

(Se quitan `FastifyRequest` y `verifyAccessToken`, que ya no se usan aquí.)

2. Borrar por completo la función `requireParent` (todo el bloque `async function requireParent(...) { ... }`).

3. Dentro de `authRoutes`, tras `const { prisma, jwtSecret } = opts;`, construir la autorización:

```typescript
  const authz = createAuthorization({ jwtSecret, prisma });
```

4. Reemplazar el handler de `/auth/student-session` para usar los preHandlers y leer el principal:

```typescript
  app.post<{ Body: StudentSessionBody }>(
    "/auth/student-session",
    {
      schema: { body: studentSessionBodySchema },
      preHandler: [authz.authenticate, authz.requireRole("parent")],
    },
    async (request) => {
      const principal = request.authPrincipal;
      if (!principal?.userId) {
        throw new AppError("UNAUTHORIZED", "No autenticado.");
      }
      const parentUserId = principal.userId;

      // La familia del padre se resuelve contra la BD, no desde el token: la
      // pertenencia del perfil se compara contra este valor (Spec §6).
      const parentFamilyId = await familyIdOf(parentUserId);
      if (parentFamilyId === null) {
        throw new AppError(
          "FORBIDDEN",
          "La cuenta no tiene una familia asociada.",
        );
      }

      const { studentProfileId, pin } = request.body;
      const result = await createStudentSession(
        {
          jwtSecret,
          now: () => new Date(),
          findStudentProfile: (id) =>
            prisma.studentProfile.findUnique({
              where: { id },
              select: {
                id: true,
                familyId: true,
                pinHash: true,
                failedPinAttempts: true,
                pinLockedUntil: true,
              },
            }),
          updatePinState: async (id, state) => {
            await prisma.studentProfile.update({
              where: { id },
              data: state,
            });
          },
        },
        { parentFamilyId, studentProfileId, pin },
      );

      return { data: result };
    },
  );
```

(`familyIdOf` sigue siendo el helper local ya presente en `authRoutes`.)

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/auth/student-session-routes.test.ts tests/auth/authorization-matrix.test.ts`
Expected: PASS (9 + 15).

- [ ] **Step 5: Commit**

```bash
git add src/modules/auth/routes.ts
git commit -m "refactor(auth): /auth/student-session usa las primitivas de autorización (ISSUE-09)"
```

---

### Task 4: Verificación integral y PR

- [ ] **Step 1: Suite completa + typecheck + lint + build**

Run:
```bash
npx vitest run && npm run typecheck && npm run lint && npm run build
```
Expected: todos verdes; los tests de integración (incl. `authorization-ownership`) SKIPPED sin BD.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/issue-09-authorization
gh pr create --base main --head feat/issue-09-authorization \
  --title "feat(auth): autorización por rol y pertenencia (ISSUE-09)" \
  --body "<resumen: primitivas authenticate/requireRole/requireStudentOwnership, refactor de /auth/student-session, matriz rol×endpoint + pertenencia contra BD; criterios 3/3>"
```

- [ ] **Step 3: Confirmar CI verde**

Run: `gh pr checks <n>`
Expected: Lint · Build · Test → pass.

## Notas de trazabilidad spec → tareas

- Criterio 1 (token de alumno en endpoint de padre → FORBIDDEN): Task 1 (matriz).
- Criterio 2 (padre → hijo ajeno → FORBIDDEN aunque el ID exista): Task 2 (integración).
- Criterio 3 (suite de matriz extensible): Task 1 (`MATRIX` + helper `call`).
- Refactor del `requireParent` inline que ISSUE-08 dejó pendiente: Task 3.
