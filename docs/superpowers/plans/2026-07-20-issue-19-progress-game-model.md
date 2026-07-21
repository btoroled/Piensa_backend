# ISSUE-19 — Modelo de datos de progreso y juego — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline), task por task.

**Goal:** Migración Prisma del progreso y la gamificación: `LessonProgress`, `QuizAttempt`, `XPEvent` (append-only, con `courseId`), `Streak`, `Badge`/`BadgeAward`, `TopicMastery`. Desbloquea M3 (motores 25/26/27/28 y endpoints 20-24).

**Architecture:** Libro de eventos (append-only para XP), datos derivados del alumno con `onDelete: Cascade` hacia `StudentProfile`. `XPEvent.courseId` (M2.5) etiqueta el curso; `SetNull` si el curso se borra (preserva el total auditable). `reason` como enum (integridad del libro). Todos los modelos existentes que referencian (StudentProfile, Lesson, Course, Topic) ganan las relaciones inversas.

**Tech Stack:** Prisma · PostgreSQL · Vitest.

Diseño aprobado (conversación) + Spec §4 + `Issues.MD` ISSUE-19 + `docs/superpowers/specs/2026-07-17-milestone-3-planning-notes.md`.

## Global Constraints

- TDD, commits por task, DoD. Uniques verificados por test. Migración offline (catálogo/progreso vacío) verificada contra Postgres real (Task 3).
- Append-only de `XPEvent`: **la prohibición de update/delete la hace cumplir el módulo `xp` + test de arquitectura en ISSUE-25**; acá va el modelo + los `@@unique`.
- Tests de BD auto-saltables; ESM `.js`.

## File Structure

- **Modify:** `prisma/schema.prisma` — enums `XpReason`, `MasteryLevel`; 7 modelos nuevos; relaciones inversas en StudentProfile/Lesson/Course/Topic.
- **Create:** `prisma/migrations/<ts>_progress_game/migration.sql`.
- **Create:** `tests/prisma/progress-game-schema.test.ts` (estático).
- **Create:** `tests/prisma/progress-game-constraints.test.ts` (DB).

---

## Task 1: Schema + migración

- [ ] **Step 1: Test estático (falla)**

Create `tests/prisma/progress-game-schema.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const schema = readFileSync(
  resolve(projectRoot, "prisma", "schema.prisma"),
  "utf8",
);
function modelBlock(name: string): string {
  const m = schema.match(new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`No se encontró el modelo ${name}`);
  return m[1] as string;
}

describe("schema.prisma — progreso y juego (ISSUE-19)", () => {
  test("enums XpReason y MasteryLevel con los valores v1", () => {
    expect(schema).toMatch(
      /enum\s+XpReason\s*\{[\s\S]*?lesson_complete[\s\S]*?quiz_passed[\s\S]*?quiz_attempt[\s\S]*?\}/,
    );
    expect(schema).toMatch(
      /enum\s+MasteryLevel\s*\{[\s\S]*?attempted[\s\S]*?familiar[\s\S]*?proficient[\s\S]*?mastered[\s\S]*?\}/,
    );
  });

  test("LessonProgress: único por (alumno, lección), cascade desde el alumno", () => {
    const m = modelBlock("LessonProgress");
    expect(m).toMatch(/@@unique\(\[studentProfileId,\s*lessonId\]\)/);
    expect(m).toMatch(
      /@relation\([^)]*fields:\s*\[studentProfileId\][^)]*onDelete:\s*Cascade[^)]*\)/,
    );
  });

  test("QuizAttempt: answers Json, score/maxScore, sin unique (todos los intentos)", () => {
    const m = modelBlock("QuizAttempt");
    expect(m).toMatch(/answers\s+Json/);
    expect(m).toMatch(/score\s+Int/);
    expect(m).toMatch(/maxScore\s+Int/);
    expect(m).not.toMatch(/@@unique/);
  });

  test("XPEvent: append-only (reason enum, refId, courseId? SetNull), idempotente", () => {
    const m = modelBlock("XPEvent");
    expect(m).toMatch(/amount\s+Int/);
    expect(m).toMatch(/reason\s+XpReason/);
    expect(m).toMatch(/refId\s+String/);
    expect(m).toMatch(/courseId\s+String\?/);
    expect(m).toMatch(
      /@relation\([^)]*fields:\s*\[courseId\][^)]*onDelete:\s*SetNull[^)]*\)/,
    );
    expect(m).toMatch(/@@unique\(\[studentProfileId,\s*reason,\s*refId\]\)/);
  });

  test("Streak único por alumno; Badge.code único; BadgeAward y TopicMastery únicos", () => {
    expect(modelBlock("Streak")).toMatch(/studentProfileId\s+String\s+@unique/);
    expect(modelBlock("Badge")).toMatch(/code\s+String\s+@unique/);
    expect(modelBlock("BadgeAward")).toMatch(
      /@@unique\(\[studentProfileId,\s*badgeId\]\)/,
    );
    const tm = modelBlock("TopicMastery");
    expect(tm).toMatch(/level\s+MasteryLevel/);
    expect(tm).toMatch(/@@unique\(\[studentProfileId,\s*topicId\]\)/);
  });
});
```

