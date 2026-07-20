import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// CRUD /admin/subjects y /admin/courses + prerrequisitos, end-to-end contra
// Postgres real (ISSUE-37). Auto-salta sin BD; corre en CI.

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
    "[subjects-courses] BD no disponible: se saltan los tests (corren en CI).",
  );
const db = prisma as PrismaClient;
const bigLevel = () => Math.floor(Math.random() * 2_000_000_000);

describe.skipIf(!dbAvailable)("CRUD /admin/subjects y /admin/courses", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let parentToken: string;
  let subjectId: string;
  let courseId: string;
  let grade1: string;
  let grade2: string;
  let grade3: string;
  const courseIds: string[] = [];
  const tag = `sc37-${randomUUID()}`;

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
    const [g1, g2, g3] = await Promise.all([
      db.grade.create({ data: { name: `1-${tag}`, level: bigLevel() } }),
      db.grade.create({ data: { name: `2-${tag}`, level: bigLevel() } }),
      db.grade.create({ data: { name: `3-${tag}`, level: bigLevel() } }),
    ]);
    grade1 = g1.id;
    grade2 = g2.id;
    grade3 = g3.id;
  });

  afterAll(async () => {
    await db.week.deleteMany({ where: { courseId: { in: courseIds } } });
    await db.coursePrerequisite.deleteMany({
      where: { courseId: { in: courseIds } },
    });
    await db.coursePrerequisite.deleteMany({
      where: { requiresCourseId: { in: courseIds } },
    });
    await db.course.deleteMany({ where: { id: { in: courseIds } } });
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

  test("crear/leer/actualizar materia; nombre duplicado → CONFLICT", async () => {
    const c = await call("POST", "/admin/subjects", adminToken, {
      name: `Mat-${tag}`,
    });
    expect(c.statusCode).toBe(201);
    subjectId = c.json().data.id;
    const r = await call("GET", `/admin/subjects/${subjectId}`, adminToken);
    expect(r.json().data.name).toBe(`Mat-${tag}`);
    const dup = await call("POST", "/admin/subjects", adminToken, {
      name: `Mat-${tag}`,
    });
    expect(dup.statusCode).toBe(409);
  });

  test("crear curso; duplicado (materia,año) → CONFLICT; subject/grade malo → VALIDATION_ERROR", async () => {
    const ok = await call("POST", "/admin/courses", adminToken, {
      subjectId,
      gradeId: grade3,
      title: "Mat 3°",
    });
    expect(ok.statusCode).toBe(201);
    courseId = ok.json().data.id;
    courseIds.push(courseId);
    const dup = await call("POST", "/admin/courses", adminToken, {
      subjectId,
      gradeId: grade3,
      title: "Otro",
    });
    expect(dup.statusCode).toBe(409);
    const bad = await call("POST", "/admin/courses", adminToken, {
      subjectId: randomUUID(),
      gradeId: grade3,
      title: "X",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("VALIDATION_ERROR");
  });

  test("PATCH curso (title); borrar curso con semanas → CONFLICT", async () => {
    const upd = await call("PATCH", `/admin/courses/${courseId}`, adminToken, {
      title: "Mat 3° A",
    });
    expect(upd.json().data.title).toBe("Mat 3° A");
    await db.week.create({ data: { courseId, number: 1, title: "S1" } });
    const del = await call("DELETE", `/admin/courses/${courseId}`, adminToken);
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("CONFLICT");
  });

  test("borrar materia en uso (con cursos) → CONFLICT", async () => {
    const del = await call(
      "DELETE",
      `/admin/subjects/${subjectId}`,
      adminToken,
    );
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe("CONFLICT");
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/subjects", parentToken, {
      name: "X",
    });
    expect(res.statusCode).toBe(403);
  });

  test("prerrequisitos: agregar, listar, idempotente, self y ciclo", async () => {
    const s = (
      await call("POST", "/admin/subjects", adminToken, { name: `Sub-${tag}` })
    ).json().data.id;
    const c1 = (
      await call("POST", "/admin/courses", adminToken, {
        subjectId: s,
        gradeId: grade1,
        title: "1°",
      })
    ).json().data.id;
    const c2 = (
      await call("POST", "/admin/courses", adminToken, {
        subjectId: s,
        gradeId: grade2,
        title: "2°",
      })
    ).json().data.id;
    const c3 = (
      await call("POST", "/admin/courses", adminToken, {
        subjectId: s,
        gradeId: grade3,
        title: "3°",
      })
    ).json().data.id;
    courseIds.push(c1, c2, c3);

    // 2° requiere 1°, 3° requiere 2°.
    expect(
      (
        await call("POST", `/admin/courses/${c2}/prerequisites`, adminToken, {
          requiresCourseId: c1,
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await call("POST", `/admin/courses/${c3}/prerequisites`, adminToken, {
          requiresCourseId: c2,
        })
      ).statusCode,
    ).toBe(201);
    // Idempotente.
    expect(
      (
        await call("POST", `/admin/courses/${c2}/prerequisites`, adminToken, {
          requiresCourseId: c1,
        })
      ).statusCode,
    ).toBe(200);
    // Listar 3° → [2°].
    const list = await call(
      "GET",
      `/admin/courses/${c3}/prerequisites`,
      adminToken,
    );
    expect(list.json().data.map((x: { id: string }) => x.id)).toEqual([c2]);
    // Self-prereq → VALIDATION_ERROR.
    expect(
      (
        await call("POST", `/admin/courses/${c1}/prerequisites`, adminToken, {
          requiresCourseId: c1,
        })
      ).statusCode,
    ).toBe(400);
    // Ciclo: 1° requiere 3° (3°→2°→1°) → VALIDATION_ERROR.
    const cyc = await call(
      "POST",
      `/admin/courses/${c1}/prerequisites`,
      adminToken,
      { requiresCourseId: c3 },
    );
    expect(cyc.statusCode).toBe(400);
    expect(cyc.json().error.code).toBe("VALIDATION_ERROR");
    // Quitar el prereq de 3°.
    expect(
      (
        await call(
          "DELETE",
          `/admin/courses/${c3}/prerequisites/${c2}`,
          adminToken,
        )
      ).statusCode,
    ).toBe(200);
  });
});
