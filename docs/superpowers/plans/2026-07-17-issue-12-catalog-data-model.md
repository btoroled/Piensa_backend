# ISSUE-12 — Modelo de datos del catálogo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar a Prisma el modelo de datos del catálogo (Grade → Week → Lesson → Question, más Topic y sus tablas de etiquetado) con sus constraints, y el guard de servicio que impide colgar preguntas de lecciones que no son quiz.

**Architecture:** Una sola migración Prisma incremental sobre el schema de Personas ya existente. El catálogo es contenido compartido por todas las familias (sin estado por-alumno: eso vive en ISSUE-19/20). La jerarquía se protege con FKs `onDelete: Restrict` (sin cascadas silenciosas de contenido); las tablas de etiquetado usan `Cascade` hacia su dueño (lección/pregunta) y `Restrict` hacia el `Topic` (un topic en uso no se puede borrar — lo exige ISSUE-16). La regla "una Question solo cuelga de una Lesson `quiz`" no es expresable en DB, así que se implementa como función pura de servicio con test, y ISSUE-15 la invocará al crear preguntas.

**Tech Stack:** Prisma + PostgreSQL · TypeScript estricto · Vitest.

## Global Constraints

- **Stack (spec §2):** Node.js + TypeScript · Fastify · Prisma · PostgreSQL · Vitest. TypeScript en modo estricto.
- **TDD obligatorio:** cada task empieza por el test que falla, luego la implementación mínima, luego commit. Nada se cierra sin tests en verde.
- **Filosofía de borrado del repo:** FKs con `onDelete: Restrict` sobre la jerarquía de contenido (coherente con ISSUE-05/13/14: borrar con contenido → rechazo, nunca huérfanos ni cascada silenciosa).
- **Errores:** los guards de dominio lanzan `AppError(code, message)` con `code` del catálogo `ErrorCode` (`src/plugins/errors.ts`). Para este issue el único código es `VALIDATION_ERROR`. Mensajes aptos para el cliente, sin filtrar detalles internos.
- **Tests de BD auto-saltables:** los tests que tocan Postgres usan el patrón `makeClient()/probe()/describe.skipIf(!dbAvailable)` (ver `tests/prisma/personas-constraints.test.ts`). Sin Postgres se auto-saltan (nada de verde fabricado); en CI (ISSUE-04) hay un service container migrado y SÍ corren: esa es la evidencia real de los criterios.
- **Módulos ESM:** los imports internos llevan extensión `.js` (p. ej. `../../plugins/errors.js`), como en el resto de `src/`.
- **Enums (valores exactos del issue):** `LessonType = video | reading | quiz`; `QuestionType = multiple_choice | true_false | fill_blank`.

---

## File Structure

- **Modify:** `prisma/schema.prisma` — agrega enums `LessonType`/`QuestionType`; modelos `Grade`, `Week`, `Lesson`, `Question`, `Topic`, `LessonTopic`, `QuestionTopic`; cablea `StudentProfile.gradeId` como FK a `Grade`.
- **Create:** `prisma/migrations/<timestamp>_catalog/migration.sql` — generada por `prisma migrate dev` (no se escribe a mano).
- **Create:** `src/modules/catalog/questions.ts` — `assertLessonAcceptsQuestions(lesson)`: guard puro de la regla "Question solo bajo Lesson `quiz`".
- **Create:** `tests/prisma/catalog-schema.test.ts` — auditoría estática del schema (sin BD): modelos, enums, unicidad, `onDelete`, nullabilidad de campos por tipo.
- **Create:** `tests/prisma/catalog-constraints.test.ts` — constraints contra Postgres real (auto-salta local, corre en CI): `order` único, borrados `Restrict`.
- **Create:** `tests/catalog/question-guard.test.ts` — test unitario del guard de servicio.

---

## Task 1: Schema y migración del catálogo

Agrega los modelos del catálogo al schema y genera la migración. El test estático de schema es la red TDD local (no necesita BD).

**Files:**
- Create: `tests/prisma/catalog-schema.test.ts`
- Modify: `prisma/schema.prisma` (agrega enums + 6 modelos; cablea FK en `StudentProfile`)
- Create: `prisma/migrations/<timestamp>_catalog/migration.sql` (generada)