- [ ] **Step 2: Correr → falla.**

- [ ] **Step 3: Editar `prisma/schema.prisma`**

Agregar los enums (junto a los otros):

```prisma
// Razón de un evento de XP (ISSUE-19/25). Enum: la DB garantiza que el libro de
// XP solo tenga razones válidas (integridad del conteo auditable).
enum XpReason {
  lesson_complete
  quiz_passed
  quiz_attempt
}

// Nivel de maestría por topic (ISSUE-19/28).
enum MasteryLevel {
  attempted
  familiar
  proficient
  mastered
}
```

Agregar los 7 modelos al final:

```prisma
// ── Progreso y juego (Spec §4) ──────────────────────────────────────────────
// Libro de eventos (append-only para XP), no contadores editables. Todo cuelga
// del alumno con Cascade: borrar un alumno se lleva su progreso (datos derivados).

model LessonProgress {
  id               String   @id @default(uuid()) @db.Uuid
  studentProfileId String   @db.Uuid
  lessonId         String   @db.Uuid
  completedAt      DateTime @default(now())

  student StudentProfile @relation(fields: [studentProfileId], references: [id], onDelete: Cascade)
  lesson  Lesson         @relation(fields: [lessonId], references: [id], onDelete: Cascade)

  @@unique([studentProfileId, lessonId])
  @@index([studentProfileId])
  @@index([lessonId])
}

model QuizAttempt {
  id               String   @id @default(uuid()) @db.Uuid
  studentProfileId String   @db.Uuid
  lessonId         String   @db.Uuid
  answers          Json
  score            Int
  maxScore         Int
  createdAt        DateTime @default(now())

  student StudentProfile @relation(fields: [studentProfileId], references: [id], onDelete: Cascade)
  lesson  Lesson         @relation(fields: [lessonId], references: [id], onDelete: Cascade)

  @@index([studentProfileId])
  @@index([lessonId])
}

// Libro mayor de XP: solo inserción, nunca update/delete (lo hace cumplir el
// módulo xp, ISSUE-25). Idempotente por (alumno, reason, refId). courseId etiqueta
// el curso (M2.5); SetNull si el curso se borra (preserva el total).
model XPEvent {
  id               String   @id @default(uuid()) @db.Uuid
  studentProfileId String   @db.Uuid
  amount           Int
  reason           XpReason
  refId            String
  courseId         String?  @db.Uuid
  createdAt        DateTime @default(now())

  student StudentProfile @relation(fields: [studentProfileId], references: [id], onDelete: Cascade)
  course  Course?        @relation(fields: [courseId], references: [id], onDelete: SetNull)

  @@unique([studentProfileId, reason, refId])
  @@index([studentProfileId])
  @@index([courseId])
}

model Streak {
  id               String    @id @default(uuid()) @db.Uuid
  studentProfileId String    @unique @db.Uuid
  current          Int       @default(0)
  longest          Int       @default(0)
  lastActivityDate DateTime? @db.Date
  updatedAt        DateTime  @updatedAt

  student StudentProfile @relation(fields: [studentProfileId], references: [id], onDelete: Cascade)
}

// Catálogo de insignias (criterios declarativos JSON, evaluados en ISSUE-27).
model Badge {
  id          String   @id @default(uuid()) @db.Uuid
  code        String   @unique
  name        String
  description String
  criteria    Json
  createdAt   DateTime @default(now())

  awards BadgeAward[]
}

model BadgeAward {
  id               String   @id @default(uuid()) @db.Uuid
  studentProfileId String   @db.Uuid
  badgeId          String   @db.Uuid
  awardedAt        DateTime @default(now())

  student StudentProfile @relation(fields: [studentProfileId], references: [id], onDelete: Cascade)
  badge   Badge          @relation(fields: [badgeId], references: [id], onDelete: Cascade)

  @@unique([studentProfileId, badgeId])
  @@index([studentProfileId])
  @@index([badgeId])
}

model TopicMastery {
  id               String       @id @default(uuid()) @db.Uuid
  studentProfileId String       @db.Uuid
  topicId          String       @db.Uuid
  level            MasteryLevel
  updatedAt        DateTime     @updatedAt

  student StudentProfile @relation(fields: [studentProfileId], references: [id], onDelete: Cascade)
  topic   Topic          @relation(fields: [topicId], references: [id], onDelete: Cascade)

  @@unique([studentProfileId, topicId])
  @@index([studentProfileId])
  @@index([topicId])
}
```

