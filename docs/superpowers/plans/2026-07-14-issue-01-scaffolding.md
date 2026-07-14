# ISSUE-01 Scaffolding del Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Montar el esqueleto ejecutable del backend Piensa con un endpoint `GET /api/v1/health` probado por integración, estructura modular, Prisma inicializado y tooling (TS estricto, Vitest, ESLint, Prettier).

**Architecture:** Fastify 5 sobre ESM + TypeScript estricto. Una fábrica `buildApp()` construye la instancia Fastify (sin escuchar) para que los tests la ejerciten con `app.inject()` sin abrir puertos ni tocar la red. `server.ts` es el único punto que llama `listen()`. Prisma se inicializa apuntando a PostgreSQL pero **no se conecta** en este issue (el health check no toca BD), lo que mantiene los tests sin dependencia de un Postgres corriendo.

**Tech Stack:** Node 24 (LTS) · TypeScript 5 (ESM, NodeNext) · Fastify 5 · Prisma 6 (solo init) · Vitest 3 · ESLint 9 (flat config) · Prettier 3 · npm.

## Global Constraints

- **Runtime:** Node ≥ 24; `.nvmrc` = `24`; `engines.node` = `">=24"`. (Máquina de desarrollo puede correr Node 26, compatible hacia atrás.)
- **Módulos:** ESM en todo el repo — `package.json` `"type": "module"`; imports relativos con extensión `.js` (requisito de `moduleResolution: NodeNext`).
- **TypeScript:** `strict: true` + `noUncheckedIndexedAccess` + `noImplicitOverride`. Nada de `any` implícito.
- **Prefijo de API:** todas las rutas bajo `/api/v1`.
- **Envelope de respuesta:** éxito `{ data }`; error `{ error: { code, message } }`. En ISSUE-01 el health devuelve `{ data }` a mano; el plugin formal de convenciones/errores es **ISSUE-03**.
- **Fuera de alcance de ISSUE-01 (van en issues posteriores):** validación de variables de entorno al arranque y Docker (ISSUE-02) · plugin de errores/request-id (ISSUE-03) · CI (ISSUE-04) · modelos Prisma y migraciones (ISSUE-05+).
- **TDD y commits:** cada tarea empieza por el test que falla; commits descriptivos por tarea; nada se cierra sin tests en verde.

**Criterios de aceptación del issue (del backlog):**
1. `npm run dev` levanta el servidor y `GET /api/v1/health` responde `{ data: { status: "ok" } }`.
2. `npm test` corre un test de integración del health check contra la app real.
3. La estructura de módulos existe con un README de una línea por módulo indicando su responsabilidad.

---

### Task 1: Bootstrap del proyecto + endpoint de health

Monta `package.json`, TypeScript, Vitest y la app Fastify mínima con el endpoint de health probado por integración. Esta tarea deja `npm test` y `npm run dev` funcionando.

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `.nvmrc`
- Create: `.gitignore`
- Create: `src/app.ts`
- Create: `src/routes/health.ts`
- Create: `src/server.ts`
- Test: `tests/health.test.ts`

**Interfaces:**
- Produces:
  - `buildApp(opts?: { logger?: boolean }): FastifyInstance` en `src/app.ts` — construye la instancia Fastify con las rutas registradas bajo `/api/v1`, sin llamar `listen()`.
  - `healthRoutes(app: FastifyInstance): Promise<void>` en `src/routes/health.ts` — plugin de ruta que registra `GET /health`.

- [ ] **Step 1: Inicializar package.json**

Crear `package.json` con el contenido exacto:

```json
{
  "name": "piensa-backend",
  "version": "0.1.0",
  "description": "API REST de Piensa Homeschool",
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json",
    "lint": "eslint . && prettier --check .",
    "format": "prettier --write ."
  },
  "license": "SEE LICENSE IN LICENSE.md"
}
```

- [ ] **Step 2: Instalar dependencias**

Run:
```bash
npm install fastify@^5
npm install -D typescript@^5 tsx@^4 vitest@^3 @types/node@^24
```
Expected: se crea `node_modules/` y `package-lock.json`; sin errores de `engines`.

- [ ] **Step 3: Configurar TypeScript**

Crear `tsconfig.json` (base + typecheck, no emite):

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "noEmit": true
  },
  "include": ["src", "tests", "vitest.config.ts"]
}
```

Crear `tsconfig.build.json` (emite `dist/` solo desde `src`):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "noEmit": false
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Configurar Vitest**

Crear `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Crear .nvmrc y .gitignore**

