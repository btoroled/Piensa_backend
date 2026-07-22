# Resumen del alumno (ISSUE-29) — Plan

> **Para workers agénticos:** SUB-SKILL REQUERIDA: superpowers:executing-plans.

**Goal:** `GET /me/summary` devuelve XP+nivel+progreso, racha, insignias (ganadas y por ganar) y maestría por topic.

**Architecture:** Helper puro `levelProgress` en `progress/summary.ts`; ruta `summaryRoutes` en `progress/summary-routes.ts` con ≤5 queries paralelas. Solo lectura; ramifica desde `main` (independiente de la cola #22/#24).

**Tech Stack:** Fastify, Prisma, TypeScript, Vitest.

## Global Constraints

- `import` con `.js`; `import type`; respuestas `{ data }`.
- Ruta de alumno: `authenticate + requireRole("student")`; `studentProfileId` del token.
- Tests con BD auto-saltan; `prettier`/`eslint` limpios; sin footer.

### Decisiones aprobadas
- **1.** Payload: `{ xp: {total,level,intoLevel,forNextLevel}, streak: {current,longest}, badges: {earned,available}, mastery: [{topicId,topic,level}] }`.
- **2.** Progreso de nivel con la curva (`LEVEL_XP_STEP`), sin tocar `xp.ts`.
- **3.** Insignias: `earned` (con `awardedAt`) + `available` (catálogo no ganado).
- **4.** Maestría: solo topics con registro (los tocados), con nombre.
- **5.** ≤5 queries, sin N+1; `summary-routes.ts`.

---

### Task 1: `levelProgress` puro + tests
**Files:** `src/modules/progress/summary.ts`, test `tests/progress/summary-level.test.ts`
- [ ] `levelProgress(totalXp) → { level, intoLevel, forNextLevel }` usando `getLevel`+`LEVEL_XP_STEP`.
- [ ] Tests de límites (0, 50, 100, 150, 300).
- [ ] Commit `feat(summary): progreso de nivel dentro de la curva (ISSUE-29)`.

### Task 2: Ruta `GET /me/summary` + integración
**Files:** `src/modules/progress/summary-routes.ts`, `src/app.ts`, test `tests/progress/summary-routes.test.ts`
- [ ] Ruta arma los 4 bloques con queries paralelas; registro en app.ts.
- [ ] Test e2e con historial sembrado (XP 150, racha 3/5, 1 insignia ganada, 1 maestría) verificando cada bloque.
- [ ] Commit `feat(summary): endpoint GET /me/summary (ISSUE-29)`.

### Task 3: Verificación + PR
- [ ] Suite completa con BD verde; `build`/`typecheck`/`lint` limpios; limpiar contenedor; plan; push; PR a main.

## Self-Review

- Spec: cada bloque del payload verificado en integración (T2) ✓; progreso de nivel (T1) ✓.
