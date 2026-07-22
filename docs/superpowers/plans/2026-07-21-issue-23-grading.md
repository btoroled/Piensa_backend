# Motor de calificación (ISSUE-23) — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: superpowers:executing-plans. Pasos con checkbox (`- [ ]`).

**Goal:** Módulo puro `grading` que califica la respuesta de un alumno a una pregunta según su tipo, extensible sin tocar código existente.

**Architecture:** `src/modules/catalog/grading.ts` con un `gradingRegistry` (`type → corrector`) paralelo al `questionTypeRegistry`. `grade(type, answerSpec, studentAnswer, points)` despacha al corrector; fail-closed. Sin HTTP ni BD.

**Tech Stack:** TypeScript (NodeNext), Vitest.

## Global Constraints

- `import` con `.js`; `import type` para tipos.
- `prettier`/`eslint` limpios antes de cada commit; sin footer de atribución.
- Funciones puras: nada de HTTP ni Prisma.

### Decisiones aprobadas
- **1.** `grading.ts` en `catalog`; `gradingRegistry` paralelo; público `grade(type, answerSpec, studentAnswer, points) → { correct, pointsEarned }`.
- **2.** Corrector por tipo `(answerSpec, studentAnswer, points) → GradeResult`, todo-o-nada (`pointsEarned = correct ? points : 0`); `points` va al corrector (crédito parcial futuro).
- **3.** Fail-closed: tipo no registrado / datos malformados → `{ correct:false, pointsEarned:0 }`, nunca lanza.
- **4.** `fill_blank`: trim siempre; case-insensitive salvo `caseSensitive`; accent-insensitive (NFD + quitar diacríticos) salvo `accentSensitive`.
- **5.** Test del punto de extensión: registrar un corrector ficticio y ver que `grade` lo despacha.

---

### Task 1: Módulo `grading` + correctores v1 + tests

**Files:**
- Create: `src/modules/catalog/grading.ts`
- Test: `tests/catalog/grading.test.ts`

**Interfaces:**
- Produces:
  - `interface GradeResult { correct: boolean; pointsEarned: number }`
  - `type GraderFn = (answerSpec: unknown, studentAnswer: unknown, points: number) => GradeResult`
  - `registerGrader(type: string, fn: GraderFn): void`
  - `grade(type: string, answerSpec: unknown, studentAnswer: unknown, points: number): GradeResult`
  - Correctores v1: `multiple_choice` (índice), `true_false` (bool), `fill_blank` (string normalizado)

Casos de test:
- `multiple_choice`: índice correcto/incorrecto; `studentAnswer` no numérico o `answerSpec` sin `correctIndex` → incorrecto (sin excepción).
- `true_false`: correcto/incorrecto; malformado → incorrecto.
- `fill_blank`: exacto; trim; case-insensitive por defecto y `caseSensitive:true`; accent-insensitive ("árbol"=="arbol") y `accentSensitive:true`; malformado → incorrecto.
- `pointsEarned` = `points` si correcto, 0 si no.
- Tipo no registrado → `{ correct:false, pointsEarned:0 }`.
- Punto de extensión: `registerGrader("demo_x", …)` y `grade("demo_x", …)` lo usa.

- [ ] **Step 1: Escribir tests.**
- [ ] **Step 2: Correr y ver fallar.**
- [ ] **Step 3: Implementar `grading.ts`.**
- [ ] **Step 4: Correr y ver pasar.**
- [ ] **Step 5: Commit** — `feat(grading): motor de calificación por tipo, fail-closed (ISSUE-23)`.

---

### Task 2: Verificación + PR

- [ ] Suite completa verde; `build`/`typecheck`/`lint` limpios.
- [ ] Commit del plan; push; PR a main (sin footer; entregar link y parar).

## Self-Review

- Spec: suite por tipo (correcto/incorrecto/malformado/normalización) (T1) ✓; punto de extensión sin tocar existentes (T1) ✓; módulo puro (T1) ✓.
- Sin placeholders; firmas consistentes (`grade`, `registerGrader`, `GradeResult`).
