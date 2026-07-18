# Milestone 2 — Catálogo y panel admin (API) — Arquitectura

**Spec fuente de verdad:** `docs/specs/2026-07-14-piensa-backend-design.md` (§4 Catálogo, §5 Admin, §3 uploads)
**Issues:** ISSUE-12 … ISSUE-18 + **ISSUE-35 (nuevo, rol super_admin)** (`Issues.MD`)
**Estado:** doc de arquitectura del milestone, **aprobado decisión por decisión**. Los planes de implementación bite-sized se generan **just-in-time**, uno por issue, justo antes de implementarlo.

Este documento fija las **decisiones transversales**, la **secuencia** y los **contratos entre issues** de Milestone 2. Cada issue sigue teniendo su propio plan detallado (`docs/superpowers/plans/`) y su ciclo TDD.

---

## 1. Alcance y secuencia

```
12 ──→ 35 ──────→ 13 ──→ 14 ──→ 15 ──→ 16 ──→ 17 ──→ 18
datos  super_admin grades  lecciones preg.  topics uploads familias
       (auth+mgmt) weeks   +reorder +registry +tag   R2      +overview
```

**Orden de construcción:** `12 → 35 → 13 → 14 → 15 → 16 → 17 → 18`.

- **ISSUE-35 va justo después de 12 y antes de 13** porque establece la jerarquía de roles (`super_admin ⊇ admin`) que todas las rutas admin de 13–18 necesitan desde el día uno. Al ser el primer issue con una ruta admin, también hace la extracción de `src/lib/validation.ts` (§2.2).
- ISSUE-17 y ISSUE-18 son independientes de la cadena del catálogo; van al final para no cambiar de contexto en medio.

**Estado de planes:**
- ISSUE-12 → plan escrito: `docs/superpowers/plans/2026-07-17-issue-12-catalog-data-model.md`
- ISSUE-35, 13 … 18 → se generan just-in-time.

---

## 2. Decisiones transversales (aprobadas)

### 2.1 Ruteo admin: prefijo `/api/v1/admin`, rutas colocadas por dominio

El prefijo de URL **no** implica un módulo monolítico "admin". Cada CRUD vive en su módulo de dominio y se monta bajo `/admin`:

| Rutas | Módulo | Issue | Rol requerido |
|---|---|---|---|
| `/admin/users` (crear/listar/suspender/reactivar/borrar admins) | `src/modules/admin/` | 35 | **super_admin** |
| `/admin/grades`, `/admin/weeks` | `src/modules/catalog/` | 13 | admin |
| `/admin/lessons` (+ `/reorder`) | `src/modules/catalog/` | 14 | admin |
| `/admin/questions` | `src/modules/catalog/` | 15 | admin |
| `/admin/topics` (+ etiquetado) | `src/modules/catalog/` | 16 | admin |
| `/admin/uploads` | `src/modules/admin/` | 17 | admin |
| `/admin/families` (+ suspend/reactivate), `/admin/overview` | `src/modules/families/` / `src/modules/admin/` | 18 | admin |

Todas se protegen con `authenticate` + `requireRole(...)`, las primitivas de `src/modules/auth/authorize.ts` (ISSUE-09). Un `super_admin` satisface cualquier `requireRole('admin')` por jerarquía (§2.8). `app.ts` registra cada plugin con `{ prefix: "/admin" }` dentro del prefijo global `/api/v1`.

### 2.2 Validación de entrada: helpers compartidos en `src/lib/validation.ts` (opción más segura)

`ajv` corre con `coerceTypes: true` → `type: "string"`/`"number"` **coacciona** en vez de rechazar. Milestone 1 lo resolvió con `pattern`/límites, pero hardcodeados en `auth/routes.ts`.

**Decisión (la más segura):** extraer los patterns (`UUID_PATTERN`, `EMAIL_PATTERN`, `PIN_PATTERN`, …) a `src/lib/validation.ts` como **fuente única**, con su propio test de casos maliciosos, y refactorizar `auth/routes.ts` para importarlos. Motivo de seguridad: elimina el *drift* por copy-paste (la clase de bug donde un módulo valida más flojo que otro); endurecer un pattern se hace en un solo lugar y cubre a todos. Este refactor es el **primer paso del plan de ISSUE-35** (primer issue con ruta admin). Todo el catálogo/admin valida IDs con `UUID_PATTERN`, enums con `enum`, y todo objeto con `additionalProperties: false`.

### 2.3 Rechazo de borrado con contenido → `CONFLICT` (409)

