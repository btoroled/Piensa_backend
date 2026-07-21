import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Inscripción del alumno (ISSUE-38) end-to-end contra Postgres real: promover de
// año, materias (individual + bulk), cursos accesibles "para abajo". Auto-salta
// sin BD; corre en CI.

const SECRET = "test-secret-at-least-16-chars-long";

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
  console.warn(
    "[students] BD no disponible: se saltan los tests (corren en CI).",
  );
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("inscripción del alumno", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let parentToken: string;
  let studentId: string;
  let subA: string;
  let subB: string;
  let grade1: string;
  let grade2: string;
  let grade3: string;
  let courseA1: string;
  let courseA2: string;
  let courseA3: string;
  const tag = `st38-${randomUUID()}`;

  beforeAll(async () => {
    app = buildApp({ jwtSecret: SECRET, prisma: db });
    await app.ready();
    const admin = await db.user.create({
      data: {
        email: `ad-${tag}@piensa.test`,
        passwordHash: "x",
        role: "admin",
      },
    });
    adminToken = await createAccessToken(SECRET, {
      userId: admin.id,
      role: "admin",
    });
    const parent = await db.user.create({
      data: {
        email: `pa-${tag}@piensa.test`,
        passwordHash: "x",
        role: "parent",
      },
    });
    const fam = await db.family.create({
      data: { name: `Fam-${tag}`, parentUserId: parent.id },
    });
    parentToken = await createAccessToken(SECRET, {
      userId: parent.id,
      role: "parent",
      familyId: fam.id,
    });
    const student = await db.studentProfile.create({
      data: { familyId: fam.id, name: "Ana", avatar: "fox", pinHash: "x" },
    });
    studentId = student.id;
    const [sa, sb] = await Promise.all([
      db.subject.create({ data: { name: `A-${tag}` } }),
      db.subject.create({ data: { name: `B-${tag}` } }),
    ]);
    subA = sa.id;
    subB = sb.id;
    // Niveles con offset: garantiza 1 < 2 < 3 (para el "para abajo") y unicidad
    // global (base aleatoria).
    const base = Math.floor(Math.random() * 1_000_000_000);
    const [g1, g2, g3] = await Promise.all([
      db.grade.create({ data: { name: `1-${tag}`, level: base } }),
      db.grade.create({ data: { name: `2-${tag}`, level: base + 1 } }),
      db.grade.create({ data: { name: `3-${tag}`, level: base + 2 } }),
    ]);
    grade1 = g1.id;
    grade2 = g2.id;
    grade3 = g3.id;
    const [ca1, ca2, ca3] = await Promise.all([
      db.course.create({
        data: { subjectId: subA, gradeId: grade1, title: "A1" },
      }),
      db.course.create({
        data: { subjectId: subA, gradeId: grade2, title: "A2" },
      }),
      db.course.create({
        data: { subjectId: subA, gradeId: grade3, title: "A3" },
      }),
    ]);
    courseA1 = ca1.id;
    courseA2 = ca2.id;
    courseA3 = ca3.id;
  });

  afterAll(async () => {
    await db.studentSubject.deleteMany({
      where: { studentProfileId: studentId },
    });
    await db.course.deleteMany({
      where: { id: { in: [courseA1, courseA2, courseA3] } },
    });
    await db.studentProfile.deleteMany({ where: { id: studentId } });
    await db.subject.deleteMany({ where: { name: { contains: tag } } });
    await db.grade.deleteMany({
      where: { id: { in: [grade1, grade2, grade3] } },
    });
    await db.family.deleteMany({ where: { name: `Fam-${tag}` } });
    await db.user.deleteMany({ where: { email: { contains: tag } } });
    await app.close();
    await db.$disconnect();
  });

  const call = (method: string, path: string, token?: string, body?: unknown) =>
    app.inject({
      method: method as "POST",
      url: `/api/v1${path}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body ? { payload: body as object } : {}),
    });

  test("promover de año (PATCH gradeId); grado inexistente → VALIDATION_ERROR", async () => {
    const ok = await call("PATCH", `/admin/students/${studentId}`, adminToken, {
      gradeId: grade2,
    });
    expect(ok.json().data.gradeId).toBe(grade2);
    const bad = await call(
      "PATCH",
      `/admin/students/${studentId}`,
      adminToken,
      {
        gradeId: randomUUID(),
      },
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("inscribir materia (idempotente); inexistente → VALIDATION_ERROR; listar", async () => {
    expect(
      (
        await call(
          "POST",
          `/admin/students/${studentId}/subjects`,
          adminToken,
          {
            subjectId: subA,
          },
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call(
          "POST",
          `/admin/students/${studentId}/subjects`,
          adminToken,
          {
            subjectId: subA,
          },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          "POST",
          `/admin/students/${studentId}/subjects`,
          adminToken,
          {
            subjectId: randomUUID(),
          },
        )
      ).statusCode,
    ).toBe(400);
    const list = await call(
      "GET",
      `/admin/students/${studentId}/subjects`,
      adminToken,
    );
    expect(list.json().data.map((s: { id: string }) => s.id)).toEqual([subA]);
  });

  test("bulk PUT reemplaza la inscripción; materia mala → nada cambia", async () => {
    const ok = await call(
      "PUT",
      `/admin/students/${studentId}/subjects`,
      adminToken,
      {
        subjectIds: [subA, subB],
      },
    );
    expect(ok.json().data).toHaveLength(2);
    const bad = await call(
      "PUT",
      `/admin/students/${studentId}/subjects`,
      adminToken,
      {
        subjectIds: [randomUUID()],
      },
    );
    expect(bad.statusCode).toBe(400);
    const still = await call(
      "GET",
      `/admin/students/${studentId}/subjects`,
      adminToken,
    );
    expect(still.json().data).toHaveLength(2);
  });

  test("cursos accesibles 'para abajo': materias inscritas × level ≤ año actual", async () => {
    await call("PATCH", `/admin/students/${studentId}`, adminToken, {
      gradeId: grade2,
    });
    await call("PUT", `/admin/students/${studentId}/subjects`, adminToken, {
      subjectIds: [subA],
    });
    const res = await call(
      "GET",
      `/admin/students/${studentId}/courses`,
      adminToken,
    );
    const ids = res.json().data.map((c: { id: string }) => c.id);
    expect(ids).toContain(courseA1);
    expect(ids).toContain(courseA2);
    expect(ids).not.toContain(courseA3);
  });

  test("desinscribir; no-admin → FORBIDDEN; alumno inexistente → NOT_FOUND", async () => {
    expect(
      (
        await call(
          "DELETE",
          `/admin/students/${studentId}/subjects/${subA}`,
          adminToken,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await call("GET", `/admin/students/${studentId}`, parentToken))
        .statusCode,
    ).toBe(403);
    expect(
      (await call("GET", `/admin/students/${randomUUID()}`, adminToken))
        .statusCode,
    ).toBe(404);
  });
});
