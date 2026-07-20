# ISSUE-36 — Modelo de materias, cursos e inscripción — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline), task por task.

**Goal:** Migrar el catálogo de `Grade → Week` a `Subject × Grade = Course → Week`, agregar prerrequisitos e inscripción (`StudentSubject`), y **mantener verde** todo el código/tests de M2 bajo el nuevo modelo. **No** agrega endpoints nuevos de materias/cursos (eso es ISSUE-37).

**Architecture:** Catálogo **vacío** → la migración reestructura sin migrar datos. `Week` pasa a colgar de `Course` (rompe el CRUD de semanas y varios tests de M2, que se actualizan acá para compilar/pasar). `Grade` pasa a ser el **año/nivel** (se le agrega `level`); `Course = Subject × Grade`.

**Tech Stack:** Prisma · PostgreSQL · Vitest.

Diseño aprobado: `docs/superpowers/specs/2026-07-19-milestone-2.5-subjects-courses-enrollment.md`. Issue: `Issues.MD` ISSUE-36.

## Global Constraints

- TDD, commits por task, DoD. Filosofía `onDelete: Restrict` sobre la jerarquía; borrar en uso → rechazo.
- Migración offline (catálogo vacío): `prisma migrate diff` schema viejo→nuevo; verificar contra Postgres real (Task 5).
- Tests de BD auto-saltables; ESM `.js`. **El build/CI debe quedar verde** (typecheck + lint + tests).

## File Structure

- **Modify:** `prisma/schema.prisma` — `Subject`, `Course`, `CoursePrerequisite`, `StudentSubject`; `Grade.level`; `Grade.weeks`→`Grade.courses`; `Week.gradeId`→`Week.courseId`; `StudentProfile.subjects`.
- **Create:** `prisma/migrations/<ts>_subjects_courses/migration.sql`.
- **Modify:** `tests/prisma/catalog-schema.test.ts`, `tests/prisma/schema.test.ts` — aserciones del nuevo modelo.
- **Modify:** `src/modules/catalog/routes.ts` — CRUD de semanas re-anclado a `courseId`; borrado de grado (ahora bloquea por cursos/alumnos).
- **Modify:** `tests/prisma/catalog-constraints.test.ts`, `tests/catalog/{weeks,lessons,questions,topics,grades}.integration.test.ts` — crear semanas bajo un `Course`.
- **Create:** `tests/prisma/subjects-courses-constraints.test.ts` — constraints del nuevo modelo (DB).

---

## Task 1: Schema + migración

**Interfaces (producidas):**
- `Subject { id, name @unique, courses, students }`
- `Grade { id, name, level Int @unique, courses Course[], students StudentProfile[] }`
- `Course { id, subjectId, gradeId, title, description?, weeks, @@unique([subjectId, gradeId]) }`
- `CoursePrerequisite { courseId, requiresCourseId, @@id([courseId, requiresCourseId]) }`
- `StudentSubject { studentProfileId, subjectId, @@id([studentProfileId, subjectId]) }`
- `Week { ..., courseId, @@unique([courseId, number]) }`

- [ ] **Step 1: Actualizar los tests estáticos (fallan)**

En `tests/prisma/catalog-schema.test.ts`:
- Test de `Week`: cambiar `gradeId`→`courseId` en las aserciones (`/courseId\s+String/`, `@@unique([courseId, number])`, relación `onDelete: Restrict` sobre `[courseId]`).
- Agregar aserciones: existe `model Subject` con `name String @unique`; `model Course` con `@@unique([subjectId, gradeId])` y FKs `Restrict` a Subject/Grade; `model CoursePrerequisite` con `@@id([courseId, requiresCourseId])`; `model StudentSubject` con `@@id([studentProfileId, subjectId])`; `Grade` con `level Int` (`@unique`).

En `tests/prisma/schema.test.ts` (Personas): si asertaba algo de `Grade`/`Week`, ajustar (`StudentProfile.gradeId` sigue nullable = "año actual").

