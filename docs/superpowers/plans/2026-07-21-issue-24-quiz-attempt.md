# Enviar intento de quiz (ISSUE-24) — Plan

> **Para workers agénticos:** SUB-SKILL REQUERIDA: superpowers:executing-plans.

**Goal:** `POST /quizzes/:id/attempts` califica server-side, persiste el intento, y —en una transacción— otorga XP no farmeable, marca progreso si aprueba, y actualiza racha, insignias y maestría.

**Architecture:** Ruta `quizRoutes` en `progress/quiz-routes.ts`. Reusa `grading` (ISSUE-23), `xp`/`streak`/`badges`/`mastery` (ISSUE-25/26/27/28) dentro de `prisma.$transaction`. `mastery` se ensancha a `Prisma.TransactionClient`. Se apila sobre ISSUE-22 (infra de transacción).

**Tech Stack:** Fastify, Prisma, TypeScript, Vitest.

## Global Constraints

- `import` con `.js`; `import type`; respuestas `{ data }`; errores `AppError`.
- Rutas de alumno: `authenticate + requireRole("student")`; `studentProfileId` del token.
- Tests con BD auto-saltan; `prettier`/`eslint` limpios; sin footer.

### Decisiones aprobadas
- **1.** `:id` = lección quiz; body `{ answers: [{ questionId, answer }] }`; sin responder → incorrecto (fail-closed).
- **2.** Calificación server-side con `grade` (answerSpec solo en servidor); `perQuestion = [{questionId, correct}]` sin revelar la respuesta.
- **3.** XP no farmeable: aprobado (≥`PASS_THRESHOLD`=0.70) → +20 `quiz_passed` refId=lessonId (una vez); no aprobado → +5 `quiz_attempt` refId=`lessonId:fechaLocal` (primer fallo del día).
- **4.** Persiste `QuizAttempt` (answers=[{questionId,answer,correct,pointsEarned}]); si aprueba → `LessonProgress` upsert; racha/insignias/maestría SIEMPRE; todo en `$transaction`; `mastery` ensanchada a TransactionClient.
- **5.** Respuesta `{ score, maxScore, passed, perQuestion, xpEarned, totalXp, level, streak, newBadges, masteryChanges }`; `masteryChanges` = solo los topics que cambiaron de nivel `[{topicId, from, to}]`.

### Nota (ajv)
`answer` es `type: ["string","number","boolean"]` (unión). Se habilitó `allowUnionTypes` en la config de ajv de `app.ts` (evita el warning de strictTypes; `oneOf` choca con `coerceTypes`).

---

### Task 1: Ensanchar `mastery` a `TransactionClient`
- [ ] `mastery.recalculate` acepta `Prisma.TransactionClient`; typecheck limpio; tests de mastery siguen verdes.
- [ ] Commit `refactor(mastery): recalculate acepta TransactionClient (ISSUE-24)`.

### Task 2: Endpoint `POST /quizzes/:id/attempts` + integración
- [ ] Ruta + `allowUnionTypes` en app.ts + registro; test end-to-end.
- [ ] Casos: aprobado mixto (campos + no filtra respuesta); persistencia (QuizAttempt+LessonProgress+XPEvent); reaprobar → xpEarned 0; fallo → +5 solo 1º del día; no-quiz → VALIDATION_ERROR.
- [ ] Commit `feat(quiz): POST /quizzes/:id/attempts con calificación, XP no farmeable y maestría (ISSUE-24)`.

### Task 3: Verificación + PR
- [ ] Suite completa con BD verde; `build`/`typecheck`/`lint` limpios; limpiar contenedor; plan; push; PR (base = rama de ISSUE-22 hasta que #22 mergee).

## Self-Review

- Spec: e2e verifica cada campo y filas persistidas (T2) ✓; perQuestion sin revelar respuesta (T2) ✓; XP no farmeable (T2) ✓.