Las FKs `onDelete: Restrict` (ISSUE-12) bloquean en la DB borrar un grado/semana/lección/topic con contenido/uso (`P2003`). El servicio lo traduce a un error de dominio explícito con un **código nuevo `CONFLICT` (409)** en el catálogo `ErrorCode` — semánticamente correcto ("no se puede borrar por el estado actual"), distinguible por el cliente de un 400 de input. Helper compartido `mapDeleteRestrict(err, message)`: detecta `P2003` y relanza `AppError('CONFLICT', mensaje)`; cualquier otro error se propaga. Mensaje genérico, sin filtrar internals. Reutilizado por ISSUE-13 (grades/weeks) y ISSUE-16 (topics en uso).

### 2.4 R2 / uploads (ISSUE-17): presigned PUT restrictivo + lectura privada firmada

Todas las variantes elegidas son la opción **más segura**:
- **El archivo nunca toca el VPS** — presigned PUT directo a R2 (S3 API).
- **La URL firmada restringe, no solo autoriza** — se firma fijando `Content-Type` y un rango máximo de `Content-Length`, así el cliente no puede subir otro tipo ni un archivo gigante con esa URL.
- **Allowlist de tipos** (`pdf, png, jpg, webp`) + tamaño máximo; `fileKey` con prefijo por tipo; expiración corta.
- **Lectura privada + URL firmada temporal** (no bucket público): el contenido no queda world-readable; los links filtrados se vencen solos. Público queda como opción de config, pero el **default es privado/firmado**.
- **Adapter inyectable** (`src/lib/r2.ts`) para mockear en tests (nunca se pega a R2 real en CI).
- Env agregadas a `src/config/env.ts`, **opcionales** (no rompen `dev`/`test` sin R2): `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE_URL`.
- Dependencias nuevas: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.

### 2.5 Registro de tipos de pregunta (ISSUE-15): el punto de extensión

- `src/modules/catalog/question-types.ts`: `questionTypeRegistry` mapea `QuestionType → { contentSchema, answerSpecSchema }`. **v1 registra solo** `multiple_choice`, `true_false`, `fill_blank`, corregidos 100% en el servidor.
- El CRUD de preguntas valida `content` y `answerSpec` contra los schemas del tipo (toda la validación por un solo lugar, server-side). Reusa `assertLessonAcceptsQuestions` (ISSUE-12).
- **Agregar un tipo = registrar schemas + validador, cero migraciones** (probado con un tipo ficticio en ISSUE-15).
- **Seam para M3:** el motor de corrección (ISSUE-23) extiende este registro con un corrector `grade()` por tipo. Un tipo **"desarrollo" (respuesta abierta)** corregido por **similitud semántica con un modelo local** (no API externa, por privacidad de menores) ya está diseñado como extensión futura — ver `docs/superpowers/specs/2026-07-17-milestone-3-planning-notes.md`. **No se implementa en M2.**

### 2.6 Reordenamiento atómico (ISSUE-14): todo-o-nada

`POST /admin/lessons/reorder` recibe `{ weekId, orderedIds }`:
1. `orderedIds` debe ser **exactamente** el conjunto de lecciones de esa semana. ID de otra semana o set incompleto → `VALIDATION_ERROR`, **nada aplicado**.
2. Se aplica en **transacción** (todo-o-nada; la BD nunca queda en estado inconsistente). Por el `@@unique([weekId, order])`, se usa actualización en dos fases dentro de la transacción (mover a rango temporal → asignar orden final) para no chocar con el índice único. Reutilizable para reordenar preguntas.

### 2.7 Matriz de autorización: cada issue extiende la matriz central de ISSUE-09

`tests/auth/authorization-matrix.test.ts` (ISSUE-09) es la suite de matriz rol×endpoint. **Cada issue que agrega rutas admin agrega su caso** "no-admin (padre/alumno) → `FORBIDDEN`" a esa matriz. Para ISSUE-35 se agrega además "`admin` normal → `FORBIDDEN`" en los endpoints de gestión de admins (solo `super_admin`). Es parte de la Definition of Done de 35 y 13–18, no un test suelto. Cada ruta nueva obliga a declarar quién puede y quién no, con un test que falla si alguien afloja un permiso.

### 2.8 Rol `super_admin` (ISSUE-35 — nuevo)

Gestión de cuentas admin por un super administrador, estilo Moodle.

