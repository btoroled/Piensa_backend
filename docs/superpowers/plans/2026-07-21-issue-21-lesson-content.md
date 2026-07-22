# Contenido de lección sin respuestas (ISSUE-21) — Plan

> **Para workers agénticos:** SUB-SKILL REQUERIDA: superpowers:executing-plans. Pasos con checkbox (`- [ ]`).

**Goal:** `GET /lessons/:id` (alumno) devuelve el contenido de una lección desbloqueada según su tipo; para quiz, preguntas con `content` pero **jamás** `answerSpec`. Bloqueada → `FORBIDDEN`.

**Architecture:** Ruta `lessonRoutes` en `src/modules/progress/lesson-routes.ts`. Reusa `computeLessonStatuses` (ISSUE-20) para el gate de desbloqueo. `answerSpec` nunca entra en el `select` de Prisma (garantía a nivel de query).

**Tech Stack:** Fastify, Prisma, TypeScript (NodeNext), Vitest.

## Global Constraints

- `import` con `.js`; `import type` para tipos; respuestas `{ data }`; errores `AppError`.
- Rutas de alumno: `authenticate + requireRole("student")`; `studentProfileId` del token.
- Tests con BD auto-saltan; `prettier`/`eslint` limpios antes de cada commit; sin footer.

### Decisiones aprobadas
- **1.** Acceso: la lección debe estar en el path (grado asignado ∩ materia inscrita) → si no, `FORBIDDEN`; `locked` → `FORBIDDEN`; id inexistente → `NOT_FOUND`.
- **2.** `answerSpec` **no se selecciona** de la BD (fail-safe). Test: no aparece en ningún nivel del JSON.
- **3.** Contenido por tipo: `video`→`embedUrl`(+`fileKey`); `reading`→`richContent`(+`fileKey`); `quiz`→`questions:[{id,order,type,content,points}]`.
- **4.** `fileKey` crudo por ahora (lectura firmada = issue R2-read aparte).
- **5.** `GET /api/v1/lessons/:id` en `progress/lesson-routes.ts`.

---

### Task 1: Ruta `GET /lessons/:id` + registro + integración

**Files:**
- Create: `src/modules/progress/lesson-routes.ts`
- Modify: `src/app.ts`
- Test: `tests/progress/lesson-routes.test.ts` (BD, auto-salta)

**Interfaces:**
- Produces: `lessonRoutes: FastifyPluginAsync<{ prisma; jwtSecret }>` → `GET /lessons/:id`.

Casos:
- Lección `video` desbloqueada → 200 con `embedUrl`.
- Lección `quiz` desbloqueada → 200 con `questions` (content presente); `JSON.stringify(body)` **sin** `answerSpec` ni el valor secreto.
- Lección bloqueada → 403 `FORBIDDEN`.
- Lección de una materia no inscrita (fuera del path) → 403 `FORBIDDEN`.
- Id inexistente → 404 `NOT_FOUND`.

- [ ] **Step 1: Tests.** **Step 2: fallar.** **Step 3: implementar ruta + registrar.** **Step 4: pasar (con BD).** **Step 5: commit** `feat(lesson): GET /lessons/:id sin answerSpec, con gate de desbloqueo (ISSUE-21)`.

---

### Task 2: Verificación + PR

- [ ] Suite completa con BD verde; `build`/`typecheck`/`lint` limpios.
- [ ] Limpiar contenedor; commit del plan; push; PR a main (sin footer; entregar link y parar).

## Self-Review

- Spec: quiz sin `answerSpec` en ningún nivel (T1) ✓; bloqueada → FORBIDDEN (T1) ✓; contenido por tipo (T1) ✓.
- Sin placeholders; firmas consistentes (`lessonRoutes`, reuso de `computeLessonStatuses`).