Agregar las **relaciones inversas** en los modelos existentes:
- `StudentProfile`: `lessonProgress LessonProgress[]`, `quizAttempts QuizAttempt[]`, `xpEvents XPEvent[]`, `streak Streak?`, `badgeAwards BadgeAward[]`, `topicMastery TopicMastery[]`.
- `Lesson`: `progress LessonProgress[]`, `attempts QuizAttempt[]`.
- `Course`: `xpEvents XPEvent[]`.
- `Topic`: `mastery TopicMastery[]`.

- [ ] **Step 4: Formatear/validar + estático verde**

`npx prisma format && DATABASE_URL="postgresql://u:u@localhost:5432/db" npx prisma validate && npx vitest run tests/prisma/progress-game-schema.test.ts`

- [ ] **Step 5: Generar migración (offline) + cliente**

```bash
OLD="/tmp/old-19.prisma"; git show HEAD:prisma/schema.prisma > "$OLD"
TS=$(date +%Y%m%d%H%M%S); DIR="prisma/migrations/${TS}_progress_game"; mkdir -p "$DIR"
npx prisma migrate diff --from-schema-datamodel "$OLD" --to-schema-datamodel prisma/schema.prisma --script > "$DIR/migration.sql"
DATABASE_URL="postgresql://u:u@localhost:5432/db" npx prisma generate
cat "$DIR/migration.sql"
```
Revisar: crea los enums, las 7 tablas, uniques, FKs (Cascade hacia StudentProfile/Lesson/Topic/Badge; SetNull en XPEvent.courseId).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/prisma/progress-game-schema.test.ts
git commit -m "feat(progress): modelo de progreso y juego (append-only XP, ISSUE-19)"
```

---

## Task 2: Constraints contra BD

Create `tests/prisma/progress-game-constraints.test.ts` (patrón auto-skip). Casos:
- `LessonProgress` único por (alumno, lección) → P2002.
- `XPEvent` único por (alumno, reason, refId) → P2002 (idempotencia).
- `Streak` único por alumno → P2002; `Badge.code` único → P2002; `BadgeAward` único por (alumno, badge) → P2002; `TopicMastery` único por (alumno, topic) → P2002.
- **Cascade:** borrar el alumno borra su LessonProgress/QuizAttempt/XPEvent/Streak/BadgeAward/TopicMastery.
- **SetNull:** borrar un `Course` deja el `XPEvent` con `courseId = null` (conserva el evento).

(Helper para sembrar: family+student, y para el SetNull un subject+grade+course; XPEvent con ese courseId; borrar el course → `courseId` null.)

- [ ] **Commit:** `git commit -m "test(progress): constraints de unicidad, cascade y SetNull (ISSUE-19)"`

---

## Task 3: Verificación final (con BD) + PR

- [ ] Postgres desechable (5433) + `migrate deploy` (verifica la migración + el round-trip).
- [ ] `DATABASE_URL=... npx vitest run` → todo verde.
- [ ] `npm run lint && npm run typecheck && npm run build`.
- [ ] limpiar contenedor; commitear el plan; `git push`; PR hacia `main`; link y parar. Sin footer.

---

## Self-Review

- 7 modelos con sus uniques (criterio: constraints verificados por test) → Task 1/2. ✔
- XPEvent append-only (modelo + idempotencia por reason/refId); prohibición de edición = ISSUE-25. ✔
- XP por curso (`courseId` + SetNull), cascada desde el alumno, TopicMastery enum. ✔
- Migración limpia sobre progreso vacío; verificada en Task 3. ✔