**Interfaces:**
- Produces (modelos Prisma que consumen las tasks 2 y 3, y los issues 13-19):
  - `Grade { id, name, createdAt, updatedAt, weeks Week[], students StudentProfile[] }`
  - `Week { id, gradeId, number, title, description?, ... }` · `@@unique([gradeId, number])`
  - `Lesson { id, weekId, order, type: LessonType, embedUrl?, richContent?, fileKey?, ... }` · `@@unique([weekId, order])`
  - `Question { id, lessonId, order, type: QuestionType, content Json, answerSpec Json, points Int, ... }` · `@@unique([lessonId, order])`
  - `Topic { id, name @unique, ... }`, `LessonTopic { @@id([lessonId, topicId]) }`, `QuestionTopic { @@id([questionId, topicId]) }`
  - `enum LessonType`, `enum QuestionType` exportados por `@prisma/client`.

- [ ] **Step 1: Escribir el test estático del schema (falla)**

Create `tests/prisma/catalog-schema.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Verificación estática del modelo del catálogo (Spec §4, ISSUE-12). No requiere
// base de datos: audita que el schema declare los modelos, enums, unicidad y
// reglas de borrado exigidas. Los constraints reales se ejercitan contra la BD
// en catalog-constraints.test.ts (corre en CI).

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const schema = readFileSync(
  resolve(projectRoot, "prisma", "schema.prisma"),
  "utf8",
);

function modelBlock(name: string): string {
  const match = schema.match(
    new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  if (!match) {
    throw new Error(`No se encontró el modelo ${name} en schema.prisma`);
  }
  return match[1] as string;
}

describe("schema.prisma — modelo del catálogo", () => {
  test("declara los enums de tipo de lección y de pregunta con los valores del spec", () => {
    expect(schema).toMatch(
      /enum\s+LessonType\s*\{[\s\S]*?video[\s\S]*?reading[\s\S]*?quiz[\s\S]*?\}/,
    );
    expect(schema).toMatch(
      /enum\s+QuestionType\s*\{[\s\S]*?multiple_choice[\s\S]*?true_false[\s\S]*?fill_blank[\s\S]*?\}/,
    );
  });

  test("Week cuelga de Grade con borrado restringido y número único por grado", () => {
    const week = modelBlock("Week");
    expect(week).toMatch(/gradeId\s+String/);
    expect(week).toMatch(/title\s+String/);
    expect(week).toMatch(/description\s+String\?/);
    expect(week).toMatch(
      /@relation\([^)]*fields:\s*\[gradeId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
    expect(week).toMatch(/@@unique\(\[gradeId,\s*number\]\)/);
  });

  test("Lesson cuelga de Week (Restrict), tipa el type y guarda campos por tipo nullable", () => {
    const lesson = modelBlock("Lesson");
    expect(lesson).toMatch(/type\s+LessonType/);
    // Campos específicos por tipo: nullable, no un blob JSON.
    expect(lesson).toMatch(/embedUrl\s+String\?/);
    expect(lesson).toMatch(/richContent\s+String\?/);
    expect(lesson).toMatch(/fileKey\s+String\?/);
    expect(lesson).toMatch(
      /@relation\([^)]*fields:\s*\[weekId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
    // order único por semana.
    expect(lesson).toMatch(/@@unique\(\[weekId,\s*order\]\)/);
  });

  test("Question cuelga de Lesson (Restrict), con content/answerSpec JSON y order único por lección", () => {
    const question = modelBlock("Question");
    expect(question).toMatch(/type\s+QuestionType/);
    expect(question).toMatch(/content\s+Json/);
    expect(question).toMatch(/answerSpec\s+Json/);
    expect(question).toMatch(/points\s+Int/);
    expect(question).toMatch(
      /@relation\([^)]*fields:\s*\[lessonId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
    expect(question).toMatch(/@@unique\(\[lessonId,\s*order\]\)/);
  });

  test("Topic tiene name único; las tablas de etiquetado son join explícitos", () => {
    const topic = modelBlock("Topic");
    expect(topic).toMatch(/name\s+String\s+@unique/);

    const lessonTopic = modelBlock("LessonTopic");
    expect(lessonTopic).toMatch(/@@id\(\[lessonId,\s*topicId\]\)/);
    // El link muere con su lección (Cascade) pero protege al topic (Restrict).
    expect(lessonTopic).toMatch(
      /@relation\([^)]*fields:\s*\[lessonId\][^)]*onDelete:\s*Cascade[^)]*\)/,
    );
    expect(lessonTopic).toMatch(
      /@relation\([^)]*fields:\s*\[topicId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );

    const questionTopic = modelBlock("QuestionTopic");
    expect(questionTopic).toMatch(/@@id\(\[questionId,\s*topicId\]\)/);
    expect(questionTopic).toMatch(
      /@relation\([^)]*fields:\s*\[questionId\][^)]*onDelete:\s*Cascade[^)]*\)/,
    );
    expect(questionTopic).toMatch(
      /@relation\([^)]*fields:\s*\[topicId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
  });

  test("StudentProfile.gradeId queda cableado como FK a Grade con borrado restringido", () => {
    const profile = modelBlock("StudentProfile");
    // Sigue nullable (se asigna después), pero ahora es una relación real.
    expect(profile).toMatch(/gradeId\s+String\?/);
    expect(profile).toMatch(
      /@relation\([^)]*fields:\s*\[gradeId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run tests/prisma/catalog-schema.test.ts`
