# Endpoints del padre (ISSUE-30) — Plan

> **Para workers agénticos:** SUB-SKILL REQUERIDA: superpowers:executing-plans.

**Goal:** `GET /family/students` (hijos con resumen compacto) y `GET /family/students/:id/progress` (avance por semana, maestría, racha, últimos intentos), con pertenencia verificada.

**Architecture:** Ruta `parentRoutes` en `src/modules/progress/parent-routes.ts`. Rol `parent`; el detalle usa `requireStudentOwnership` (ISSUE-09). Solo lectura, queries agregadas (sin N+1). Ramifica desde `main`.

**Tech Stack:** Fastify, Prisma, TypeScript, Vitest.

## Global Constraints

- `import` con `.js`; `import type`; respuestas `{ data }`; errores `AppError`.
- Pertenencia SIEMPRE contra la BD (no claims del token).
- Tests con BD auto-saltan; `prettier`/`eslint` limpios; sin footer.

### Decisiones aprobadas
- **1.** `GET /family/students`: hijos del padre (familia por `parentUserId`); `GET /family/students/:id/progress`: `requireStudentOwnership` → ajeno → FORBIDDEN. Rol `parent`.
- **2.** Lista compacta por hijo: `{ id, name, avatar, grade, xp:{total,level}, streak:{current,longest}, badgesEarned }`; queries agregadas (groupBy XP/awards, findMany streaks).
- **3.** Detalle: `{ student, streak, progress, mastery, recentAttempts }`.
- **4.** `progress` = por curso → semanas `{ number, title, completed, total }` (opción compacta A).
- **5.** `recentAttempts` = últimos 10 `QuizAttempt` `{ lessonId, score, maxScore, passed, createdAt }` (`passed` con `PASS_THRESHOLD` reutilizado de quiz-routes; sin revelar respuestas).

---

### Task 1: Rutas del padre + registro + integración
**Files:** `src/modules/progress/parent-routes.ts`, `src/app.ts`, test `tests/progress/parent-routes.test.ts`

Casos:
- Padre ve exactamente a sus hijos (lista compacta con campos correctos).
- Detalle de un hijo: progreso por semana (completed/total), maestría, racha, últimos intentos con `passed`.
- Hijo ajeno → 403 FORBIDDEN.

- [ ] Tests → fallar → implementar rutas + registrar → pasar (con BD).
- [ ] Commit `feat(parent): GET /family/students y /:id/progress con pertenencia (ISSUE-30)`.

### Task 2: Verificación + PR
- [ ] Suite completa con BD verde; `build`/`typecheck`/`lint` limpios; limpiar contenedor; plan; push; PR a main.

## Self-Review

- Spec: padre ve exactamente a sus hijos, ajeno → FORBIDDEN (T1) ✓; avance por semana + maestría + racha + últimos intentos (T1) ✓.
- **Cierra Milestone 3.**
