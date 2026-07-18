# ISSUE-35 — Rol super_admin y gestión de cuentas admin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) para implementar task por task. Steps con checkbox (`- [ ]`).

**Goal:** Agregar un rol `super_admin` que hereda todo lo de `admin` y gestiona cuentas admin (crear/listar/suspender/reactivar/borrar, estilo Moodle), con suspensión de admin efectiva de inmediato.

**Architecture:** `super_admin` es un valor nuevo del enum `UserRole`; `requireRole` implementa jerarquía (super_admin satisface cualquier chequeo de admin, sin habilitarlo ruta por ruta — fail-safe). La suspensión de admin usa `User.status` leído en `authenticate` en cada request (mismo principio de ISSUE-10, a nivel User) → código nuevo `ACCOUNT_SUSPENDED`. Los endpoints viven en `src/modules/admin/` bajo `/api/v1/admin`, gateados por `requireRole('super_admin')`, y solo pueden apuntar a usuarios rol `admin`. Este issue también extrae los patterns de validación a `src/lib/validation.ts` (fuente única anti-`coerceTypes`).

**Tech Stack:** Fastify · Prisma · PostgreSQL · argon2 (`@node-rs/argon2` vía `src/modules/auth/password.ts`) · jose · Vitest.

Referencia de diseño (aprobado): `docs/superpowers/specs/2026-07-17-milestone-2-catalog-admin-architecture.md` §2.8. Cuerpo del issue: `Issues.MD` ISSUE-35.

## Global Constraints

- **TDD obligatorio:** test que falla → implementación mínima → commit.
- **Seguridad primero (preferencia del usuario):** jerarquía fail-safe (las rutas admin dicen `requireRole('admin')` y super_admin pasa por diseño, imposible olvidar); los endpoints de gestión **solo** apuntan a usuarios rol `admin` (nunca a super_admin ni parent → `FORBIDDEN`); ningún endpoint crea/eleva a super_admin (el rol se fija a `admin` en el servidor).
- **Errores:** `AppError(code, message)` del catálogo `ErrorCode` (`src/plugins/errors.ts`). Código nuevo `ACCOUNT_SUSPENDED` (403).
- **Validación:** IDs con `UUID_PATTERN`, email con `EMAIL_PATTERN` (desde `src/lib/validation.ts`), objetos con `additionalProperties: false`. `ajv` corre con `coerceTypes: true`, por eso `pattern`/límites, no `type` a secas.
- **Tests de BD auto-saltables:** patrón `makeClient()/probe()/describe.skipIf(!dbAvailable)` (ver `tests/prisma/personas-constraints.test.ts`). Auto-salta local, corre en CI.
- **ESM:** imports internos con extensión `.js`.
- **No tocar `tokens.ts` ni el login:** `TokenRole = UserRole | "student"`, así que `super_admin` fluye solo al token y a los claims; el login toma `role` de `User.role` en la BD. No requieren cambios.

---

## File Structure

- **Modify:** `prisma/schema.prisma` — `super_admin` en `UserRole`; enum nuevo `UserStatus`; campo `status UserStatus @default(active)` en `User`.
- **Create:** `prisma/migrations/<ts>_super_admin/migration.sql` (generada).
- **Create:** `src/lib/validation.ts` — patterns compartidos (`UUID_PATTERN`, `EMAIL_PATTERN`, `PIN_PATTERN`).
- **Modify:** `src/modules/auth/routes.ts` — importar los patterns desde `validation.ts` (sin cambio de comportamiento).
- **Modify:** `src/plugins/errors.ts` — `ACCOUNT_SUSPENDED`.
- **Modify:** `src/modules/auth/authorize.ts` — jerarquía en `requireRole`; chequeo de `User.status` en `authenticate`.
- **Create:** `src/modules/admin/users-service.ts` — lógica de gestión de admins (sin Fastify).
- **Create:** `src/modules/admin/routes.ts` — plugin de rutas `/admin/users`.
- **Modify:** `src/app.ts` — registrar `adminRoutes` bajo `/api/v1`.
- **Create tests:** `tests/lib/validation.test.ts`, `tests/prisma/user-roles-status.test.ts`, `tests/auth/role-hierarchy.test.ts`, `tests/auth/admin-suspension.test.ts`, `tests/admin/users.integration.test.ts`.
- **Modify test:** `tests/auth/authorization-matrix.test.ts` — stub `user.findUnique` + filas de super_admin y `/admin/users`.

---

## Task 1: Migración — `super_admin` + `User.status`

**Files:**
- Create: `tests/prisma/user-roles-status.test.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_super_admin/migration.sql`

**Interfaces:**
- Produces: `enum UserRole { admin, parent, super_admin }`, `enum UserStatus { active, suspended }`, `User.status: UserStatus` (default `active`) — consumidos por las Tasks 3 y 4 y por `@prisma/client`.

- [ ] **Step 1: Test estático (falla)**