Expected: FAIL — `No se encontró el modelo Week en schema.prisma` (los modelos aún no existen).

- [ ] **Step 3: Editar `prisma/schema.prisma`**

Agrega los enums después de `enum FamilyStatus { ... }`:

```prisma
// Tipo de lección (Spec §4). Cada tipo usa sus propios campos en `Lesson`:
// video → embedUrl; reading → richContent o fileKey (R2); quiz → cuelga Questions.
enum LessonType {
  video
  reading
  quiz
}

// Tipos de pregunta de v1 (Spec §4). El punto de extensión (registry de tipos)
// llega en ISSUE-15; aquí solo se fija el enum persistido.
enum QuestionType {
  multiple_choice
  true_false
  fill_blank
}
```

Agrega los modelos del catálogo al final del archivo:

```prisma
// ── Catálogo (Spec §4) ──────────────────────────────────────────────────────
// Contenido que carga el admin, compartido por todas las familias. Sin estado
// por-alumno: la completitud y el progreso viven en ISSUE-19/20. La jerarquía se
// protege con onDelete: Restrict (borrar con contenido → rechazo explícito).

// Grado escolar (ej. "3° Primaria"): raíz del árbol de contenido y unidad que se
// asigna a un StudentProfile.
model Grade {
  id        String   @id @default(uuid()) @db.Uuid
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  weeks    Week[]
  // Restrict: no se puede borrar un grado que tenga alumnos asignados.
  students StudentProfile[]
}

// Semana: las "secciones" estilo Duolingo dentro de un grado. `number` ordena las
// semanas y es único por grado.
model Week {
  id          String   @id @default(uuid()) @db.Uuid
  gradeId     String   @db.Uuid
  number      Int
  title       String
  description String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  grade   Grade    @relation(fields: [gradeId], references: [id], onDelete: Restrict)
  lessons Lesson[]

  @@unique([gradeId, number])
  @@index([gradeId])
}

// Lección: unidad de contenido dentro de una semana. `order` la posiciona y es
// único por semana. Los campos por tipo son nullable (solo el del `type` aplica);
// la coherencia payload↔type la valida el CRUD (ISSUE-14).
model Lesson {
  id          String     @id @default(uuid()) @db.Uuid
  weekId      String     @db.Uuid
  order       Int
  type        LessonType
  embedUrl    String?
  richContent String?
  fileKey     String?
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt

  week      Week          @relation(fields: [weekId], references: [id], onDelete: Restrict)
  questions Question[]
  topics    LessonTopic[]

  @@unique([weekId, order])
  @@index([weekId])
}

// Pregunta: solo cuelga de una Lesson tipo `quiz` (regla validada en servicio,
// ver src/modules/catalog/questions.ts). `content` es lo que ve el alumno;
// `answerSpec` es la respuesta correcta y NUNCA se serializa al cliente (ISSUE-21).
model Question {
  id         String       @id @default(uuid()) @db.Uuid
  lessonId   String       @db.Uuid
  order      Int
  type       QuestionType
  content    Json
  answerSpec Json
  points     Int          @default(0)
  createdAt  DateTime     @default(now())
  updatedAt  DateTime     @updatedAt

  lesson Lesson          @relation(fields: [lessonId], references: [id], onDelete: Restrict)
  topics QuestionTopic[]

  @@unique([lessonId, order])
  @@index([lessonId])
}

// Topic transversal (ej. "Fracciones"): etiqueta lecciones y preguntas sin
// importar la semana. Base de la maestría por topic (ISSUE-28).
model Topic {
  id        String   @id @default(uuid()) @db.Uuid
  name      String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  lessons   LessonTopic[]
  questions QuestionTopic[]
}

// Etiquetado Lesson↔Topic (join explícito). Cascade hacia la lección (el link es
// dato de la lección), Restrict hacia el topic (un topic en uso no se borra,
// ISSUE-16).
model LessonTopic {
  lessonId String @db.Uuid
  topicId  String @db.Uuid

  lesson Lesson @relation(fields: [lessonId], references: [id], onDelete: Cascade)
  topic  Topic  @relation(fields: [topicId], references: [id], onDelete: Restrict)

  @@id([lessonId, topicId])
  @@index([topicId])
}

// Etiquetado Question↔Topic (join explícito). Mismas reglas de borrado que
// LessonTopic.
model QuestionTopic {
  questionId String @db.Uuid
  topicId    String @db.Uuid

  question Question @relation(fields: [questionId], references: [id], onDelete: Cascade)
  topic    Topic    @relation(fields: [topicId], references: [id], onDelete: Restrict)

  @@id([questionId, topicId])
  @@index([topicId])
}
```