Crear `.nvmrc`:

```
24
```

Crear `.gitignore`:

```
node_modules/
dist/
coverage/
.env
*.log
```

- [ ] **Step 6: Escribir el test de integración que falla**

Crear `tests/health.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

test("GET /api/v1/health devuelve el envelope { data: { status: 'ok' } }", async () => {
  const response = await app.inject({ method: "GET", url: "/api/v1/health" });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ data: { status: "ok" } });
});
```

- [ ] **Step 7: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — no resuelve el import `../src/app.js` (el archivo aún no existe).

- [ ] **Step 8: Implementar la ruta de health**

Crear `src/routes/health.ts`:

```ts
import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    return { data: { status: "ok" } };
  });
}
```

- [ ] **Step 9: Implementar la fábrica de la app**

Crear `src/app.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import { healthRoutes } from "./routes/health.js";

export function buildApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.register(healthRoutes, { prefix: "/api/v1" });

  return app;
}
```

- [ ] **Step 10: Correr el test para verificar que pasa**

Run: `npm test`
Expected: PASS — 1 test verde.

- [ ] **Step 11: Crear el punto de entrada del servidor**

Crear `src/server.ts`:

```ts
import { buildApp } from "./app.js";

const app = buildApp({ logger: true });
const port = Number(process.env.PORT ?? 3000);

app
  .listen({ port, host: "0.0.0.0" })
  .then((address) => {
    app.log.info(`Piensa backend escuchando en ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
```

- [ ] **Step 12: Verificar `npm run dev` manualmente**

Run: `npm run dev` (en una terminal), luego en otra: `curl -s http://localhost:3000/api/v1/health`
Expected: `{"data":{"status":"ok"}}`. Detener con Ctrl-C.

- [ ] **Step 13: Verificar el build**

Run: `npm run build`
Expected: se genera `dist/server.js` y `dist/app.js` sin errores de tipos.