Create `tests/prisma/user-roles-status.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Verificación estática (ISSUE-35): el enum UserRole incluye super_admin, existe
// UserStatus y User tiene status. Sin BD; los constraints reales corren en CI.

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const schema = readFileSync(
  resolve(projectRoot, "prisma", "schema.prisma"),
  "utf8",
);

describe("schema.prisma — rol super_admin y estado de User", () => {
  test("UserRole incluye admin, parent y super_admin", () => {
    expect(schema).toMatch(
      /enum\s+UserRole\s*\{[\s\S]*?admin[\s\S]*?parent[\s\S]*?super_admin[\s\S]*?\}/,
    );
  });

  test("UserStatus declara active y suspended", () => {
    expect(schema).toMatch(
      /enum\s+UserStatus\s*\{[\s\S]*?active[\s\S]*?suspended[\s\S]*?\}/,
    );
  });

  test("User tiene status: UserStatus con default active", () => {
    const user = schema.match(/model\s+User\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(user).toMatch(/status\s+UserStatus\s+@default\(active\)/);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run tests/prisma/user-roles-status.test.ts`
Expected: FAIL (super_admin / UserStatus / status ausentes).

- [ ] **Step 3: Editar `prisma/schema.prisma`**

En el enum `UserRole` agregar `super_admin`:

```prisma
enum UserRole {
  admin
  parent
  super_admin
}
```

Después del enum `UserRole` agregar:

```prisma
// Estado de una cuenta con credenciales. `suspended` corta el acceso del admin
// en el siguiente request aunque su token siga vigente (ISSUE-35, mismo
// principio que la suspensión de familia de ISSUE-10 pero a nivel User).
enum UserStatus {
  active
  suspended
}
```

En el modelo `User`, agregar el campo `status` (después de `role`):

```prisma
  role         UserRole
  status       UserStatus @default(active)
```

- [ ] **Step 4: Formatear, validar y correr el test estático**

Run: `npx prisma format && DATABASE_URL="postgresql://u:u@localhost:5432/db" npx prisma validate && npx vitest run tests/prisma/user-roles-status.test.ts`
Expected: schema válido; 3 tests PASAN. (El valor de `DATABASE_URL` solo satisface a `prisma validate`; no conecta.)

- [ ] **Step 5: Generar la migración (offline) y el cliente**

Docker no siempre está disponible; se genera el SQL sin conexión diffando el schema viejo (git) contra el nuevo:

```bash
OLD=$(mktemp -t oldschema).prisma
git show HEAD:prisma/schema.prisma > "$OLD"
TS=$(date +%Y%m%d%H%M%S)
DIR="prisma/migrations/${TS}_super_admin"
mkdir -p "$DIR"
npx prisma migrate diff --from-schema-datamodel "$OLD" --to-schema-datamodel prisma/schema.prisma --script > "$DIR/migration.sql"
npx prisma generate
cat "$DIR/migration.sql"
```

Expected: la migración hace `ALTER TYPE "UserRole" ADD VALUE 'super_admin'`, `CREATE TYPE "UserStatus"`, y `ALTER TABLE "User" ADD COLUMN "status" "UserStatus" NOT NULL DEFAULT 'active'`. El cliente Prisma se regenera con el nuevo enum y campo.

> Nota: `ALTER TYPE ... ADD VALUE` no puede correr dentro de una transacción con otras sentencias en algunas versiones de Postgres. Si `migrate deploy` falla por eso (`ALTER TYPE ... cannot run inside a transaction block`), separar el `ADD VALUE` en su **propia migración** anterior (carpeta con timestamp menor, solo esa sentencia) y dejar `CREATE TYPE UserStatus` + `ADD COLUMN` en la segunda. Verificar en Task 5 al aplicar contra Postgres real.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/prisma/user-roles-status.test.ts
git commit -m "feat(auth): rol super_admin y estado suspendible de User (ISSUE-35)"
```

---

## Task 2: Validación compartida `src/lib/validation.ts`

Extrae los patterns anti-`coerceTypes` a una fuente única con test propio, y refactoriza `auth/routes.ts` para importarlos (sin cambiar comportamiento).

**Files:**
- Create: `tests/lib/validation.test.ts`
- Create: `src/lib/validation.ts`
- Modify: `src/modules/auth/routes.ts`

**Interfaces:**
- Produces: `UUID_PATTERN`, `EMAIL_PATTERN`, `PIN_PATTERN` (strings de regex) — consumidos por `auth/routes.ts` y `admin/routes.ts` (Task 4).

- [ ] **Step 1: Test de los patterns (falla)**

Create `tests/lib/validation.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { UUID_PATTERN, EMAIL_PATTERN, PIN_PATTERN } from "../../src/lib/validation.js";

const matches = (pattern: string, value: string) =>
  new RegExp(pattern).test(value);

describe("UUID_PATTERN", () => {
  test("acepta un UUID válido (minúsculas y mayúsculas)", () => {
    expect(matches(UUID_PATTERN, "3f1d2c4b-5a6e-7f80-9123-abcdef012345")).toBe(true);
    expect(matches(UUID_PATTERN, "3F1D2C4B-5A6E-7F80-9123-ABCDEF012345")).toBe(true);
  });
  test("rechaza basura, prefijos/sufijos y strings vacíos (anclado)", () => {
    expect(matches(UUID_PATTERN, "no-uuid")).toBe(false);
    expect(matches(UUID_PATTERN, " 3f1d2c4b-5a6e-7f80-9123-abcdef012345")).toBe(false);
    expect(matches(UUID_PATTERN, "3f1d2c4b-5a6e-7f80-9123-abcdef012345;DROP")).toBe(false);
    expect(matches(UUID_PATTERN, "")).toBe(false);
  });
});

