# Completar video/lectura (ISSUE-22) — Plan

> **Para workers agénticos:** SUB-SKILL REQUERIDA: superpowers:executing-plans.

**Goal:** `POST /lessons/:id/complete` (alumno) registra progreso, otorga XP (+10, una sola vez por lección), actualiza racha y evalúa insignias, atómicamente.

**Architecture:** Endpoint en `progress/lesson-routes.ts`. La mutación va en `prisma.$transaction`; los servicios `xp`/`streak`/`badges` se ensanchan para aceptar `Prisma.TransactionClient`. Reusa el gate de acceso+desbloqueo de ISSUE-21.

**Tech Stack:** Fastify, Prisma, TypeScript, Vitest.

## Global Constraints

- `import` con `.js`; `import type`; respuestas `{ data }`; errores `AppError`.
- Rutas de alumno: `authenticate + requireRole("student")`; `studentProfileId` del token.
- Tests con BD auto-saltan; `prettier`/`eslint` limpios antes de cada commit; sin footer.

### Decisiones aprobadas
- **1.** Atomicidad vía `$transaction`; ensanchar firmas de servicios a `Prisma.TransactionClient` (PrismaClient es asignable → no rompe llamadas existentes).
- **2.** XP por lección **una sola vez** (idempotente por `(reason, refId)`); racha e insignias en **cada** completada — repasar cuenta como actividad de hoy (ver memoria gamification-review-counts). Recompletar → `xpEarned: 0`.
- **3.** Errores: inexistente → NOT_FOUND; fuera del path → FORBIDDEN; **quiz → VALIDATION_ERROR**; bloqueada → FORBIDDEN.
- **4.** Respuesta `{ data: { xpEarned, totalXp, level, streak: {current,longest}, newBadges: [{code,name,description}] } }`; `XP_PER_LESSON=10`.
- **5.** Mismo archivo `lesson-routes.ts`; helpers `inPath`/`lessonStatus` compartidos con el GET.

### Nota de implementación (Postgres + transacción)
Atrapar un P2002 **dentro** de una transacción interactiva de Postgres la deja **abortada**. Por eso: `LessonProgress` se resuelve con `upsert` (no create-catch), y `append` de XP hace un `findUnique` de corto-circuito antes de intentar `create` (en la repetición no hay INSERT → no aborta). `badges.evaluate` y `streak.recordActivity` ya evitan el INSERT conflictivo en el camino secuencial.

---

### Task 1: Ensanchar servicios a `Prisma.TransactionClient` + `append` tx-safe

**Files:** `src/modules/gamification/{xp,streak,badges}.ts`

- [ ] Cambiar `db: PrismaClient` → `db: Prisma.TransactionClient` (imports incluidos).
- [ ] `append`: `findUnique` de corto-circuito antes del `create`.
- [ ] `typecheck` limpio; tests de servicios existentes siguen verdes.
- [ ] Commit `refactor(gamification): servicios aceptan TransactionClient; append tx-safe (ISSUE-22)`.

### Task 2: Endpoint `POST /lessons/:id/complete` + integración

**Files:** `src/modules/progress/lesson-routes.ts`, test `tests/progress/complete-routes.test.ts`

Casos: 1ª completada → +10 XP, nivel 1, racha 1, insignia first-lesson; 2ª (repaso) → xpEarned 0, sin nuevo XPEvent, misma respuesta; quiz → 400; bloqueada → 403; fuera del path → 403.

- [ ] Tests → fallar → implementar → pasar (con BD).
- [ ] Commit `feat(complete): POST /lessons/:id/complete con XP/racha/insignias en transacción (ISSUE-22)`.

### Task 3: Verificación + PR

- [ ] Suite completa con BD verde; `build`/`typecheck`/`lint` limpios; limpiar contenedor; plan; push; PR.

## Self-Review

- Spec: 2ª llamada xpEarned:0 sin nuevo XPEvent (T2) ✓; quiz → VALIDATION_ERROR (T2) ✓; atomicidad (T2) ✓; repaso cuenta para racha (política de producto) ✓.