Modifica `StudentProfile` para cablear la FK a `Grade`. Reemplaza el bloque del campo `gradeId` y agrega la relación + índice. El campo pasa de columna suelta a FK real:

```prisma
  // Grado asignado. Nullable hasta que el admin lo asigne (Spec §4). FK a Grade
  // con Restrict: no se puede borrar un grado con alumnos asignados (ISSUE-12).
  gradeId           String?   @db.Uuid
```

y dentro del mismo modelo, junto a la relación `family`, agrega:

```prisma
  grade Grade? @relation(fields: [gradeId], references: [id], onDelete: Restrict)
```

y agrega el índice junto a `@@index([familyId])`:

```prisma
  @@index([gradeId])
```

- [ ] **Step 4: Formatear y validar el schema, luego correr el test estático**

Run: `npx prisma format && npx prisma validate && npx vitest run tests/prisma/catalog-schema.test.ts`
Expected: `prisma validate` imprime "The schema is valid"; los 6 tests estáticos PASAN.
(Nota: `prisma validate`/`migrate` requieren `DATABASE_URL` en el entorno — está en `.env`; sin ella fallan con `P1012`.)

- [ ] **Step 5: Generar la migración y el cliente**

Levanta la BD de desarrollo si no está arriba, luego genera la migración:

Run:
```bash
docker compose -f docker-compose.dev.yml up -d
npx prisma migrate dev --name catalog
```
Expected: crea `prisma/migrations/<timestamp>_catalog/migration.sql` con `CREATE TYPE "LessonType"`, `CREATE TYPE "QuestionType"`, `CREATE TABLE` para `Grade`, `Week`, `Lesson`, `Question`, `Topic`, `LessonTopic`, `QuestionTopic`, los índices únicos, y un `ALTER TABLE "StudentProfile" ADD CONSTRAINT ... FOREIGN KEY ("gradeId") REFERENCES "Grade"("id") ... ON DELETE RESTRICT`. Regenera `@prisma/client` con los nuevos modelos. La migración aplica sin error sobre la BD (las filas existentes tienen `gradeId` NULL, así que la nueva FK no rompe nada).

- [ ] **Step 6: Confirmar el round-trip de migraciones sigue verde**

El test existente `tests/prisma/personas-constraints.test.ts` incluye un round-trip que concatena TODAS las migraciones; con Postgres arriba debe seguir pasando (tolerante a tablas nuevas).

Run: `npx vitest run tests/prisma/personas-constraints.test.ts`
Expected: PASS (o auto-skip si no hay Postgres). Si hay Postgres, el round-trip aplica y revierte también las tablas del catálogo dejando 0 tablas y 0 enums.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/prisma/catalog-schema.test.ts
git commit -m "feat(catalog): modelo de datos del catálogo (ISSUE-12)"
```

---

## Task 2: Constraints del catálogo contra la BD

Ejercita contra Postgres real los dos criterios de constraint: `order` único (por semana y por lección) y los borrados `Restrict` de la jerarquía y el etiquetado.

**Files:**
- Create: `tests/prisma/catalog-constraints.test.ts`

**Interfaces:**
- Consumes: los modelos Prisma de la Task 1 (`grade`, `week`, `lesson`, `question`, `topic`, `lessonTopic`) vía `PrismaClient`.

- [ ] **Step 1: Escribir el test de constraints (falla o auto-salta)**

Create `tests/prisma/catalog-constraints.test.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";

