import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  familyTimezoneForStudent,
  recordActivity,
} from "../../src/modules/gamification/streak.js";

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
    "[streak] BD no disponible: se saltan los tests (corren en CI).",
  );
afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});
const db = prisma as PrismaClient;

// Todas las fechas en offset de Lima (UTC-5) para ejercitar el día local.
const at = (iso: string) => new Date(`${iso}-05:00`);

describe.skipIf(!dbAvailable)("streak.recordActivity", () => {
  const tag = `st26-${randomUUID()}`;
  let userId: string;
  let famId: string;

  async function newStudent(): Promise<string> {
    const st = await db.studentProfile.create({
      data: { familyId: famId, name: "Ana", avatar: "fox", pinHash: "x" },
    });
    return st.id;
  }

  beforeAll(async () => {
    const user = await db.user.create({
      data: {
        email: `u-${tag}@piensa.test`,
        passwordHash: "x",
        role: "parent",
      },
    });
    userId = user.id;
    const fam = await db.family.create({
      data: {
        name: `F-${tag}`,
        parentUserId: user.id,
        timezone: "America/Lima",
      },
    });
    famId = fam.id;
  });

  afterAll(async () => {
    await db.studentProfile.deleteMany({ where: { familyId: famId } });
    await db.family.deleteMany({ where: { id: famId } });
    await db.user.deleteMany({ where: { id: userId } });
  });

  test("primera actividad → current 1, longest 1", async () => {
    const s = await newStudent();
    const r = await recordActivity(
      db,
      s,
      "America/Lima",
      at("2026-03-01T10:00:00"),
    );
    expect(r).toEqual({ current: 1, longest: 1 });
  });

  test("dos actividades el mismo día local cuentan 1", async () => {
    const s = await newStudent();
    await recordActivity(db, s, "America/Lima", at("2026-03-01T08:00:00"));
    const r = await recordActivity(
      db,
      s,
      "America/Lima",
      at("2026-03-01T20:00:00"),
    );
    expect(r).toEqual({ current: 1, longest: 1 });
  });

  test("23:59 y 00:01 del día siguiente cuentan 2 días", async () => {
    const s = await newStudent();
    await recordActivity(db, s, "America/Lima", at("2026-03-01T23:59:00"));
    const r = await recordActivity(
      db,
      s,
      "America/Lima",
      at("2026-03-02T00:01:00"),
    );
    expect(r).toEqual({ current: 2, longest: 2 });
  });

  test("brecha ≥2 días reinicia a 1, conserva longest", async () => {
    const s = await newStudent();
    await recordActivity(db, s, "America/Lima", at("2026-03-01T10:00:00"));
    await recordActivity(db, s, "America/Lima", at("2026-03-02T10:00:00")); // current 2
    const r = await recordActivity(
      db,
      s,
      "America/Lima",
      at("2026-03-05T10:00:00"),
    );
    expect(r).toEqual({ current: 1, longest: 2 });
  });

  test("familyTimezoneForStudent devuelve la zona de la familia", async () => {
    const s = await newStudent();
    expect(await familyTimezoneForStudent(db, s)).toBe("America/Lima");
  });
});
