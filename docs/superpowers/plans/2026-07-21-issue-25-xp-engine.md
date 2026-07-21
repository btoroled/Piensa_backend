# Motor de XP y niveles (ISSUE-25) — Plan de implementación

> **Para workers agénticos:** SUB-SKILL REQUERIDA: usar superpowers:executing-plans. Los pasos usan checkbox (`- [ ]`).

**Goal:** Un service `xp` que registra XP en un libro append-only idempotente, con total global, total por curso y curva de niveles.

**Architecture:** Módulo `src/modules/gamification/xp.ts` — funciones puras (`getLevel`) + funciones sobre Prisma (`append`, `getTotal`, `getCourseTotals`). El append-only se garantiza por unique de BD (P2002 → no-op) y por un test de arquitectura que prohíbe `xPEvent.update/delete/upsert` en `src/`.

**Tech Stack:** TypeScript (NodeNext), Prisma, Vitest.

## Global Constraints

- `import` con extensión `.js` (NodeNext), `verbatimModuleSyntax` → `import type` para tipos.
- Errores de dominio via `AppError`; duck-typing de Prisma via `isPrismaError(err, code)`.
- Tests con BD auto-saltan sin `DATABASE_URL` (patrón `makeClient/probe/describe.skipIf`).
- `prettier`/`eslint` limpios antes de cada commit.
- Sin footer de atribución en commits/PR.

### Decisiones aprobadas
- **Curva (1A):** `umbral(N) = 50·N·(N+1)`; `nivel(xp) = 1 + (umbrales cruzados)`. Alumno nuevo = **Nivel 1**. Tramos: 0–99→L1, 100–299→L2, 300–599→L3, 600–999→L4.
- **Idempotencia (2):** insertar y atrapar P2002 (a prueba de carrera); `append` devuelve `{ event, created }`.
- **Por curso (3):** `append(..., courseId?)` etiqueta el evento; `getCourseTotals(studentId)` agrega por curso (eventos sin curso cuentan al total pero no a ningún curso).
- **Validación (4):** `append` rechaza `amount ≤ 0`.

---

### Task 1: Curva de niveles (`getLevel`) — función pura

**Files:**
- Create: `src/modules/gamification/xp.ts`
- Test: `tests/gamification/xp-curve.test.ts`

**Interfaces:**
- Produces: `getLevel(totalXp: number): number`; `LEVEL_XP_STEP = 100` (constante documentada de la curva).

- [ ] **Step 1: Test de límites exactos**

```ts
import { describe, expect, test } from "vitest";
import { getLevel } from "../../src/modules/gamification/xp.js";

describe("getLevel — curva v1 (umbral(N)=50·N·(N+1))", () => {
  test("alumno nuevo empieza en Nivel 1", () => {
    expect(getLevel(0)).toBe(1);
    expect(getLevel(99)).toBe(1);
  });
  test("límites exactos entre niveles", () => {
    expect(getLevel(100)).toBe(2); // umbral(1)=100
    expect(getLevel(299)).toBe(2);
    expect(getLevel(300)).toBe(3); // umbral(2)=300
    expect(getLevel(599)).toBe(3);
    expect(getLevel(600)).toBe(4); // umbral(3)=600
    expect(getLevel(999)).toBe(4);
    expect(getLevel(1000)).toBe(5); // umbral(4)=1000
  });
});
```

- [ ] **Step 2: Correr y ver fallar** — `npx vitest run tests/gamification/xp-curve.test.ts` → FAIL (getLevel no existe).

- [ ] **Step 3: Implementar**

```ts
// Motor de XP y niveles (ISSUE-25). Libro append-only: los eventos solo se
// insertan (idempotentes por (studentProfileId, reason, refId)); nunca se
// actualizan ni borran (lo garantiza tests/gamification/xp-append-only.test.ts).

/** XP base de la curva v1. umbral(N) = LEVEL_XP_STEP · N · (N+1) / 2. */
export const LEVEL_XP_STEP = 100;

/** Nivel del alumno según su XP acumulado. Empieza en Nivel 1 (0 XP). */
export function getLevel(totalXp: number): number {
  let level = 1;
  while ((LEVEL_XP_STEP * level * (level + 1)) / 2 <= totalXp) level++;
  return level;
}
```

- [ ] **Step 4: Correr y ver pasar.**

