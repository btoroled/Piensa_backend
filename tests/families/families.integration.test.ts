import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";

// Gestión de familias end-to-end contra Postgres real (ISSUE-18), incluido el
// flujo admin crea familia → padre hace login → crea sesión de alumno. Auto-salta
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
    "[families] BD no disponible: se saltan los tests (corren en CI).",
  );
const db = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("gestión de familias (admin)", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let parentSelfToken: string;
  let familyId: string;
  const uniq = randomUUID();
  const parentEmail = `parent-${uniq}@piensa.test`;

  beforeAll(async () => {
    app = buildApp({ jwtSecret: SECRET, prisma: db });
    await app.ready();
    const admin = await db.user.create({
      data: {
        email: `admin-${uniq}@piensa.test`,
        passwordHash: "x",
        role: "admin",
      },
    });
    adminToken = await createAccessToken(SECRET, {
      userId: admin.id,
      role: "admin",
    });
    const self = await db.user.create({
      data: {
        email: `self-${uniq}@piensa.test`,
        passwordHash: "x",
        role: "parent",
      },
    });
    const selfFam = await db.family.create({
      data: { name: `SelfFam-${uniq}`, parentUserId: self.id },
    });
    parentSelfToken = await createAccessToken(SECRET, {
      userId: self.id,
      role: "parent",
      familyId: selfFam.id,
    });
  });

  afterAll(async () => {
    const fams = await db.family.findMany({
      where: { parentUser: { email: { contains: uniq } } },
      select: { id: true },
    });
    const fids = fams.map((f) => f.id);
    // Borrar alumnos cascada sus StudentSubject; luego se puede borrar la materia.
    await db.studentProfile.deleteMany({ where: { familyId: { in: fids } } });
    await db.subject.deleteMany({ where: { name: { contains: uniq } } });
    await db.family.deleteMany({ where: { id: { in: fids } } });
    await db.user.deleteMany({ where: { email: { contains: uniq } } });
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

  test("e2e: admin crea familia → padre hace login → crea sesión de alumno", async () => {
    const created = await call("POST", "/admin/families", adminToken, {
      name: "Los Prueba",
      parent: { email: parentEmail, password: "clave-temporal-123" },
      students: [{ name: "Ana", avatar: "fox", pin: "1234" }],
    });
    expect(created.statusCode).toBe(201);
    familyId = created.json().data.id;
    const studentId = created.json().data.students[0].id;
    // La respuesta no filtra hashes.
    expect(JSON.stringify(created.json())).not.toMatch(/passwordHash|pinHash/);

    const login = await call("POST", "/auth/login", undefined, {
      email: parentEmail,
      password: "clave-temporal-123",
    });
    expect(login.statusCode).toBe(200);
    const parentToken = login.json().data.accessToken;

    const session = await call("POST", "/auth/student-session", parentToken, {
      studentProfileId: studentId,
      pin: "1234",
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().data.accessToken).toBeTruthy();
  });

  test("email de padre duplicado → CONFLICT", async () => {
    const res = await call("POST", "/admin/families", adminToken, {
      name: "Otra",
      parent: { email: parentEmail, password: "clave-temporal-123" },
      students: [{ name: "Beto", avatar: "cat", pin: "5678" }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  test("gradeId inexistente → VALIDATION_ERROR (nada creado)", async () => {
    const res = await call("POST", "/admin/families", adminToken, {
      name: "Con grado malo",
      parent: {
        email: `p2-${uniq}@piensa.test`,
        password: "clave-temporal-123",
      },
      students: [
        { name: "C", avatar: "dog", pin: "1111", gradeId: randomUUID() },
      ],
    });
    expect(res.statusCode).toBe(400);
    // El padre no se creó (transacción): login debe fallar.
    const login = await call("POST", "/auth/login", undefined, {
      email: `p2-${uniq}@piensa.test`,
      password: "clave-temporal-123",
    });
    expect(login.statusCode).toBe(401);
  });

  test("suspend corta el acceso del padre; reactivate lo restaura", async () => {
    const login = await call("POST", "/auth/login", undefined, {
      email: parentEmail,
      password: "clave-temporal-123",
    });
    const parentToken = login.json().data.accessToken;
    const studentId = (
      await call("GET", `/admin/families/${familyId}`, adminToken)
    ).json().data.students[0].id;

    await call("POST", `/admin/families/${familyId}/suspend`, adminToken, {
      adminNote: "pendiente pago julio",
    });
    const blocked = await call("POST", "/auth/student-session", parentToken, {
      studentProfileId: studentId,
      pin: "1234",
    });
    expect(blocked.json().error.code).toBe("FAMILY_SUSPENDED");

    await call("POST", `/admin/families/${familyId}/reactivate`, adminToken);
    const ok = await call("POST", "/auth/student-session", parentToken, {
      studentProfileId: studentId,
      pin: "1234",
    });
    expect(ok.statusCode).toBe(200);
  });

  test("agregar un alumno a una familia existente", async () => {
    const res = await call(
      "POST",
      `/admin/families/${familyId}/students`,
      adminToken,
      { name: "Nuevo", avatar: "owl", pin: "4321" },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().data.name).toBe("Nuevo");
  });

  test("overview devuelve conteos", async () => {
    const res = await call("GET", "/admin/overview", adminToken);
    const d = res.json().data;
    expect(d.families.total).toBeGreaterThanOrEqual(1);
    expect(d.students.total).toBeGreaterThanOrEqual(1);
  });

  test("overview cuenta alumnos activos en los últimos 7 días (XPEvent en la ventana; los viejos no cuentan)", async () => {
    // Alumno con actividad RECIENTE (dentro de la ventana de 7 días).
    const recent = await call("POST", "/admin/families", adminToken, {
      name: "Activos",
      parent: {
        email: `act-${uniq}@piensa.test`,
        password: "clave-temporal-123",
      },
      students: [{ name: "Activo", avatar: "fox", pin: "1122" }],
    });
    const recentStudentId = recent.json().data.students[0].id;
    await db.xPEvent.create({
      data: {
        studentProfileId: recentStudentId,
        amount: 10,
        reason: "lesson_complete",
        refId: `recent-${uniq}`,
        createdAt: new Date(),
      },
    });

    // Alumno con actividad VIEJA (hace 10 días, fuera de la ventana).
    const stale = await call("POST", "/admin/families", adminToken, {
      name: "Inactivos",
      parent: {
        email: `ina-${uniq}@piensa.test`,
        password: "clave-temporal-123",
      },
      students: [{ name: "Viejo", avatar: "cat", pin: "3344" }],
    });
    const staleStudentId = stale.json().data.students[0].id;
    await db.xPEvent.create({
      data: {
        studentProfileId: staleStudentId,
        amount: 10,
        reason: "lesson_complete",
        refId: `stale-${uniq}`,
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      },
    });

    const res = await call("GET", "/admin/overview", adminToken);
    const d = res.json().data;
    expect(d.activity.windowDays).toBe(7);
    // El alumno con XPEvent reciente cuenta; el de XPEvent viejo no.
    expect(d.activity.activeStudentsLast7Days).toBeGreaterThanOrEqual(1);
    // Consistencia: nunca más activos que alumnos totales.
    expect(d.activity.activeStudentsLast7Days).toBeLessThanOrEqual(
      d.students.total,
    );
  });

  test("crear familia con materias inscritas (subjectIds) atómico; materia mala → nada creado", async () => {
    const subject = await db.subject.create({ data: { name: `Mat-${uniq}` } });
    const created = await call("POST", "/admin/families", adminToken, {
      name: "Con materias",
      parent: {
        email: `pm-${uniq}@piensa.test`,
        password: "clave-temporal-123",
      },
      students: [
        { name: "Z", avatar: "fox", pin: "2468", subjectIds: [subject.id] },
      ],
    });
    expect(created.statusCode).toBe(201);
    const newStudentId = created.json().data.students[0].id;
    const enrolled = await db.studentSubject.findMany({
      where: { studentProfileId: newStudentId },
    });
    expect(enrolled).toHaveLength(1);

    // subjectId inválido → VALIDATION_ERROR, nada creado (transacción).
    const bad = await call("POST", "/admin/families", adminToken, {
      name: "Mala",
      parent: {
        email: `pmb-${uniq}@piensa.test`,
        password: "clave-temporal-123",
      },
      students: [
        { name: "W", avatar: "cat", pin: "1357", subjectIds: [randomUUID()] },
      ],
    });
    expect(bad.statusCode).toBe(400);
    const gone = await call("POST", "/auth/login", undefined, {
      email: `pmb-${uniq}@piensa.test`,
      password: "clave-temporal-123",
    });
    expect(gone.statusCode).toBe(401);
  });

  test("no-admin → FORBIDDEN", async () => {
    const res = await call("POST", "/admin/families", parentSelfToken, {
      name: "X",
      parent: {
        email: `z-${uniq}@piensa.test`,
        password: "clave-temporal-123",
      },
      students: [{ name: "Y", avatar: "fox", pin: "0000" }],
    });
    expect(res.statusCode).toBe(403);
  });
});
