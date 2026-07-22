# Rachas (ISSUE-26) — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: superpowers:executing-plans. Pasos con checkbox (`- [ ]`).

**Goal:** Servicio `streak.recordActivity` que mantiene la racha diaria del alumno calculada en la zona horaria de su familia.

**Architecture:** Campo `Family.timezone` (IANA, default `America/Lima`) + módulo `src/modules/gamification/streak.ts`. El "día local" se deriva con `Intl.DateTimeFormat` (DST-safe); comparación de fechas-calendario decide sin-cambio / +1 / reinicio.

**Tech Stack:** TypeScript (NodeNext), Prisma, Vitest.

## Global Constraints

- `import` con `.js`; `import type` para tipos (verbatimModuleSyntax).
- Tests con BD auto-saltan sin `DATABASE_URL`.
- `prettier`/`eslint` limpios antes de cada commit; sin footer de atribución.

### Decisiones aprobadas
- **1.** `Family.timezone String @default("America/Lima")` (migración, filas existentes toman el default).
- **2.** Día local vía `Intl.DateTimeFormat` (`formatToParts`, robusto a locale/DST); comparo fechas-calendario: mismo día → sin cambio, diff 1 → +1, diff ≥2 → reinicia a 1.
- **3.** `recordActivity(db, studentId, timezone, now = new Date()) → { current, longest }` con `upsert`; `now` inyectable para clock falso. Helper `familyTimezoneForStudent(db, studentId)`.
- **4.** `isValidTimeZone`; validar al escribir (futuro endpoint) + fallback defensivo al default en el servicio (nunca revienta la actividad de un niño).

---

### Task 1: Migración `Family.timezone` + test estático

**Files:**
- Modify: `prisma/schema.prisma` (hecho)
- Create: `prisma/migrations/<ts>_family_timezone/migration.sql` (hecho)
- Test: `tests/prisma/family-timezone-schema.test.ts`

- [ ] **Step 1: Test estático** — asserta `timezone String @default("America/Lima")` en el bloque `Family`.
- [ ] **Step 2: Correr y ver pasar.**
- [ ] **Step 3: Commit** — `feat(streak): Family.timezone con migración (ISSUE-26)`.

---

### Task 2: Helpers de fecha (`localDate`, `isValidTimeZone`) — puros

**Files:**
- Create: `src/modules/gamification/streak.ts`
- Test: `tests/gamification/streak-localdate.test.ts`

**Interfaces:**
- Produces: `DEFAULT_TIMEZONE = "America/Lima"`; `isValidTimeZone(tz: string): boolean`; `localDate(now: Date, timeZone: string): string` (→ `"YYYY-MM-DD"`).

- [ ] **Step 1: Tests puros** — 23:59 vs 00:01 día siguiente → fechas distintas; cruce medianoche UTC vs local (Lima UTC-5); `isValidTimeZone` true/false.
- [ ] **Step 2: Correr y ver fallar.**
- [ ] **Step 3: Implementar helpers.**
- [ ] **Step 4: Correr y ver pasar.**
- [ ] **Step 5: Commit** — `feat(streak): día local DST-safe y validación de timezone (ISSUE-26)`.

---

### Task 3: Servicio (`recordActivity`, `familyTimezoneForStudent`)

**Files:**
- Modify: `src/modules/gamification/streak.ts`
- Test: `tests/gamification/streak-service.test.ts` (BD, auto-salta)

**Interfaces:**
- Produces:
  - `recordActivity(db, studentProfileId, timezone, now?) → Promise<{ current: number; longest: number }>`
  - `familyTimezoneForStudent(db, studentProfileId) → Promise<string>`

- [ ] **Step 1: Tests de servicio** — primera actividad → 1/1; mismo día local dos veces → 1; día siguiente → 2; brecha ≥2 → reinicia a 1, `longest` preservado; 23:59 + 00:01 día siguiente → 2 (clock falso); `familyTimezoneForStudent` devuelve la tz de la familia.
- [ ] **Step 2: Correr y ver fallar.**
- [ ] **Step 3: Implementar.**
- [ ] **Step 4: Correr con BD y ver pasar.**
- [ ] **Step 5: Commit** — `feat(streak): recordActivity en la zona de la familia (ISSUE-26)`.

---

### Task 4: Verificación + PR

- [ ] Suite completa con BD verde; `build`/`typecheck`/`lint` limpios.
- [ ] Limpiar contenedor; commit del plan; push; PR a main (sin footer; entregar link y parar).

## Self-Review

- Spec: campo timezone (T1) ✓; día local DST-safe (T2) ✓; sin-cambio/+1/reinicio (T3) ✓; clock falso 23:59/00:01 y cruce UTC/local (T2+T3) ✓; `longest` (T3) ✓.
- Sin placeholders; firmas consistentes (`recordActivity`, `localDate`, `familyTimezoneForStudent`).
