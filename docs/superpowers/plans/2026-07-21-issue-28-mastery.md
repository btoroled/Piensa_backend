# Maestría por topic (ISSUE-28) — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: superpowers:executing-plans. Pasos con checkbox (`- [ ]`).

**Goal:** Servicio `mastery.recalculate` que fija el nivel de dominio del alumno por topic según su desempeño reciente, permitiendo descenso.

**Architecture:** Módulo `src/modules/gamification/mastery.ts`. `classify(correct, total)` puro decide el nivel por umbrales; `recalculate` reúne la ventana de los últimos 10 intentos que tocan cada topic (leyendo el contrato `QuizAttempt.answers`), clasifica y hace upsert.

**Tech Stack:** TypeScript (NodeNext), Prisma, Vitest.

## Global Constraints

- `import` con `.js`; `import type` para tipos.
- Tests con BD auto-saltan sin `DATABASE_URL`.
- `prettier`/`eslint` limpios antes de cada commit; sin footer de atribución.

### Decisiones aprobadas
- **1.** Contrato `QuizAttempt.answers` = array `[{ questionId, correct }, ...]` (mastery ignora campos extra; ISSUE-24 lo escribirá calificando con ISSUE-23).
- **2.** `MASTERY_WINDOW = 10`; por topic, los últimos 10 intentos que lo tocan; sobre las respuestas a preguntas del topic: `correct/total`. Umbrales v1: `mastered` ≥95%/≥15, `proficient` ≥80%/≥10, `familiar` ≥60%/≥5, `attempted` ≥1.
- **3.** `classify(correct, total) → MasteryLevel | null` pura; `recalculate(db, studentId, topicIds) → TopicMastery[]` orquesta (upsert → baja de nivel al recomputar).
- **4.** `answers` malformado → fail-closed (se ignora, nunca revienta ni sube nivel).

---

### Task 1: `classify` puro + tests de umbral/descenso

**Files:**
- Create: `src/modules/gamification/mastery.ts`
- Test: `tests/gamification/mastery-classify.test.ts`

**Interfaces:**
- Produces: `MASTERY_WINDOW`, `classify(correct: number, total: number): MasteryLevel | null`.

- [ ] **Step 1: Tests** — sin respuestas → null; límites exactos de cada umbral; un ratio peor da nivel menor (descenso).
- [ ] **Step 2: Correr y ver fallar.**
- [ ] **Step 3: Implementar `classify`.**
- [ ] **Step 4: Correr y ver pasar.**
- [ ] **Step 5: Commit** — `feat(mastery): clasificación de niveles v1 (ISSUE-28)`.

---

### Task 2: `recalculate` (ventana + upsert)

**Files:**
- Modify: `src/modules/gamification/mastery.ts`
- Test: `tests/gamification/mastery-service.test.ts` (BD, auto-salta)

**Interfaces:**
- Produces: `recalculate(db, studentProfileId, topicIds: string[]) → Promise<TopicMastery[]>`.

Casos:
- Un quiz con preguntas de 3 topics → 3 filas `TopicMastery` (integración).
- Descenso: attempts buenos → `familiar`/`proficient`; attempts recientes malos → baja de nivel.
- Ventana: con >10 intentos, solo cuentan los últimos 10 (createdAt explícito).
- `answers` malformado → se ignora (no revienta).

- [ ] **Step 1: Tests.**
- [ ] **Step 2: Correr y ver fallar.**
- [ ] **Step 3: Implementar `recalculate`.**
- [ ] **Step 4: Correr con BD y ver pasar.**
- [ ] **Step 5: Commit** — `feat(mastery): recalculate por ventana con descenso de nivel (ISSUE-28)`.

---

### Task 3: Verificación + PR

- [ ] Suite completa con BD verde; `build`/`typecheck`/`lint` limpios.
- [ ] Limpiar contenedor; commit del plan; push; PR a main (sin footer; entregar link y parar).

## Self-Review

- Spec: unitarios por umbral incl. descenso (T1) ✓; quiz de 3 topics actualiza 3 (T2) ✓; ventana de 10 (T2) ✓; constantes documentadas (T1) ✓.
- Sin placeholders; firmas consistentes (`classify`, `recalculate`, `MASTERY_WINDOW`).