- [ ] **Step 2: Correr → falla.** `npx vitest run tests/prisma/catalog-schema.test.ts tests/prisma/schema.test.ts`

- [ ] **Step 3: Editar `prisma/schema.prisma`**

Agregar los modelos nuevos y modificar los existentes:

```prisma
// Materia transversal a los años (Matemáticas, Ciencias…). Milestone 2.5.
model Subject {
  id        String   @id @default(uuid()) @db.Uuid
  name      String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  courses  Course[]
  students StudentSubject[]
}

// Curso = materia × año (ej. "Matemáticas 3°"): unidad de contenido y de XP.
model Course {
  id          String   @id @default(uuid()) @db.Uuid
  subjectId   String   @db.Uuid
  gradeId     String   @db.Uuid
  title       String
  description String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  subject Subject @relation(fields: [subjectId], references: [id], onDelete: Restrict)
  grade   Grade   @relation(fields: [gradeId], references: [id], onDelete: Restrict)
  weeks   Week[]
  // Prerrequisitos de ESTE curso (aristas salientes) y los que lo requieren.
  prerequisites CoursePrerequisite[] @relation("CourseToPrereq")
  requiredBy    CoursePrerequisite[] @relation("PrereqToCourse")

  @@unique([subjectId, gradeId])
  @@index([subjectId])
  @@index([gradeId])
}

// Prerrequisito curso→curso (definido por el admin, estilo Moodle). Cascade
// hacia el curso dueño de la arista; Restrict hacia el curso requerido (no se
// puede borrar un curso del que otro depende).
model CoursePrerequisite {
  courseId         String @db.Uuid
  requiresCourseId String @db.Uuid

  course   Course @relation("CourseToPrereq", fields: [courseId], references: [id], onDelete: Cascade)
  requires Course @relation("PrereqToCourse", fields: [requiresCourseId], references: [id], onDelete: Restrict)

  @@id([courseId, requiresCourseId])
  @@index([requiresCourseId])
}

// Inscripción del alumno a una materia. Cascade hacia el alumno; Restrict hacia
// la materia (no borrar una materia en uso).
model StudentSubject {
  studentProfileId String @db.Uuid
  subjectId        String @db.Uuid

  student StudentProfile @relation(fields: [studentProfileId], references: [id], onDelete: Cascade)
  subject Subject        @relation(fields: [subjectId], references: [id], onDelete: Restrict)

  @@id([studentProfileId, subjectId])
  @@index([subjectId])
}
```

En `model Grade`: agregar `level Int @unique` (para ordenar años) y cambiar la relación `weeks Week[]` por `courses Course[]`.

En `model Week`: cambiar `gradeId` → `courseId` (`@db.Uuid`), la relación `grade Grade @relation(..., [gradeId], ...)` por `course Course @relation(..., [courseId], ..., onDelete: Restrict)`, `@@unique([gradeId, number])` → `@@unique([courseId, number])`, `@@index([gradeId])` → `@@index([courseId])`.

En `model StudentProfile`: agregar `subjects StudentSubject[]`. El comentario de `gradeId` pasa a "año actual del alumno (Milestone 2.5)".

- [ ] **Step 4: Formatear/validar + tests estáticos verdes**

`npx prisma format && DATABASE_URL="postgresql://u:u@localhost:5432/db" npx prisma validate && npx vitest run tests/prisma/catalog-schema.test.ts tests/prisma/schema.test.ts`

- [ ] **Step 5: Generar migración (offline) + cliente**

```bash
OLD="/tmp/old-36.prisma"; git show HEAD:prisma/schema.prisma > "$OLD"
TS=$(date +%Y%m%d%H%M%S); DIR="prisma/migrations/${TS}_subjects_courses"; mkdir -p "$DIR"
npx prisma migrate diff --from-schema-datamodel "$OLD" --to-schema-datamodel prisma/schema.prisma --script > "$DIR/migration.sql"
DATABASE_URL="postgresql://u:u@localhost:5432/db" npx prisma generate
cat "$DIR/migration.sql"
```