- **Modelo:** `super_admin` es un **valor nuevo del enum `UserRole`** (junto a `admin | parent`). `requireRole` implementa **jerarquía**: `super_admin` satisface cualquier chequeo de `admin` (las rutas admin se escriben `requireRole('admin')` a secas y el super admin pasa por diseño, sin poder olvidarse de habilitarlo). `TokenRole` incluye `super_admin`.
- **Bootstrap:** el **primer super_admin y cualquier otro se cargan manualmente a la BD**. **Ningún endpoint crea super_admins.** El endpoint de creación fija el rol a `admin` server-side, así que ni un super_admin puede fabricar otro super_admin por API.
- **Suspensión de admins:** se agrega `status` a `User` (enum `UserStatus { active, suspended }`). `authenticate` lee el status del principal admin/super_admin en **cada request** → un admin suspendido queda fuera de inmediato aunque su token siga vigente (mismo principio de ISSUE-10, a nivel User). Padres/alumnos siguen por `Family.status` (no se agregan queries a su camino).
- **Código de error nuevo:** `ACCOUNT_SUSPENDED` (403) en el catálogo `ErrorCode`, para el admin suspendido.
- **Endpoints (solo `super_admin`), solo apuntables a usuarios rol `admin`** (no a otros super_admin ni a padres → si el target no es `admin`, `FORBIDDEN`):
  - `POST /admin/users` — crear admin (rol fijo `admin`, contraseña temporal, como el flujo de familias de ISSUE-18).
  - `GET /admin/users` — listar admins (vista de gestión).
  - `POST /admin/users/:id/suspend` · `POST /admin/users/:id/reactivate`.
  - `DELETE /admin/users/:id` — hard-delete (un admin no es dueño de familias ni de contenido con FK hacia él; sus refresh tokens caen por cascade).

---

## 3. Contratos entre issues (qué produce cada uno)

- **ISSUE-12** → modelos Prisma del catálogo + `assertLessonAcceptsQuestions(lesson)`. *(plan escrito)*
- **ISSUE-35** → migración `super_admin` + `UserStatus`; jerarquía en `requireRole`; chequeo de `User.status` en `authenticate`; `ACCOUNT_SUSPENDED` en el catálogo; `src/lib/validation.ts` (patterns compartidos); `mapDeleteRestrict`; endpoints `/admin/users`. Consume: primitivas ISSUE-09, modelo User ISSUE-05.
- **ISSUE-13** → servicios+rutas CRUD `grades`/`weeks`; agrega `CONFLICT` al catálogo. Consume: modelos ISSUE-12, `validation.ts` y `mapDeleteRestrict` (35).
- **ISSUE-14** → CRUD `lessons` (payload por `type`) + `reorder` en dos fases. Consume: `weeks` (13).
- **ISSUE-15** → `questionTypeRegistry` + CRUD `questions` con validación por tipo. Consume: `lessons` (14), `assertLessonAcceptsQuestions` (12).
- **ISSUE-16** → CRUD `topics` + etiquetar/desetiquetar. Consume: modelos `LessonTopic`/`QuestionTopic` (12), `mapDeleteRestrict` → topic en uso → `CONFLICT`.
- **ISSUE-17** → `src/lib/r2.ts` + `/admin/uploads`. Consume: primitivas ISSUE-09, `validation.ts`.
- **ISSUE-18** → CRUD `families` (crear User padre + Family + StudentProfiles con PIN), `suspend`/`reactivate`, `GET /admin/overview` (**sin bloque de actividad**, §4). Consume: modelos ISSUE-05, suspensión ISSUE-10.

---

## 4. Desviación acordada del spec: `GET /admin/overview` (ISSUE-18)

**Problema:** el criterio pide "alumnos con actividad en los últimos 7 días", pero los datos de actividad (`LessonProgress`, `XPEvent`, `Streak`) nacen en **ISSUE-19 (Milestone 3, posterior)**. Es una dependencia cross-milestone que `Issues.MD` no encodeó.

**Decisión (acordada):** ISSUE-18 se construye **sin el bloque de actividad**. Entrega: `CRUD /admin/families`, `suspend`/`reactivate`, y `GET /admin/overview` con **familias activas/suspendidas y nº de alumnos**. La métrica "activos en los últimos 7 días" se agrega como **follow-up chico en Milestone 3**, una vez exista el progreso.

**Acción sobre el tablero:** ajustar el criterio de ISSUE-18 en `Issues.MD` y agregar la fila de ISSUE-35, más el follow-up de actividad en M3 (regla SDD 1). *Pendiente de aplicar.*

---

## 5. Definition of Done (heredada de `Issues.MD`, aplica a 35 y 13–18)

Cada issue con rutas nuevas cierra solo con: criterios demostrados por tests · validación JSON Schema por ruta (con `pattern`/límites anti-`coerceTypes`, desde `src/lib/validation.ts`) · errores `{ error: { code, message, requestId } }` con código estable del catálogo · sin filtrar detalles internos ni respuestas correctas al cliente · caso de rol negativo agregado a la matriz central · `lint`/`typecheck`/`build`/CI en verde · commits descriptivos · rama por issue → PR.