// Constraints del catálogo contra una BD PostgreSQL real (Spec §4, ISSUE-12).
// Auto-salta sin Postgres (nada de verde fabricado); corre en CI (ISSUE-04),
// que es la evidencia real de los criterios de aceptación.

function makeClient(): PrismaClient | null {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === "") {
    return null;
  }
  try {
    return new PrismaClient();
  } catch {
    return null;
  }
}

async function probe(client: PrismaClient | null): Promise<boolean> {
  if (!client) return false;
  try {
    await client.$queryRawUnsafe("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

const prisma = makeClient();
const dbAvailable = await probe(prisma);

if (!dbAvailable) {
  console.warn(
    "[catalog-constraints] BD no disponible en DATABASE_URL: se saltan los tests (corren en CI).",
  );
}

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});

const client = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("Catálogo — constraints contra BD", () => {
  test("order duplicado de lecciones en la misma semana falla (único por semana)", async () => {
    const grade = await client.grade.create({
      data: { name: `Grado ${randomUUID()}` },
    });
    const week = await client.week.create({
      data: { gradeId: grade.id, number: 1, title: "Semana 1" },
    });
    const first = await client.lesson.create({
      data: { weekId: week.id, order: 1, type: "video" },
    });
    try {
      await expect(
        client.lesson.create({
          data: { weekId: week.id, order: 1, type: "reading" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    } finally {
      await client.lesson.delete({ where: { id: first.id } });
      await client.week.delete({ where: { id: week.id } });
      await client.grade.delete({ where: { id: grade.id } });
    }
  });

  test("order duplicado de preguntas en la misma lección falla (único por lección)", async () => {
    const grade = await client.grade.create({
      data: { name: `Grado ${randomUUID()}` },
    });
    const week = await client.week.create({
      data: { gradeId: grade.id, number: 1, title: "Semana 1" },
    });
    const lesson = await client.lesson.create({
      data: { weekId: week.id, order: 1, type: "quiz" },
    });
    const first = await client.question.create({
      data: {
        lessonId: lesson.id,
        order: 1,
        type: "true_false",
        content: {},
        answerSpec: {},
      },
    });
    try {
      await expect(
        client.question.create({
          data: {
            lessonId: lesson.id,
            order: 1,
            type: "true_false",
            content: {},
            answerSpec: {},
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    } finally {
      await client.question.delete({ where: { id: first.id } });
      await client.lesson.delete({ where: { id: lesson.id } });
      await client.week.delete({ where: { id: week.id } });
      await client.grade.delete({ where: { id: grade.id } });
    }
  });

  test("borrar un Grade con Weeks falla (FK Restrict, sin cascada)", async () => {
    const grade = await client.grade.create({
      data: { name: `Grado ${randomUUID()}` },
    });
    const week = await client.week.create({
      data: { gradeId: grade.id, number: 1, title: "Semana 1" },
    });
    try {
      await expect(
        client.grade.delete({ where: { id: grade.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
    } finally {
      await client.week.delete({ where: { id: week.id } });
      await client.grade.delete({ where: { id: grade.id } });
    }
  });

  test("borrar una Lesson con Questions falla (FK Restrict)", async () => {
    const grade = await client.grade.create({
      data: { name: `Grado ${randomUUID()}` },
    });
    const week = await client.week.create({
      data: { gradeId: grade.id, number: 1, title: "Semana 1" },
    });
    const lesson = await client.lesson.create({
      data: { weekId: week.id, order: 1, type: "quiz" },
    });
    const question = await client.question.create({
      data: {
        lessonId: lesson.id,
        order: 1,
        type: "true_false",
        content: {},
        answerSpec: {},
      },
    });
    try {
      await expect(
        client.lesson.delete({ where: { id: lesson.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
    } finally {
      await client.question.delete({ where: { id: question.id } });
      await client.lesson.delete({ where: { id: lesson.id } });
      await client.week.delete({ where: { id: week.id } });
      await client.grade.delete({ where: { id: grade.id } });
    }
  });

  test("borrar un Topic etiquetado en una lección falla (FK Restrict, ISSUE-16)", async () => {
    const grade = await client.grade.create({
      data: { name: `Grado ${randomUUID()}` },
    });
    const week = await client.week.create({
      data: { gradeId: grade.id, number: 1, title: "Semana 1" },
    });
    const lesson = await client.lesson.create({
      data: { weekId: week.id, order: 1, type: "video" },
    });
    const topic = await client.topic.create({
      data: { name: `Fracciones ${randomUUID()}` },
    });
    await client.lessonTopic.create({
      data: { lessonId: lesson.id, topicId: topic.id },
    });
    try {
      await expect(
        client.topic.delete({ where: { id: topic.id } }),
      ).rejects.toMatchObject({ code: "P2003" });
    } finally {
      await client.lessonTopic.delete({
        where: { lessonId_topicId: { lessonId: lesson.id, topicId: topic.id } },
      });
      await client.topic.delete({ where: { id: topic.id } });
      await client.lesson.delete({ where: { id: lesson.id } });
      await client.week.delete({ where: { id: week.id } });
      await client.grade.delete({ where: { id: grade.id } });
    }
  });

  test("borrar una Lesson con tags borra sus links pero no el Topic (Cascade→link, Restrict→topic)", async () => {
    const grade = await client.grade.create({
      data: { name: `Grado ${randomUUID()}` },
    });
    const week = await client.week.create({
      data: { gradeId: grade.id, number: 1, title: "Semana 1" },
    });
    const lesson = await client.lesson.create({
      data: { weekId: week.id, order: 1, type: "video" },
    });
    const topic = await client.topic.create({
      data: { name: `Álgebra ${randomUUID()}` },
    });
    await client.lessonTopic.create({
      data: { lessonId: lesson.id, topicId: topic.id },
    });
    try {
      // Borrar la lección (sin questions) arrastra su link de topic (Cascade)...
      await client.lesson.delete({ where: { id: lesson.id } });
      const links = await client.lessonTopic.findMany({
        where: { topicId: topic.id },
      });
      expect(links).toHaveLength(0);
      // ...pero el Topic sigue vivo.
      const stillThere = await client.topic.findUnique({
        where: { id: topic.id },
      });
      expect(stillThere).not.toBeNull();
    } finally {
      await client.topic.delete({ where: { id: topic.id } });
      await client.week.delete({ where: { id: week.id } });
      await client.grade.delete({ where: { id: grade.id } });
    }
  });
});
```

- [ ] **Step 2: Correr el test con Postgres arriba**

Run: `docker compose -f docker-compose.dev.yml up -d && npx prisma migrate deploy && npx vitest run tests/prisma/catalog-constraints.test.ts`
Expected: los 6 tests PASAN (no auto-skip). Si no hubiera Postgres, verías el warning de auto-skip; para cerrar el issue con evidencia real deben ejecutarse (localmente con Docker o en CI).

- [ ] **Step 3: Commit**

```bash
git add tests/prisma/catalog-constraints.test.ts
git commit -m "test(catalog): constraints de order único y borrado Restrict (ISSUE-12)"
```

---

## Task 3: Guard de servicio "Question solo bajo Lesson quiz"

Implementa la regla que la DB no puede expresar: una pregunta solo cuelga de una lección tipo `quiz`. Función pura, sin HTTP ni BD; ISSUE-15 la invocará antes de crear preguntas.

**Files:**
- Create: `src/modules/catalog/questions.ts`
- Create: `tests/catalog/question-guard.test.ts`

**Interfaces:**
- Produces: `assertLessonAcceptsQuestions(lesson: { type: LessonType }): void` — no retorna nada; lanza `AppError("VALIDATION_ERROR", ...)` si `lesson.type !== "quiz"`. Consumida por ISSUE-15 (CRUD de preguntas).
- Consumes: `LessonType` de `@prisma/client`; `AppError` de `src/plugins/errors.ts`.

- [ ] **Step 1: Escribir el test unitario del guard (falla)**

Create `tests/catalog/question-guard.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { assertLessonAcceptsQuestions } from "../../src/modules/catalog/questions.js";
import { AppError } from "../../src/plugins/errors.js";

// Regla de servicio (Spec §4, criterio ISSUE-12): una Question solo puede colgar
// de una Lesson tipo `quiz`. La DB no puede expresar "el tipo de la fila padre",
// así que se valida acá; ISSUE-15 la usa antes de crear cada pregunta.

describe("assertLessonAcceptsQuestions", () => {
  test("una lección quiz acepta preguntas (no lanza)", () => {
    expect(() => assertLessonAcceptsQuestions({ type: "quiz" })).not.toThrow();
  });

  test.each(["video", "reading"] as const)(
    "una lección %s rechaza preguntas con VALIDATION_ERROR",
    (type) => {
      let thrown: unknown;
      try {
        assertLessonAcceptsQuestions({ type });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AppError);
      expect((thrown as AppError).code).toBe("VALIDATION_ERROR");
    },
  );
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run tests/catalog/question-guard.test.ts`
Expected: FAIL — no se puede resolver el módulo `src/modules/catalog/questions.js` (aún no existe).

- [ ] **Step 3: Implementar el guard**

Create `src/modules/catalog/questions.ts`:

```typescript
// Reglas de dominio de las preguntas del catálogo (Spec §4). Sin acoplarse a
// Fastify ni a Prisma: funciones puras que el CRUD (ISSUE-15) invoca.

import type { LessonType } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";

/**
 * Una Question solo puede colgar de una Lesson tipo `quiz` (criterio ISSUE-12).
 * PostgreSQL no puede restringir por el tipo de la fila padre, así que la regla
 * se valida en la capa de servicio antes de crear la pregunta.
 *
 * Lanza `AppError("VALIDATION_ERROR")` si la lección no es un quiz.
 */
export function assertLessonAcceptsQuestions(lesson: {
  type: LessonType;
}): void {
  if (lesson.type !== "quiz") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Solo las lecciones de tipo quiz pueden tener preguntas.",
    );
  }
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npx vitest run tests/catalog/question-guard.test.ts`
Expected: PASS (3 casos: quiz + video + reading).

- [ ] **Step 5: Commit**

```bash
git add src/modules/catalog/questions.ts tests/catalog/question-guard.test.ts
git commit -m "feat(catalog): guard de que las preguntas solo cuelgan de lecciones quiz (ISSUE-12)"
```

---

## Task 4: Verificación final (Definition of Done)

Corre la suite completa y las verificaciones estáticas antes de abrir el PR.

**Files:** —

- [ ] **Step 1: Suite completa, lint, typecheck y build**

Run: `npx vitest run && npm run lint && npm run typecheck && npm run build`
Expected: todos los tests en verde (los de constraints del catálogo corren si hay Postgres arriba, se auto-saltan si no); `lint`, `typecheck` y `build` sin errores.

- [ ] **Step 2: Abrir el PR**

Crea la rama de la tarea si no existe (una rama por issue) y abre el PR hacia `main`. Entregar el link y parar; el usuario verifica el CI. (Sin footer de atribución de Claude en commits ni PR.)

---

## Self-Review (autor del plan)

**Spec coverage (criterios de aceptación de ISSUE-12):**
- "Constraint: Question solo puede colgar de Lesson tipo quiz, validado en capa de servicio con test" → Task 3 (`assertLessonAcceptsQuestions` + `tests/catalog/question-guard.test.ts`). ✔
- "order único por semana (lecciones) y por lección (preguntas)" → schema `@@unique([weekId, order])` / `@@unique([lessonId, order])` (Task 1) + tests de BD (Task 2). ✔
- Modelos del issue (`Grade`, `Week`, `Lesson` con campos por tipo, `Question` content/answerSpec JSON + points, `Topic`, tablas Lesson↔Topic y Question↔Topic) → Task 1. ✔
- DoD: validación JSON Schema por ruta / errores `{ error: { code, message } }` — **no aplica**: este issue no agrega rutas HTTP (llegan en ISSUE-13/14/15). El único error de dominio (`VALIDATION_ERROR`) usa el catálogo `ErrorCode`. ✔
- DoD: CI en verde, commits descriptivos → Task 4. ✔

**Placeholder scan:** sin TBD/TODO; todo el código de tests e implementación está completo. La única pieza generada (no escrita a mano) es el `migration.sql`, producto determinista de `prisma migrate dev` sobre el schema de la Task 1. ✔

**Type consistency:** `assertLessonAcceptsQuestions({ type: LessonType })` usa los literales del enum `LessonType` (`video`/`reading`/`quiz`) consistentes entre schema, tests y guard. `content`/`answerSpec` son `Json` (Prisma) y se pasan `{}` en los tests de BD. Claves de índice único referenciadas en los `delete` compuestos (`lessonId_topicId`) coinciden con `@@id([lessonId, topicId])`. ✔
