# Camino del alumno (ISSUE-20) — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: superpowers:executing-plans. Pasos con checkbox (`- [ ]`).

**Goal:** `GET /me/path` devuelve, agrupado por curso del grado asignado (materias inscritas), las semanas y lecciones con estado `locked|available|completed`.

**Architecture:** Función pura `computeLessonStatuses` (desbloqueo) en `src/modules/progress/path.ts`; ruta `pathRoutes` en `src/modules/progress/path-routes.ts` que hace ≤3 queries y arma el payload. Registrada en `app.ts`.

**Tech Stack:** Fastify, Prisma, TypeScript (NodeNext), Vitest.

## Global Constraints

- `import` con `.js`; `import type` para tipos.
- Respuestas envueltas en `{ data }`; errores via `AppError`.
- Rutas de alumno: `authenticate + requireRole("student")`; el `studentProfileId` sale del token.
- Tests con BD auto-saltan; `prettier`/`eslint` limpios antes de cada commit; sin footer.

### Decisiones aprobadas
- **1.** Camino = cursos del `gradeId` asignado ∩ materias inscritas, agrupado por curso. Sin curso en el grado → se omite; sin `gradeId` → `NOT_FOUND` accionable.
- **2.** Desbloqueo por curso: semana 1 abierta; semana N+1 al completar la N; dentro de una semana abierta, lecciones en orden. Nuevo → solo lección 1 de semana 1 `available`.
- **3.** ≤3 queries (alumno; cursos con weeks→lessons anidados; lessonIds completados); cómputo en memoria.
- **4.** Payload: `{ data: { grade, courses: [{ id, subject, title, weeks: [{ number, title, lessons: [{ id, order, type, status }] }] }] } }`.
- **5.** `GET /api/v1/me/path` en `progress/path-routes.ts`.

---

### Task 1: `computeLessonStatuses` puro + tests

**Files:**
- Create: `src/modules/progress/path.ts`
- Test: `tests/progress/path-unlock.test.ts`

**Interfaces:**
- Produces:
  - `type LessonStatus = "locked" | "available" | "completed"`
  - `computeLessonStatuses(weeks: { lessons: { id: string }[] }[], completed: ReadonlySet<string>): Map<string, LessonStatus>`

Casos: alumno nuevo → solo lección 1 de semana 1 `available`; completar en orden desbloquea la siguiente; semana N+1 bloqueada hasta completar la N; semana vacía no bloquea la siguiente.

- [ ] **Step 1: Tests.** **Step 2: fallar.** **Step 3: implementar.** **Step 4: pasar.** **Step 5: commit** `feat(path): desbloqueo de lecciones por curso (ISSUE-20)`.

---

### Task 2: Ruta `GET /me/path` + registro + integración

**Files:**
- Create: `src/modules/progress/path-routes.ts`
- Modify: `src/app.ts` (import + register)
- Test: `tests/progress/path-routes.test.ts` (BD, auto-salta; usa `buildApp` + token de alumno)

**Interfaces:**
- Produces: `pathRoutes: FastifyPluginAsync<{ prisma: PrismaClient; jwtSecret: string }>` → `GET /me/path`.

Casos: alumno con grado y 1 curso (2 semanas) → estructura correcta, solo 1ª lección `available`; completar lecciones va abriendo; agrupa por curso (2 materias → 2 cursos); sin grado → 404 `NOT_FOUND`.

- [ ] **Step 1: Tests.** **Step 2: fallar.** **Step 3: implementar ruta + registrar.** **Step 4: pasar (con BD).** **Step 5: commit** `feat(path): endpoint GET /me/path agrupado por curso (ISSUE-20)`.

---

### Task 3: Verificación + PR

- [ ] Suite completa con BD verde; `build`/`typecheck`/`lint` limpios.
- [ ] Limpiar contenedor; commit del plan; push; PR a main (sin footer; entregar link y parar).

## Self-Review

- Spec: nuevo → solo 1ª lección available (T1/T2) ✓; desbloqueo progresivo (T1/T2) ✓; sin grado → NOT_FOUND (T2) ✓; sin N+1 (≤3 queries, T2) ✓; agrupado por curso (T2) ✓.
- Sin placeholders; firmas consistentes (`computeLessonStatuses`, `pathRoutes`, `LessonStatus`).
