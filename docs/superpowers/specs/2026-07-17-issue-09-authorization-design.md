# ISSUE-09 — Autorización por rol y pertenencia

**Spec de referencia:** §6 · **Depende de:** ISSUE-06, ISSUE-08 · **Fecha:** 2026-07-17

## Objetivo

Primitivas reutilizables de autorización para las rutas de la API: verificación
de rol (`admin` | `parent` | `student`) y de **pertenencia** (padre → sus hijos,
alumno → su propio perfil) **consultando la BD**, nunca confiando solo en los
claims del token. Este issue no agrega endpoints de negocio nuevos: entrega las
primitivas, refactoriza el único endpoint protegido existente para usarlas y deja
una suite de matriz rol×endpoint que los issues posteriores extienden.

## Criterios de aceptación (del backlog)

1. Token de alumno llamando un endpoint de padre → `FORBIDDEN`.
2. Padre pidiendo el progreso de un hijo ajeno → `FORBIDDEN` aunque el ID exista.
3. Suite de tests de matriz rol×endpoint que los issues posteriores extienden.

## Componentes

### 1. `src/modules/auth/authorize.ts` (nuevo)

Factory `createAuthorization(deps: { jwtSecret: string; prisma: PrismaClient })`
que devuelve tres `preHandler` de Fastify. Sigue el estilo de inyección de
dependencias del resto del módulo (los servicios reciben sus deps; las rutas
cablean Prisma).

- **`authenticate`**
  - Lee el header `Authorization`; exige el esquema `Bearer <token>`.
  - Verifica el JWT con `verifyAccessToken(jwtSecret, token)`.
  - Deja `request.authPrincipal = claims` (`AccessTokenClaims`).
  - Falta de token o token inválido/expirado → `AppError("UNAUTHORIZED")` (401).
  - No inspecciona el rol (separa autenticación de autorización).

- **`requireRole(...roles: TokenRole[])`**
  - Devuelve un `preHandler` que exige `request.authPrincipal` presente
    (defensivo: `authenticate` debe correr antes) y que su `role` esté en `roles`.
  - Rol fuera de la lista → `AppError("FORBIDDEN")` (403).
  - No consulta la BD.

- **`requireStudentOwnership({ from: "params" | "body"; key: string })`**
  - Obtiene el `studentProfileId` pedido de `request.params`/`request.body`.
  - Pertenencia **contra BD** (decisión: resolver todo desde la BD, no del token):
    - **padre**: carga el perfil por id; resuelve la familia del padre con
      `familyIdOf(principal.userId)` (BD); si el perfil no existe o
      `perfil.familyId` ≠ familia del padre → `FORBIDDEN`.
    - **alumno**: carga el perfil por id; si no existe o `perfil.id` ≠
      `principal.studentProfileId` → `FORBIDDEN`.
    - **admin**: pasa (gestiona todas las familias).
  - Perfil inexistente y perfil ajeno devuelven el **mismo** `FORBIDDEN` (no
    revela existencia).

**Tipado.** `request.authPrincipal` se declara vía *module augmentation* de
`FastifyRequest` en `authorize.ts`; su tipo es `AccessTokenClaims` (ya expone
`role`, `userId?`, `studentProfileId?`, `familyId?`).

### 2. Refactor de `src/modules/auth/routes.ts`

`POST /auth/student-session` pasa a
`preHandler: [authenticate, requireRole("parent")]`; el handler lee
`request.authPrincipal.userId` como `parentUserId`. Se elimina la función inline
`requireParent` (ISSUE-08 la dejó explícitamente para este issue). El contrato
observable no cambia: sin token / token inválido → 401; rol no-padre → 403.

La verificación de pertenencia del PIN permanece dentro de `createStudentSession`
(el servicio necesita el perfil de todos modos para verificar el PIN), así que a
este endpoint **no** se le aplica `requireStudentOwnership`.

## Estrategia de pruebas

### `tests/auth/authorization-matrix.test.ts` (sin BD)

Monta un plugin-fixture con rutas mínimas protegidas solo por rol
(`/__test/admin-only`, `/__test/parent-only`, `/__test/student-only`) sobre una
instancia Fastify con `conventionsPlugin` (para el envelope de error). Los
fixtures viven **solo en los tests**, nunca en la app de producción.

Matriz `{ admin, parent, student, sin-token, token-inválido } × endpoint` con las
expectativas de estado (200 / 401 / 403). Helper `expectMatrix(role, path,
status)` que los issues posteriores amplían agregando filas/columnas. Cubre el
criterio 1 (token de alumno en endpoint de padre → 403). Los tokens se acuñan con
`createAccessToken`; no toca la BD, corre en cualquier entorno.

### `tests/auth/authorization-ownership.integration.test.ts` (con BD, auto-salta)

Igual patrón que el resto de integraciones: sin `DATABASE_URL` se auto-salta
(evidencia real en CI). Siembra dos familias con un perfil de alumno cada una y
monta un fixture `GET /__test/students/:id` protegido por
`[authenticate, requireRole("parent","student"), requireStudentOwnership({ from:
"params", key: "id" })]`.

- Padre → hijo propio → 200; padre → hijo de otra familia → 403 (aunque el ID
  exista) → cubre el criterio 2.
- Alumno → su propio perfil → 200; alumno → otro perfil → 403.

## Fuera de alcance (YAGNI)

- Endpoints reales de admin / progreso / familia (issues posteriores; extenderán
  la matriz).
- Suspensión de familia efectiva de inmediato (ISSUE-10).
- Rate limiting (ISSUE-11).