Revisar el SQL: crea Subject/Course/CoursePrerequisite/StudentSubject, agrega `Grade.level`, dropea la FK/columna vieja `Week.gradeId` y agrega `Week.courseId`. **Catálogo vacío → el drop+add de `Week.gradeId`/`courseId` es seguro (sin datos).** Si `ADD COLUMN "level" INTEGER NOT NULL` falla por filas existentes en `Grade` (no debería, catálogo vacío), agregar un default temporal. Verificar en Task 5.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/prisma/catalog-schema.test.ts tests/prisma/schema.test.ts
git commit -m "feat(catalog): modelo materias/cursos/inscripción; Week cuelga de Course (ISSUE-36)"
```

---

## Task 2: Re-anclar el CRUD de semanas a `courseId`

**Files:** Modify `src/modules/catalog/routes.ts`, `tests/catalog/weeks.integration.test.ts`.

- [ ] **Step 1: `catalog/routes.ts` — semanas**

En los schemas/tipos/select de semanas, reemplazar `gradeId` por `courseId`:
- `createWeekBodySchema`: `required: ["courseId", "number", "title"]`, `courseId: { type: "string", pattern: UUID_PATTERN }`.
- `weeksQuerySchema`: `courseId` en vez de `gradeId`.
- `interface CreateWeekBody` / `WeeksQuery`: `courseId`.
- `weekSelect`: `courseId: true` (en vez de `gradeId`).
- Handler `GET /admin/weeks`: filtrar por `courseId`; `orderBy: [{ courseId: "asc" }, { number: "asc" }]`.
- El mensaje de `P2003` en create de semana: "El curso indicado no existe." (era "El grado…").

En el **borrado de grado** (`DELETE /admin/grades/:id`): el mensaje de `mapDeleteRestrict` pasa a "No se puede borrar el grado: tiene cursos o alumnos asociados." (Grade ya no tiene weeks directas; tiene courses + students, ambos Restrict.)

- [ ] **Step 2: `tests/catalog/weeks.integration.test.ts`**

En `beforeAll`, además del grade crear una **materia y un curso**, y usar `courseId` para las semanas:

```typescript
// beforeAll (tras crear el grade):
const subject = await db.subject.create({ data: { name: `Mat-${emailTag}` } });
const course = await db.course.create({
  data: { subjectId: subject.id, gradeId, title: `Matemáticas ${emailTag}` },
});
courseId = course.id;
```
Reemplazar en todos los casos `{ gradeId, number, title }` → `{ courseId, number, title }` y `?gradeId=` → `?courseId=`. En `afterAll`, borrar en orden lesson → week → course → subject → grade → family → users. `db.grade.create` ahora necesita `level` (agregar `level: <n>` único por test, p. ej. derivado del tag o un contador).

- [ ] **Step 3: typecheck/lint + commit**

`npm run typecheck && npm run format && npm run lint`

```bash
git add src/modules/catalog/routes.ts tests/catalog/weeks.integration.test.ts
git commit -m "refactor(catalog): CRUD de semanas re-anclado a courseId (ISSUE-36)"
```

---

## Task 3: Actualizar los demás tests que crean semanas

Los tests de integración que en `beforeAll` crean `grade → week` ahora deben crear `grade → subject → course → week`. Aplicar el **mismo patrón** de Task 2 Step 2 a cada uno:

- [ ] **Step 1:** `tests/prisma/catalog-constraints.test.ts` — donde crea weeks con `gradeId`, crear un `subject`+`course` y usar `courseId`. El test "borrar Grade con Weeks → P2003" pasa a "borrar Grade con Courses → P2003" (o borrar Course con Weeks → P2003). Ajustar. `grade.create` con `level`.
- [ ] **Step 2:** `tests/catalog/lessons.integration.test.ts`, `tests/catalog/questions.integration.test.ts`, `tests/catalog/topics.integration.test.ts` — en `beforeAll`, insertar `subject`+`course` y crear la `week` con `courseId`. `grade.create` con `level`.
- [ ] **Step 3:** `tests/catalog/grades.integration.test.ts` — el caso "borrar un grado con semanas → CONFLICT" pasa a "grado con **cursos** → CONFLICT" (crear un course en el grade en vez de una week). `grade.create` con `level`. Los POST de grado del CRUD ahora requieren `level` en el body → agregar `level` al `createGradeBodySchema`/`updateGradeBodySchema` y al test. *(Nota: esto agrega `level` al CRUD de grados; es parte del keep-green.)*
- [ ] **Step 4:** typecheck/lint; correr toda la suite (auto-skip sin BD) para confirmar que compila y no hay regresiones estáticas.

`npm run typecheck && npm run lint && npx vitest run`

```bash
git add tests/prisma/catalog-constraints.test.ts tests/catalog/lessons.integration.test.ts tests/catalog/questions.integration.test.ts tests/catalog/topics.integration.test.ts tests/catalog/grades.integration.test.ts src/modules/catalog/routes.ts
git commit -m "test(catalog): crear semanas bajo Course en los tests de integración (ISSUE-36)"
```

> Nota: `createGradeBodySchema` gana `level` (Int, requerido) — es el mínimo para que el CRUD de grados siga coherente con el nuevo modelo. El CRUD de materias/cursos completo es ISSUE-37.

---

## Task 4: Constraints del nuevo modelo (DB)

**Files:** Create `tests/prisma/subjects-courses-constraints.test.ts` (patrón auto-skip).

- [ ] **Step 1: Escribir el test** (casos):
  - `Subject.name` único → duplicado P2002.
  - `Course` único por `(subjectId, gradeId)` → duplicado P2002.
  - Borrar un `Subject` con cursos → P2003 (Restrict); con `StudentSubject` → P2003.
  - Borrar un `Course` con weeks → P2003; borrar un `Course` **requerido por otro** (CoursePrerequisite.requires Restrict) → P2003; borrar el curso **dueño** de la arista (CourseToPrereq Cascade) → limpia sus prereqs.
  - `StudentSubject` único por `(studentProfileId, subjectId)`; borrar el alumno cascada sus inscripciones.

- [ ] **Step 2: Commit**

```bash
git add tests/prisma/subjects-courses-constraints.test.ts
git commit -m "test(catalog): constraints de materias, cursos, prereqs e inscripción (ISSUE-36)"
```

---

## Task 5: Verificación final (con BD) + PR

- [ ] **Step 1:** Postgres desechable (5433) + `migrate deploy`. **Verificar que la migración de reestructuración aplica** (drop `Week.gradeId` + add `courseId`, `Grade.level`, tablas nuevas). Si algo falla, ajustar el `migration.sql`.
- [ ] **Step 2:** `DATABASE_URL=... npx vitest run` → todo verde (incluye el round-trip de migración, que ahora reestructura el catálogo).
- [ ] **Step 3:** `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 4:** limpiar contenedor; commitear el plan; `git push`; PR hacia `main`; link y parar. Sin footer.

---

## Self-Review

- Modelo materias/cursos/inscripción + `Week` bajo `Course` → Task 1. ✔
- Build/CI verde bajo el nuevo modelo (weeks CRUD + todos los tests re-anclados) → Tasks 2, 3. ✔
- Constraints del nuevo modelo (unicidad, prereqs cascade/restrict, inscripción) → Task 4. ✔
- Migración limpia sobre catálogo vacío (sin migrar datos) → Task 1 Step 5, verificada en Task 5. ✔
- **No** incluye endpoints nuevos de materias/cursos (ISSUE-37) ni inscripción vía familias (ISSUE-38). ✔
- Riesgo: `ADD COLUMN Grade.level NOT NULL` y drop/add de `Week` — verificar aplican en Task 5 (catálogo vacío, debería). ✔