- [ ] **Step 5: Commit** — `feat(xp): curva de niveles v1 (ISSUE-25)`.

---

### Task 2: Service de XP (`append`, `getTotal`, `getCourseTotals`)

**Files:**
- Modify: `src/modules/gamification/xp.ts`
- Test: `tests/gamification/xp-service.test.ts` (con BD, auto-salta)

**Interfaces:**
- Consumes: `PrismaClient`, `XpReason`, `isPrismaError`.
- Produces:
  - `append(db, studentProfileId, amount, reason, refId, courseId?): Promise<{ event: XPEvent; created: boolean }>`
  - `getTotal(db, studentProfileId): Promise<number>`
  - `getCourseTotals(db, studentProfileId): Promise<Record<string, number>>`

- [ ] **Step 1: Tests de servicio (idempotencia, total, por curso, amount inválido)**

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  append,
  getTotal,
  getCourseTotals,
} from "../../src/modules/gamification/xp.js";

function makeClient(): PrismaClient | null {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "")
    return null;
  try {
    return new PrismaClient();
  } catch {
    return null;
  }
}
async function probe(c: PrismaClient | null): Promise<boolean> {
  if (!c) return false;
  try {
    await c.$queryRawUnsafe("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
const prisma = makeClient();
const dbAvailable = await probe(prisma);
if (!dbAvailable)
  console.warn("[xp] BD no disponible: se saltan los tests (corren en CI).");
afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("xp service", () => {
  const tag = `xp25-${randomUUID()}`;
  let studentId: string;
  let famId: string;
  let userId: string;
  let courseA: string;
  let courseB: string;

  beforeAll(async () => {
    const user = await db.user.create({
      data: { email: `u-${tag}@piensa.test`, passwordHash: "x", role: "parent" },
    });
    userId = user.id;
    const fam = await db.family.create({
      data: { name: `F-${tag}`, parentUserId: user.id },
    });
    famId = fam.id;
    const st = await db.studentProfile.create({
      data: { familyId: fam.id, name: "Ana", avatar: "fox", pinHash: "x" },
    });
    studentId = st.id;
    const subj = await db.subject.create({ data: { name: `S-${tag}` } });
    const lvl = () => Math.floor(Math.random() * 1_000_000) + 1;
    const g1 = await db.grade.create({ data: { name: `G1-${tag}`, level: lvl() } });
    const g2 = await db.grade.create({ data: { name: `G2-${tag}`, level: lvl() } });
    courseA = (
      await db.course.create({
        data: { subjectId: subj.id, gradeId: g1.id, title: "A" },
      })
    ).id;
    courseB = (
      await db.course.create({
        data: { subjectId: subj.id, gradeId: g2.id, title: "B" },
      })
    ).id;
  });

  afterAll(async () => {
    await db.studentProfile.deleteMany({ where: { familyId: famId } });
    await db.course.deleteMany({ where: { id: { in: [courseA, courseB] } } });
    await db.subject.deleteMany({ where: { name: { contains: tag } } });
    await db.grade.deleteMany({ where: { name: { contains: tag } } });
    await db.family.deleteMany({ where: { id: famId } });
    await db.user.deleteMany({ where: { id: userId } });
  });

  test("append idempotente por (reason, refId): mismo par → un evento", async () => {
    const ref = `l-${randomUUID()}`;
    const first = await append(db, studentId, 10, "lesson_complete", ref);
    expect(first.created).toBe(true);
    const second = await append(db, studentId, 10, "lesson_complete", ref);
    expect(second.created).toBe(false);
    expect(second.event.id).toBe(first.event.id);
    const count = await db.xPEvent.count({
      where: { studentProfileId: studentId, reason: "lesson_complete", refId: ref },
    });
    expect(count).toBe(1);
  });

  test("getTotal suma todos los eventos del alumno", async () => {
    await append(db, studentId, 20, "quiz_passed", `q-${randomUUID()}`, courseA);
    await append(db, studentId, 5, "quiz_attempt", `a-${randomUUID()}`, courseB);
    const total = await getTotal(db, studentId);
    expect(total).toBe(35); // 10 + 20 + 5
  });

  test("getCourseTotals agrega por curso; los sin curso no cuentan", async () => {
    const totals = await getCourseTotals(db, studentId);
    expect(totals[courseA]).toBe(20);
    expect(totals[courseB]).toBe(5);
    // el evento lesson_complete (sin courseId) no aparece
    expect(Object.keys(totals)).toHaveLength(2);
  });

  test("append rechaza amount ≤ 0", async () => {
    await expect(
      append(db, studentId, 0, "lesson_complete", `bad-${randomUUID()}`),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Correr y ver fallar** (append/getTotal/getCourseTotals no existen).

- [ ] **Step 3: Implementar en `xp.ts`** (añadir sobre lo de Task 1)

```ts
import type { PrismaClient, XPEvent, XpReason } from "@prisma/client";
import { isPrismaError } from "../../lib/prisma-errors.js";

/** Registra un evento de XP. Idempotente por (studentProfileId, reason, refId):
 *  si ya existe, no inserta y devuelve created:false con el evento previo. */
export async function append(
  db: PrismaClient,
  studentProfileId: string,
  amount: number,
  reason: XpReason,
  refId: string,
  courseId?: string,
): Promise<{ event: XPEvent; created: boolean }> {
  if (amount <= 0) throw new Error(`XP amount debe ser positivo (recibí ${amount})`);
  try {
    const event = await db.xPEvent.create({
      data: { studentProfileId, amount, reason, refId, courseId: courseId ?? null },
    });
    return { event, created: true };
  } catch (err) {
    if (isPrismaError(err, "P2002")) {
      const event = await db.xPEvent.findUniqueOrThrow({
        where: {
          studentProfileId_reason_refId: { studentProfileId, reason, refId },
        },
      });
      return { event, created: false };
    }
    throw err;
  }
}

/** XP total acumulado del alumno (todos los eventos). */
export async function getTotal(
  db: PrismaClient,
  studentProfileId: string,
): Promise<number> {
  const r = await db.xPEvent.aggregate({
    _sum: { amount: true },
    where: { studentProfileId },
  });
  return r._sum.amount ?? 0;
}

/** XP por curso (excluye eventos sin curso). Mapa courseId → total. */
export async function getCourseTotals(
  db: PrismaClient,
  studentProfileId: string,
): Promise<Record<string, number>> {
  const rows = await db.xPEvent.groupBy({
    by: ["courseId"],
    where: { studentProfileId, courseId: { not: null } },
    _sum: { amount: true },
  });
  return Object.fromEntries(
    rows.map((r) => [r.courseId as string, r._sum.amount ?? 0]),
  );
}
```

- [ ] **Step 4: Correr los tests con BD (throwaway Postgres) y ver pasar.**

- [ ] **Step 5: Commit** — `feat(xp): append idempotente, total y total por curso (ISSUE-25)`.

---

### Task 3: Test de arquitectura (append-only) + verificación + PR

**Files:**
- Test: `tests/gamification/xp-append-only.test.ts`

**Interfaces:**
- Consumes: recorre archivos de `src/` buscando patrones prohibidos.

- [ ] **Step 1: Test de arquitectura**

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// El libro de XP es append-only: ningún archivo de src/ puede mutar XPEvent.
// (la cascada al borrar el alumno la hace la BD, no código de aplicación.)

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..", "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("XPEvent es append-only (arquitectura)", () => {
  test("ningún archivo de src/ llama update/delete/upsert sobre xPEvent", () => {
    const forbidden =
      /xPEvent\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/;
    const offenders = walk(srcDir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => forbidden.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Correr y ver pasar** (no debe haber ofensores).

- [ ] **Step 3: Verificación final con BD** — throwaway Postgres 5433, `prisma migrate deploy`, `vitest run` completo verde.

- [ ] **Step 4: `npm run build && npm run typecheck && npm run lint` limpios.**

- [ ] **Step 5: Commit + push + PR a main** (sin footer; entregar link y parar).
  - Commit: `test(xp): libro append-only garantizado por arquitectura (ISSUE-25)`.
```
```

## Self-Review

- **Cobertura del spec:** curva con límites exactos (Task 1) ✓; idempotencia (Task 2) ✓; getTotal (Task 2) ✓; getLevel (Task 1) ✓; por-curso extra aprobado (Task 2) ✓; append-only enforcement (Task 3) ✓.
- **Sin placeholders:** todo el código está escrito.
- **Consistencia de tipos:** `append/getTotal/getCourseTotals` con las mismas firmas en plan y tests; `db.xPEvent` (naming Prisma del modelo XPEvent); unique compuesto `studentProfileId_reason_refId`.