- [ ] **Step 14: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json vitest.config.ts .nvmrc .gitignore src tests
git commit -m "feat: scaffold Fastify app with health endpoint and integration test (ISSUE-01)"
```

---

### Task 2: Estructura modular con READMEs

Crea la estructura `src/modules/*` y `src/plugins/`, cada módulo con un README de una línea, y un test de arquitectura que verifica que existen (criterio de aceptación 3).

**Files:**
- Create: `src/modules/auth/README.md`
- Create: `src/modules/families/README.md`
- Create: `src/modules/catalog/README.md`
- Create: `src/modules/progress/README.md`
- Create: `src/modules/gamification/README.md`
- Create: `src/modules/admin/README.md`
- Create: `src/plugins/README.md`
- Test: `tests/structure.test.ts`

**Interfaces:**
- Consumes: nada (solo estructura de directorios).
- Produces: los directorios de módulos que los issues posteriores llenarán con sus rutas/servicios.

- [ ] **Step 1: Escribir el test de estructura que falla**

Crear `tests/structure.test.ts`:

```ts
import { existsSync } from "node:fs";
import { expect, test } from "vitest";

const modules = [
  "auth",
  "families",
  "catalog",
  "progress",
  "gamification",
  "admin",
];

test.each(modules)("el módulo '%s' tiene un README", (name) => {
  expect(existsSync(`src/modules/${name}/README.md`)).toBe(true);
});

test("existe el directorio de plugins con README", () => {
  expect(existsSync("src/plugins/README.md")).toBe(true);
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test -- tests/structure.test.ts`
Expected: FAIL — los READMEs no existen todavía.

- [ ] **Step 3: Crear los READMEs de cada módulo**

Crear `src/modules/auth/README.md`:

```md
# auth — Autenticación y sesiones (login padre/admin, sesión de alumno por PIN, JWT access + refresh rotativo).
```

Crear `src/modules/families/README.md`:

```md
# families — Familias y perfiles de alumnos: estado active/suspended y verificación de pertenencia.
```

Crear `src/modules/catalog/README.md`:

```md
# catalog — Catálogo de contenido: grados, semanas, lecciones, preguntas extensibles y topics.
```

Crear `src/modules/progress/README.md`:

```md
# progress — Progreso del alumno: camino, lecciones completadas e intentos de quiz.
```

Crear `src/modules/gamification/README.md`:

```md
# gamification — XP y niveles, rachas, insignias y maestría por topic (libro de eventos).
```

Crear `src/modules/admin/README.md`:

```md
# admin — Panel admin: CRUD de catálogo, gestión de familias, uploads a R2 y overview.
```

Crear `src/plugins/README.md`:

```md
# plugins — Plugins transversales de Fastify (convenciones de API, errores, auth). Se llenan desde ISSUE-03.
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npm test -- tests/structure.test.ts`
Expected: PASS — 7 tests verdes.

- [ ] **Step 5: Commit**

```bash
git add src/modules src/plugins tests/structure.test.ts
git commit -m "feat: add modular directory structure with per-module READMEs (ISSUE-01)"
```

---

### Task 3: Inicializar Prisma apuntando a PostgreSQL

Inicializa Prisma con datasource PostgreSQL y generador, **sin modelos** (los modelos llegan en ISSUE-05). Verifica con `prisma validate`, que no requiere una BD corriendo.

**Files:**
- Create: `prisma/schema.prisma`
- Modify: `package.json` (agregar dependencias Prisma)
- Modify: `.gitignore` (ignorar cliente generado si aplica)

**Interfaces:**
- Consumes: `package.json` de Task 1.
- Produces: `prisma/schema.prisma` con datasource `db` (postgresql) — base para las migraciones de ISSUE-05.

- [ ] **Step 1: Instalar Prisma**

Run:
```bash
npm install @prisma/client@^6
npm install -D prisma@^6
```
Expected: dependencias agregadas sin errores.

- [ ] **Step 2: Crear el schema de Prisma (sin modelos)**

Crear `prisma/schema.prisma`:

```prisma
// Modelo de datos de Piensa. Los modelos concretos se agregan desde ISSUE-05.
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

- [ ] **Step 3: Validar el schema**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀` (no requiere conexión a la BD).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma package.json package-lock.json
git commit -m "feat: initialize Prisma with PostgreSQL datasource, no models yet (ISSUE-01)"
```

---

### Task 4: ESLint, Prettier y typecheck en verde

Configura linting y formato con flat config de ESLint 9 + typescript-eslint y Prettier, y verifica que `npm run lint` y `npm run typecheck` corren limpios sobre el código existente.

**Files:**
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Modify: `package.json` (dependencias de lint)

**Interfaces:**
- Consumes: todo el código de Tasks 1–3.
- Produces: los scripts `lint` y `typecheck` verificados; base de estilo para issues posteriores.

- [ ] **Step 1: Instalar herramientas de lint/format**

Run:
```bash
npm install -D eslint@^9 @eslint/js@^9 typescript-eslint@^8 prettier@^3
```
Expected: dependencias agregadas sin errores.

- [ ] **Step 2: Crear la config de ESLint (flat, ESM)**

Crear `eslint.config.js`:

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```

- [ ] **Step 3: Crear la config de Prettier**

Crear `.prettierrc.json`:

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all"
}
```

Crear `.prettierignore` (se ignora markdown y `docs/` para no reformatear la documentación en español ya escrita):

```
dist
node_modules
coverage
package-lock.json
*.md
docs
```

- [ ] **Step 4: Aplicar formato a todo el repo**

Run: `npm run format`
Expected: Prettier reformatea los archivos existentes sin errores.

- [ ] **Step 5: Correr lint y verificar que pasa limpio**

Run: `npm run lint`
Expected: sin errores ni warnings de ESLint ni de Prettier.

- [ ] **Step 6: Correr typecheck y verificar que pasa**

Run: `npm run typecheck`
Expected: sin errores de tipos.

- [ ] **Step 7: Correr toda la suite de tests**

Run: `npm test`
Expected: PASS — todos los tests (health + estructura) en verde.

- [ ] **Step 8: Commit**

```bash
git add eslint.config.js .prettierrc.json .prettierignore package.json package-lock.json src tests
git commit -m "feat: add ESLint flat config, Prettier and typecheck script (ISSUE-01)"
```

---

## Cierre del issue

Con las 4 tareas completas se cumplen los tres criterios de aceptación:
1. `npm run dev` + `curl /api/v1/health` → `{ data: { status: "ok" } }` (Task 1).
2. `npm test` corre el test de integración del health contra la app real vía `inject()` (Task 1).
3. Estructura modular con README por módulo, verificada por test (Task 2).

Definition of Done pendiente que se cierra al abrir el PR: commits descriptivos (hechos por tarea) y CI en verde — **CI se implementa en ISSUE-04**, así que para este PR la verificación es local (`npm run lint && npm run typecheck && npm test` en verde). Al terminar, abrir el Pull Request de `feat/issue-01-scaffolding`.