describe("EMAIL_PATTERN", () => {
  test("acepta un email conservador", () => {
    expect(matches(EMAIL_PATTERN, "ana@piensa.test")).toBe(true);
  });
  test("rechaza sin arroba, con espacios o sin dominio", () => {
    expect(matches(EMAIL_PATTERN, "ana-piensa.test")).toBe(false);
    expect(matches(EMAIL_PATTERN, "ana @piensa.test")).toBe(false);
    expect(matches(EMAIL_PATTERN, "ana@")).toBe(false);
  });
});

describe("PIN_PATTERN", () => {
  test("acepta exactamente 4 dígitos", () => {
    expect(matches(PIN_PATTERN, "0421")).toBe(true);
  });
  test("rechaza longitudes distintas o no-dígitos", () => {
    expect(matches(PIN_PATTERN, "042")).toBe(false);
    expect(matches(PIN_PATTERN, "04210")).toBe(false);
    expect(matches(PIN_PATTERN, "04a1")).toBe(false);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run tests/lib/validation.test.ts`
Expected: FAIL (módulo `src/lib/validation.js` inexistente).

- [ ] **Step 3: Crear `src/lib/validation.ts`**

```typescript
// Patterns de validación compartidos (fuente única). Fastify usa ajv con
// `coerceTypes: true`, así que validar por `type` coacciona en vez de rechazar;
// estos patterns anclados (^...$) rechazan tipos coaccionados y formas
// inválidas. Centralizados para que endurecer uno cubra a todos los consumidores
// (evita el drift por copy-paste, que es donde viven los bugs de validación).

// UUID validado por `pattern` (ajv-formats no está registrado). Cubre las
// variantes hex minúscula/mayúscula que produce Prisma.
export const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

// Email deliberadamente conservador: descarta tipos coaccionados y formas
// obviamente inválidas. La validación real de existencia la hace el servicio.
export const EMAIL_PATTERN = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";

// PIN de exactamente 4 dígitos.
export const PIN_PATTERN = "^[0-9]{4}$";
```

- [ ] **Step 4: Refactorizar `src/modules/auth/routes.ts`**

Eliminar las definiciones locales de `UUID_PATTERN`, `EMAIL_PATTERN` y `PIN_PATTERN` (los bloques de comentario + `const`), y agregar el import (junto a los otros imports del archivo):

```typescript
import { UUID_PATTERN, EMAIL_PATTERN, PIN_PATTERN } from "../../lib/validation.js";
```

Dejar `REFRESH_TOKEN_PATTERN` como está (es específico de auth). No cambiar ningún schema ni handler: solo cambia de dónde vienen las constantes.

- [ ] **Step 5: Verificar patterns + no-regresión de auth**

Run: `npx vitest run tests/lib/validation.test.ts tests/auth/login-routes.test.ts tests/auth/student-session-routes.test.ts tests/auth/refresh-routes.test.ts`
Expected: todos PASAN (los patterns funcionan y las rutas de auth siguen validando igual).

- [ ] **Step 6: Commit**

```bash
git add src/lib/validation.ts src/modules/auth/routes.ts tests/lib/validation.test.ts
git commit -m "refactor(validation): patterns compartidos en src/lib/validation.ts (ISSUE-35)"
```

---

## Task 3: `ACCOUNT_SUSPENDED` + jerarquía de roles + suspensión de admin

**Files:**
- Modify: `src/plugins/errors.ts`
- Modify: `src/modules/auth/authorize.ts`
- Create: `tests/auth/role-hierarchy.test.ts`
- Create: `tests/auth/admin-suspension.test.ts`

**Interfaces:**
- Consumes: `AccessTokenClaims`, `createAuthorization` (authorize.ts), `AppError` (errors.ts).
- Produces: `ERROR_CODES` incluye `ACCOUNT_SUSPENDED`; `requireRole('admin')` aceptado por super_admin; `authenticate` corta a un admin con `User.status = suspended`.

- [ ] **Step 1: `ACCOUNT_SUSPENDED` en el catálogo de errores**

En `src/plugins/errors.ts`:
- Agregar `"ACCOUNT_SUSPENDED"` al array `ERROR_CODES` (después de `"FAMILY_SUSPENDED"`).
- En `STATUS_BY_CODE` agregar `ACCOUNT_SUSPENDED: 403,`.
- En `SAFE_MESSAGES` agregar `ACCOUNT_SUSPENDED: "La cuenta está suspendida.",`.

(El `Record<ErrorCode, number>` y `Record<ErrorCode, string>` fuerzan en compilación a completar ambos mapas: si falta uno, `typecheck` falla.)

- [ ] **Step 2: Test de jerarquía de roles (falla)**

Create `tests/auth/role-hierarchy.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { conventionsPlugin } from "../../src/plugins/conventions.js";
import { createAuthorization } from "../../src/modules/auth/authorize.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Jerarquía super_admin ⊇ admin (ISSUE-35): un super_admin pasa cualquier
// requireRole('admin'); un admin normal NO pasa requireRole('super_admin').
// Solo rol; el stub de prisma devuelve cuentas activas para authenticate.

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
  const authz = createAuthorization({
    jwtSecret: SECRET,
    prisma: {
      family: { findUnique: async () => ({ status: "active" }) },
      user: { findUnique: async () => ({ status: "active" }) },
    } as unknown as PrismaClient,
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
        "/__test/super-only",
        { preHandler: [authz.authenticate, authz.requireRole("super_admin")] },
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

const tokenFor = (role: "admin" | "super_admin") =>
  createAccessToken(SECRET, { userId: "u1", role });

const call = (path: string, bearer: string) =>
  app.inject({
    method: "GET",
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${bearer}` },
  });

describe("jerarquía de roles", () => {
  test("super_admin pasa una ruta requireRole('admin')", async () => {
    const res = await call("/__test/admin-only", await tokenFor("super_admin"));
    expect(res.statusCode).toBe(200);
  });
  test("super_admin pasa una ruta requireRole('super_admin')", async () => {
    const res = await call("/__test/super-only", await tokenFor("super_admin"));
    expect(res.statusCode).toBe(200);
  });
  test("admin NO pasa una ruta requireRole('super_admin')", async () => {
    const res = await call("/__test/super-only", await tokenFor("admin"));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});
```

- [ ] **Step 3: Verificar que falla**

Run: `npx vitest run tests/auth/role-hierarchy.test.ts`
Expected: FAIL — `super_admin → /__test/admin-only` da 403 (sin jerarquía) y/o `user.findUnique` rompe.

- [ ] **Step 4: Implementar jerarquía en `requireRole` (authorize.ts)**

Reemplazar el cuerpo de `requireRole` por una versión con implicación super_admin ⊇ admin:

```typescript
  const requireRole =
    (...roles: TokenRole[]): preHandlerHookHandler =>
    async (request) => {
      const principal = request.authPrincipal;
      if (!principal) {
        throw new AppError("UNAUTHORIZED", "No autenticado.");
      }
      // Jerarquía: un super_admin satisface cualquier chequeo de admin, sin
      // habilitarlo ruta por ruta (fail-safe). Una ruta que exige explícitamente
      // 'super_admin' NO la satisface un admin.
      const allowed = new Set<TokenRole>(roles);
      if (allowed.has("admin")) {
        allowed.add("super_admin");
      }
      if (!allowed.has(principal.role)) {
        throw new AppError("FORBIDDEN", "No tienes permiso para esta acción.");
      }
    };
```

- [ ] **Step 5: Implementar suspensión de admin en `authenticate` (authorize.ts)**

Dentro de `authenticate`, después de verificar el token y antes de `request.authPrincipal = principal`, agregar el chequeo de `User.status` para admin/super_admin (que no tienen `familyId`):

```typescript
    // Suspensión de cuenta admin efectiva de inmediato (ISSUE-35): el estado del
    // User se lee de la BD en cada request de admin/super_admin. Un token aún
    // vigente no basta si la cuenta fue suspendida. Padres/alumnos siguen por
    // Family.status (arriba); no se agregan queries a su camino.
    if (
      (principal.role === "admin" || principal.role === "super_admin") &&
      principal.userId !== undefined
    ) {
      const user = await prisma.user.findUnique({
        where: { id: principal.userId },
        select: { status: true },
      });
      if (user?.status === "suspended") {
        throw new AppError("ACCOUNT_SUSPENDED", "La cuenta está suspendida.");
      }
    }
```

- [ ] **Step 6: Verificar jerarquía**

Run: `npx vitest run tests/auth/role-hierarchy.test.ts`
Expected: 3 tests PASAN.

- [ ] **Step 7: Test de suspensión de admin (falla → pasa)**

Create `tests/auth/admin-suspension.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { conventionsPlugin } from "../../src/plugins/conventions.js";
import { createAuthorization } from "../../src/modules/auth/authorize.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Suspensión de admin efectiva de inmediato (ISSUE-35): con el token válido, si
// User.status = suspended el request se corta con ACCOUNT_SUSPENDED. Stub de
// prisma parametrizable por status.

const SECRET = "test-secret-at-least-16-chars-long";

function appWithUserStatus(status: "active" | "suspended"): FastifyInstance {
  const app = Fastify({
    logger: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false } },
  });
  app.register(conventionsPlugin);
  const authz = createAuthorization({
    jwtSecret: SECRET,
    prisma: {
      family: { findUnique: async () => ({ status: "active" }) },
      user: { findUnique: async () => ({ status }) },
    } as unknown as PrismaClient,
  });
  app.register(
    async (scope) => {
      scope.get(
        "/__test/admin-only",
        { preHandler: [authz.authenticate, authz.requireRole("admin")] },
        async () => ({ data: { ok: true } }),
      );
    },
    { prefix: "/api/v1" },
  );
  return app;
}

const call = (app: FastifyInstance, bearer: string) =>
  app.inject({
    method: "GET",
    url: "/api/v1/__test/admin-only",
    headers: { authorization: `Bearer ${bearer}` },
  });

describe("suspensión de cuenta admin", () => {
  let active: FastifyInstance;
  let suspended: FastifyInstance;
  beforeAll(async () => {
    active = appWithUserStatus("active");
    suspended = appWithUserStatus("suspended");
    await Promise.all([active.ready(), suspended.ready()]);
  });
  afterAll(async () => {
    await Promise.all([active.close(), suspended.close()]);
  });

  test("admin activo pasa", async () => {
    const token = await createAccessToken(SECRET, { userId: "a1", role: "admin" });
    expect((await call(active, token)).statusCode).toBe(200);
  });

  test("admin suspendido → ACCOUNT_SUSPENDED con token aún vigente", async () => {
    const token = await createAccessToken(SECRET, { userId: "a1", role: "admin" });
    const res = await call(suspended, token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ACCOUNT_SUSPENDED");
  });

  test("super_admin suspendido también se corta", async () => {
    const token = await createAccessToken(SECRET, { userId: "s1", role: "super_admin" });
    const res = await call(suspended, token);
    expect(res.json().error.code).toBe("ACCOUNT_SUSPENDED");
  });
});
```

Run: `npx vitest run tests/auth/admin-suspension.test.ts`
Expected: 3 tests PASAN (la lógica ya está implementada en Step 5).

- [ ] **Step 8: Commit**

```bash
git add src/plugins/errors.ts src/modules/auth/authorize.ts tests/auth/role-hierarchy.test.ts tests/auth/admin-suspension.test.ts
git commit -m "feat(auth): jerarquía super_admin y suspensión de admin en authenticate (ISSUE-35)"
```

---

## Task 4: Endpoints `/admin/users` (super_admin)

**Files:**
- Create: `src/modules/admin/users-service.ts`
- Create: `src/modules/admin/routes.ts`
- Modify: `src/app.ts`
- Create: `tests/admin/users.integration.test.ts`
- Modify: `tests/auth/authorization-matrix.test.ts`

**Interfaces:**
- Consumes: `hashPassword` (`src/modules/auth/password.ts`), `AppError`, `createAuthorization`, `UUID_PATTERN`/`EMAIL_PATTERN` (validation.ts).
- Produces: rutas `/api/v1/admin/users` (POST, GET), `/admin/users/:id/suspend`, `/reactivate`, `DELETE /admin/users/:id` — solo super_admin, solo sobre usuarios rol `admin`.

- [ ] **Step 1: Servicio de gestión de admins (con test unitario, falla)**

Create `tests/admin/users-service.test.ts`:

```typescript
import { describe, expect, test, vi } from "vitest";
import {
  suspendAdmin,
  deleteAdmin,
  type AdminUsersDeps,
} from "../../src/modules/admin/users-service.js";
import { AppError } from "../../src/plugins/errors.js";

// El servicio solo puede actuar sobre usuarios rol `admin`. Un target super_admin
// o parent (o inexistente) → FORBIDDEN. Sin BD: deps stubbeadas.

function deps(overrides: Partial<AdminUsersDeps> = {}): AdminUsersDeps {
  return {
    findUserById: async () => ({ id: "x", role: "admin", status: "active" }),
    setUserStatus: vi.fn(async () => {}),
    deleteUser: vi.fn(async () => {}),
    createUser: vi.fn(async () => ({ id: "new", email: "a@b.c", role: "admin", status: "active" })),
    listAdmins: async () => [],
    hashPassword: async () => "hashed",
    ...overrides,
  };
}

describe("guard de target rol admin", () => {
  test("suspender un target super_admin → FORBIDDEN", async () => {
    const d = deps({ findUserById: async () => ({ id: "s", role: "super_admin", status: "active" }) });
    await expect(suspendAdmin(d, "s")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(d.setUserStatus).not.toHaveBeenCalled();
  });
  test("borrar un target parent → FORBIDDEN", async () => {
    const d = deps({ findUserById: async () => ({ id: "p", role: "parent", status: "active" }) });
    await expect(deleteAdmin(d, "p")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(d.deleteUser).not.toHaveBeenCalled();
  });
  test("target inexistente → NOT_FOUND", async () => {
    const d = deps({ findUserById: async () => null });
    await expect(suspendAdmin(d, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  test("suspender un admin real → llama setUserStatus(suspended)", async () => {
    const d = deps();
    await suspendAdmin(d, "x");
    expect(d.setUserStatus).toHaveBeenCalledWith("x", "suspended");
  });
});
```

Run: `npx vitest run tests/admin/users-service.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 2: Implementar `src/modules/admin/users-service.ts`**

```typescript
// Gestión de cuentas admin por un super_admin (ISSUE-35). Sin Fastify ni Prisma
// directo: recibe sus dependencias para probarse en aislamiento. Regla de
// seguridad: solo puede actuar sobre usuarios rol `admin` (nunca super_admin ni
// parent); ningún camino produce un super_admin.

import type { UserRole, UserStatus } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";

export interface AdminUserView {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
}

export interface AdminUsersDeps {
  findUserById: (
    id: string,
  ) => Promise<{ id: string; role: UserRole; status: UserStatus } | null>;
  setUserStatus: (id: string, status: UserStatus) => Promise<void>;
  deleteUser: (id: string) => Promise<void>;
  createUser: (input: {
    email: string;
    passwordHash: string;
  }) => Promise<AdminUserView>;
  listAdmins: () => Promise<AdminUserView[]>;
  hashPassword: (plain: string) => Promise<string>;
}

/** Carga un usuario y exige que sea rol `admin`; si no, corta sin actuar. */
async function loadAdminTarget(deps: AdminUsersDeps, id: string) {
  const user = await deps.findUserById(id);
  if (!user) {
    throw new AppError("NOT_FOUND", "Usuario no encontrado.");
  }
  if (user.role !== "admin") {
    // Un super_admin (o parent) no se gestiona por API (Spec §2, ISSUE-35).
    throw new AppError(
      "FORBIDDEN",
      "Solo se pueden gestionar cuentas de administrador.",
    );
  }
  return user;
}

export async function createAdmin(
  deps: AdminUsersDeps,
  input: { email: string; password: string },
): Promise<AdminUserView> {
  const passwordHash = await deps.hashPassword(input.password);
  // createUser fija el rol a `admin` en la capa de datos (Task 4 Step 3): este
  // servicio nunca produce un super_admin.
  return deps.createUser({ email: input.email, passwordHash });
}

export function listAdmins(deps: AdminUsersDeps): Promise<AdminUserView[]> {
  return deps.listAdmins();
}

export async function suspendAdmin(deps: AdminUsersDeps, id: string): Promise<void> {
  await loadAdminTarget(deps, id);
  await deps.setUserStatus(id, "suspended");
}

export async function reactivateAdmin(deps: AdminUsersDeps, id: string): Promise<void> {
  await loadAdminTarget(deps, id);
  await deps.setUserStatus(id, "active");
}

export async function deleteAdmin(deps: AdminUsersDeps, id: string): Promise<void> {
  await loadAdminTarget(deps, id);
  await deps.deleteUser(id);
}
```

Run: `npx vitest run tests/admin/users-service.test.ts` → PASS.

- [ ] **Step 3: Rutas `src/modules/admin/routes.ts`**

```typescript
// Rutas de gestión de admins (ISSUE-35), bajo /api/v1/admin. Todas exigen
// super_admin. `createUser` fija el rol a `admin` acá (nunca super_admin).

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { createAuthorization } from "../auth/authorize.js";
import { hashPassword } from "../auth/password.js";
import { UUID_PATTERN, EMAIL_PATTERN } from "../../lib/validation.js";
import {
  createAdmin,
  listAdmins,
  suspendAdmin,
  reactivateAdmin,
  deleteAdmin,
  type AdminUsersDeps,
} from "./users-service.js";

export interface AdminRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const createAdminBodySchema = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: false,
  properties: {
    email: { type: "string", pattern: EMAIL_PATTERN, maxLength: 254 },
    password: { type: "string", minLength: 12, maxLength: 1024 },
  },
} as const;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

interface CreateAdminBody {
  email: string;
  password: string;
}
interface IdParams {
  id: string;
}

export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const superAdmin = [authz.authenticate, authz.requireRole("super_admin")];

  const deps: AdminUsersDeps = {
    findUserById: (id) =>
      prisma.user.findUnique({
        where: { id },
        select: { id: true, role: true, status: true },
      }),
    setUserStatus: async (id, status) => {
      await prisma.user.update({ where: { id }, data: { status } });
    },
    deleteUser: async (id) => {
      await prisma.user.delete({ where: { id } });
    },
    createUser: (input) =>
      prisma.user.create({
        // Rol fijado a `admin`: la API nunca crea un super_admin (ISSUE-35).
        data: { email: input.email, passwordHash: input.passwordHash, role: "admin" },
        select: { id: true, email: true, role: true, status: true },
      }),
    listAdmins: () =>
      prisma.user.findMany({
        where: { role: "admin" },
        select: { id: true, email: true, role: true, status: true },
        orderBy: { createdAt: "asc" },
      }),
    hashPassword,
  };

  app.post<{ Body: CreateAdminBody }>(
    "/admin/users",
    { schema: { body: createAdminBodySchema }, preHandler: superAdmin },
    async (request, reply) => {
      const admin = await createAdmin(deps, request.body);
      reply.code(201);
      return { data: admin };
    },
  );

  app.get(
    "/admin/users",
    { preHandler: superAdmin },
    async () => ({ data: await listAdmins(deps) }),
  );

  app.post<{ Params: IdParams }>(
    "/admin/users/:id/suspend",
    { schema: { params: idParamsSchema }, preHandler: superAdmin },
    async (request) => {
      await suspendAdmin(deps, request.params.id);
      return { data: { id: request.params.id, status: "suspended" } };
    },
  );

  app.post<{ Params: IdParams }>(
    "/admin/users/:id/reactivate",
    { schema: { params: idParamsSchema }, preHandler: superAdmin },
    async (request) => {
      await reactivateAdmin(deps, request.params.id);
      return { data: { id: request.params.id, status: "active" } };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/users/:id",
    { schema: { params: idParamsSchema }, preHandler: superAdmin },
    async (request) => {
      await deleteAdmin(deps, request.params.id);
      return { data: { id: request.params.id, deleted: true } };
    },
  );
};
```

- [ ] **Step 4: Registrar en `src/app.ts`**

Agregar el import y el registro (junto al de `authRoutes`):

```typescript
import { adminRoutes } from "./modules/admin/routes.js";
```

```typescript
  app.register(
    async (scope) => {
      await adminRoutes(scope, { prisma, jwtSecret });
    },
    { prefix: "/api/v1" },
  );
```

- [ ] **Step 5: Extender la matriz de autorización**

En `tests/auth/authorization-matrix.test.ts`:

1. En el stub de prisma, agregar `user.findUnique` (ahora `authenticate` lo consulta para admin/super_admin):

```typescript
    prisma: {
      family: { findUnique: async () => ({ status: "active" }) },
      user: { findUnique: async () => ({ status: "active" }) },
    } as unknown as PrismaClient,
```

2. Agregar un endpoint `super_admin` de prueba dentro del `scope`:

```typescript
      scope.get(
        "/__test/super-only",
        { preHandler: [authz.authenticate, authz.requireRole("super_admin")] },
        ok,
      );
```

3. Extender `tokenFor` y el tipo de rol para incluir `super_admin`:

```typescript
async function tokenFor(
  role: "admin" | "parent" | "student" | "super_admin",
): Promise<string> {
  if (role === "parent")
    return createAccessToken(SECRET, { userId: "p1", role, familyId: "f1" });
  if (role === "student")
    return createAccessToken(SECRET, { studentProfileId: "s1", role, familyId: "f1" });
  // admin y super_admin: solo userId.
  return createAccessToken(SECRET, { userId: "u1", role });
}
```

4. Agregar filas a `MATRIX` (super_admin hereda admin; el endpoint super-only excluye a admin):

```typescript
const MATRIX: Record<string, Record<string, number>> = {
  "/__test/admin-only": { admin: 200, parent: 403, student: 403, super_admin: 200 },
  "/__test/parent-only": { admin: 403, parent: 200, student: 403, super_admin: 403 },
  "/__test/student-only": { admin: 403, parent: 403, student: 200, super_admin: 403 },
  "/__test/super-only": { admin: 403, parent: 403, student: 403, super_admin: 200 },
};
```

Run: `npx vitest run tests/auth/authorization-matrix.test.ts`
Expected: todas las combinaciones PASAN (incluye super_admin heredando admin y admin excluido de super-only).

- [ ] **Step 6: Test de integración end-to-end (necesita BD; auto-salta local)**

Create `tests/admin/users.integration.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Gestión de admins end-to-end contra Postgres real (ISSUE-35). Auto-salta sin
// BD; corre en CI. Siembra un super_admin y un admin directo por Prisma.

const SECRET = "test-secret-at-least-16-chars-long";

function makeClient(): PrismaClient | null {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "") return null;
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
if (!dbAvailable) {
  console.warn("[admin-users] BD no disponible: se saltan los tests (corren en CI).");
}
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("gestión de admins (super_admin)", () => {
  let app: FastifyInstance;
  let superToken: string;
  let adminToken: string;
  let superId: string;
  let adminId: string;
  const created: string[] = [];

  beforeAll(async () => {
    app = buildApp({ jwtSecret: SECRET, prisma: db });
    await app.ready();
    const su = await db.user.create({
      data: { email: `su-${randomUUID()}@piensa.test`, passwordHash: "x", role: "super_admin" },
    });
    const ad = await db.user.create({
      data: { email: `ad-${randomUUID()}@piensa.test`, passwordHash: "x", role: "admin" },
    });
    superId = su.id;
    adminId = ad.id;
    superToken = await createAccessToken(SECRET, { userId: su.id, role: "super_admin" });
    adminToken = await createAccessToken(SECRET, { userId: ad.id, role: "admin" });
  });

  afterAll(async () => {
    for (const id of created) await db.user.deleteMany({ where: { id } });
    await db.user.deleteMany({ where: { id: { in: [superId, adminId] } } });
    await app.close();
    await db.$disconnect();
  });

  const call = (method: string, path: string, token: string, body?: unknown) =>
    app.inject({
      method: method as "POST",
      url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${token}` },
      ...(body ? { payload: body } : {}),
    });

  test("super_admin crea un admin (rol admin, 201)", async () => {
    const res = await call("POST", "/admin/users", superToken, {
      email: `new-${randomUUID()}@piensa.test`,
      password: "una-clave-larga-123",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json().data;
    expect(body.role).toBe("admin");
    created.push(body.id);
  });

  test("un admin normal NO puede crear admins → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/users", adminToken, {
      email: `x-${randomUUID()}@piensa.test`,
      password: "una-clave-larga-123",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("suspender un admin corta su acceso en el siguiente request", async () => {
    const res = await call("POST", `/admin/users/${adminId}/suspend`, superToken);
    expect(res.statusCode).toBe(200);
    // El admin, con su token aún vigente, ya no pasa authenticate.
    const blocked = await call("GET", "/admin/users", adminToken);
    // (admin igual daría 403 por rol, pero acá el corte es ACCOUNT_SUSPENDED)
    expect(blocked.json().error.code).toBe("ACCOUNT_SUSPENDED");
    // Reactivar lo restaura (vuelve a ser admin activo, que igual no es super).
    const re = await call("POST", `/admin/users/${adminId}/reactivate`, superToken);
    expect(re.statusCode).toBe(200);
  });

  test("no se puede suspender a un super_admin → FORBIDDEN", async () => {
    const res = await call("POST", `/admin/users/${superId}/suspend`, superToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  test("borrar un admin lo elimina (204-ish, data.deleted)", async () => {
    const victim = await db.user.create({
      data: { email: `del-${randomUUID()}@piensa.test`, passwordHash: "x", role: "admin" },
    });
    const res = await call("DELETE", `/admin/users/${victim.id}`, superToken);
    expect(res.statusCode).toBe(200);
    const gone = await db.user.findUnique({ where: { id: victim.id } });
    expect(gone).toBeNull();
  });
});
```

> Nota sobre el test de suspensión: un admin suspendido llamando `GET /admin/users` es cortado por `authenticate` (ACCOUNT_SUSPENDED) **antes** de llegar al chequeo de rol, porque `authenticate` corre primero en la cadena de preHandlers. Eso es lo que verifica el assert.

- [ ] **Step 7: Commit**

```bash
git add src/modules/admin/users-service.ts src/modules/admin/routes.ts src/app.ts tests/admin/ tests/auth/authorization-matrix.test.ts
git commit -m "feat(admin): endpoints de gestión de admins por super_admin (ISSUE-35)"
```

---

## Task 5: Verificación final (con BD) + PR

- [ ] **Step 1: Levantar Postgres y aplicar migraciones**

Si Docker no está: `open -a Docker`, esperar el daemon, luego un Postgres desechable (evita chocar con el 5432 del host):

```bash
docker run -d --name piensa-pg-verify -e POSTGRES_USER=piensa -e POSTGRES_PASSWORD=piensa -e POSTGRES_DB=piensa_dev -p 127.0.0.1:5433:5432 postgres:17-alpine
# esperar healthy, luego:
export DATABASE_URL="postgresql://piensa:piensa@127.0.0.1:5433/piensa_dev?schema=public"
npx prisma migrate deploy
```

Expected: todas las migraciones aplican, **incluida la de super_admin**. Si falla por `ALTER TYPE ... ADD VALUE` en transacción, aplicar la corrección de la nota de Task 1 Step 5 (separar en dos migraciones) y reintentar.

- [ ] **Step 2: Suite completa con BD**

Run: `export DATABASE_URL="postgresql://piensa:piensa@127.0.0.1:5433/piensa_dev?schema=public"; npx vitest run`
Expected: todo verde, incluidas las integraciones de admins (ya no auto-saltadas) y el round-trip de migración (que ahora incluye super_admin/UserStatus).

- [ ] **Step 3: Lint, typecheck, build**

Run: `npm run lint && npm run typecheck && npm run build`
Expected: sin errores. (El `Record<ErrorCode, …>` obliga a que `ACCOUNT_SUSPENDED` esté en ambos mapas.)

- [ ] **Step 4: Limpiar el contenedor de verificación**

Run: `docker rm -f piensa-pg-verify`

- [ ] **Step 5: PR (GitHub Flow)**

`git push -u origin feat/issue-35-super-admin` y abrir el PR hacia `main`. Entregar el link y parar; el CI lo verifica el usuario. Sin footer de atribución.

---

## Self-Review (autor del plan)

**Cobertura de criterios (Issues.MD ISSUE-35):**
- super_admin pasa cualquier `requireRole('admin')`; admin en `/admin/users` → FORBIDDEN → Task 3 (jerarquía) + Task 4 Step 5 (matriz). ✔
- Crear por API siempre produce rol `admin` → `createUser` fija `role: "admin"` (Task 4 Step 3) + test de integración (Step 6). ✔
- Suspender un admin corta el acceso en el siguiente request con token vigente; reactivar restaura → Task 3 Step 5/7 + integración Step 6. ✔
- Endpoint apuntando a un super_admin o parent → FORBIDDEN → `loadAdminTarget` (Task 4 Step 2) + tests. ✔
- DoD: validación JSON Schema por ruta (schemas con `EMAIL_PATTERN`/`UUID_PATTERN`), errores del catálogo, caso de rol en la matriz. ✔

**Placeholder scan:** sin TBD; todo el código está completo. Única pieza generada: el `migration.sql` (producto de `migrate diff`). ✔

**Consistencia de tipos:** `AdminUsersDeps` idéntico entre servicio, test y rutas; `UserStatus`/`UserRole` de `@prisma/client`; `setUserStatus(id, "suspended"|"active")`, `createUser` devuelve `AdminUserView`. Los endpoints usan `superAdmin = [authenticate, requireRole('super_admin')]`. ✔

**Riesgo señalado:** `ALTER TYPE ... ADD VALUE` fuera de transacción (Task 1 Step 5 nota); se verifica al aplicar en Task 5 Step 1.
