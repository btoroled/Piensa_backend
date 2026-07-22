# Insignias (ISSUE-27) — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: superpowers:executing-plans. Pasos con checkbox (`- [ ]`).

**Goal:** Evaluador declarativo de insignias que otorga (idempotente y retroactivo) las del catálogo cuyo criterio se cumple.

**Architecture:** Módulo `src/modules/gamification/badges.ts`. `criteria` (JSON) es una unión discriminada por `type`; un registro `type → predicado(db, studentId, criteria)` es el punto de extensión. `evaluate` barre todo el catálogo contra el estado actual (agregado) del alumno → retroactivo por construcción. Otorga con insert-catch-P2002.

**Tech Stack:** TypeScript (NodeNext), Prisma, Vitest.

## Global Constraints

- `import` con `.js`; `import type` para tipos.
- Tests con BD auto-saltan sin `DATABASE_URL`.
- `prettier`/`eslint` limpios antes de cada commit; sin footer de atribución.

### Decisiones aprobadas
- **1.** Criterios = unión discriminada por `type` + registro de predicados. Set v1: `lessons_completed{count}`, `week_complete`, `perfect_quiz`, `streak{days}`.
- **2.** `evaluate(db, studentId) → Badge[]`: barrido completo del catálogo; otorga las que faltan y cumplen; retroactivo (lee estado agregado, `Streak.longest`).
- **3.** Criterio malformado / `type` desconocido → **fail-closed**: no cumplido, nunca revienta.
- **4.** Otorgamiento idempotente vía insert-catch-P2002 sobre `@@unique([studentProfileId, badgeId])`.
- **5.** Catálogo v1 como `V1_BADGES` + `seedBadges(db)` (upsert por `code`).

---

### Task 1: Módulo evaluador + catálogo v1

**Files:**
- Create: `src/modules/gamification/badges.ts`

**Interfaces:**
- Produces:
  - `type Criteria` (unión discriminada)
  - `V1_BADGES: { code, name, description, criteria: Criteria }[]`
  - `seedBadges(db): Promise<void>` (upsert por code)
  - `criteriaMet(db, studentProfileId, criteria: unknown): Promise<boolean>` (fail-closed)
  - `evaluate(db, studentProfileId): Promise<Badge[]>` (otorga faltantes cumplidas; idempotente)

- [ ] Implementar el módulo (código completo abajo en Task 2 tests dirige el diseño).

---

### Task 2: Tests del evaluador (con BD)

**Files:**
- Test: `tests/gamification/badges.test.ts` (auto-salta sin BD)

Casos:
- `first-lesson`: sin actividad → no; tras 1ª `LessonProgress` → otorgada; segundo `evaluate` → sin nuevas, `BadgeAward` count = 1 (idempotente).
- `week-complete`: 1 de 2 lecciones → no; ambas → otorgada.
- `perfect-quiz`: intento 3/4 → no; 4/4 → otorgada.
- `streak-7` retroactiva: `longest=6` → no; `longest=7` → otorgada; `streak-30` no.
- Criterio malformado (`type` desconocido, `streak` sin `days`) → no otorgada, `evaluate` no lanza.

- [ ] **Step 1: Escribir tests.**
- [ ] **Step 2: Correr y ver fallar.**
- [ ] **Step 3: Implementar `badges.ts` (Task 1).**
- [ ] **Step 4: Correr con BD y ver pasar.**
- [ ] **Step 5: Commit** — `feat(badges): evaluador declarativo idempotente y retroactivo (ISSUE-27)`.

---

### Task 3: Verificación + PR

- [ ] Suite completa con BD verde; `build`/`typecheck`/`lint` limpios.
- [ ] Limpiar contenedor; commit del plan; push; PR a main (sin footer; entregar link y parar).

## Self-Review

- Spec: test por insignia otorgada exactamente cuando corresponde y una vez (T2) ✓; retroactivo con `streak-7` usando `longest` (T2) ✓; idempotencia (T2) ✓; extensión declarativa (T1) ✓.
- Sin placeholders; firmas consistentes (`evaluate`, `criteriaMet`, `seedBadges`, `V1_BADGES`).
