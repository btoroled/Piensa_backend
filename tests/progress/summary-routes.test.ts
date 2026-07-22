import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../../src/app.js";
import { createAccessToken } from "../../src/modules/auth/tokens.js";
import { seedBadges } from "../../src/modules/gamification/badges.js";

const SECRET = "integration-secret-at-least-16-chars";

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
    "[summary] BD no disponible: se saltan los tests (corren en CI).",
  );
const db = prisma as PrismaClient;
let app: FastifyInstance;

describe.skipIf(!dbAvailable)("GET /me/summary", () => {
  const tag = `sum29-${randomUUID()}`;
  let userId: string;
  let famId: string;
  let studentId: string;
  let topicId: string;

  beforeAll(async () => {
    if (!dbAvailable) return;
    app = buildApp({ prisma: db, jwtSecret: SECRET });
    await app.ready();
    await seedBadges(db);

    const user = await db.user.create({
      data: {
        email: `u-${tag}@piensa.test`,
        passwordHash: "x",
        role: "parent",
      },
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

    // Historial: XP 150 (→ nivel 2), racha 3/5, insignia first-lesson, maestría.
    await db.xPEvent.create({
      data: {
        studentProfileId: studentId,
        amount: 150,
        reason: "lesson_complete",
        refId: `seed-${randomUUID()}`,
      },
    });
    await db.streak.create({
      data: { studentProfileId: studentId, current: 3, longest: 5 },
    });
    const badge = await db.badge.findUniqueOrThrow({
      where: { code: "first-lesson" },
    });
    await db.badgeAward.create({
      data: { studentProfileId: studentId, badgeId: badge.id },
    });
    const topic = await db.topic.create({ data: { name: `T-${tag}` } });
    topicId = topic.id;
    await db.topicMastery.create({
      data: { studentProfileId: studentId, topicId, level: "familiar" },
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await app.close();
    await db.studentProfile.deleteMany({ where: { familyId: famId } });
    await db.topic.deleteMany({ where: { name: { contains: tag } } });
    await db.family.deleteMany({ where: { id: famId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  test("arma cada bloque del panel", async () => {
    const token = await createAccessToken(SECRET, {
      studentProfileId: studentId,
      role: "student",
      familyId: famId,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/summary",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();

    // XP + nivel + progreso
    expect(data.xp).toEqual({
      total: 150,
      level: 2,
      intoLevel: 50,
      forNextLevel: 200,
    });
    // Racha
    expect(data.streak).toEqual({ current: 3, longest: 5 });
    // Insignias ganadas y por ganar
    const earnedCodes = data.badges.earned.map((b: { code: string }) => b.code);
    expect(earnedCodes).toEqual(["first-lesson"]);
    expect(data.badges.earned[0].awardedAt).toBeTruthy();
    const availableCodes = data.badges.available.map(
      (b: { code: string }) => b.code,
    );
    expect(availableCodes).toContain("streak-7");
    expect(availableCodes).not.toContain("first-lesson");
    // Maestría
    expect(data.mastery).toEqual([
      { topicId, topic: `T-${tag}`, level: "familiar" },
    ]);
  });

  test("alumno sin historial → panel en ceros, sin insignias ganadas", async () => {
    const empty = await db.studentProfile.create({
      data: { familyId: famId, name: "Beto", avatar: "cat", pinHash: "x" },
    });
    const token = await createAccessToken(SECRET, {
      studentProfileId: empty.id,
      role: "student",
      familyId: famId,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/summary",
      headers: { authorization: `Bearer ${token}` },
    });
    const { data } = res.json();
    expect(data.xp).toEqual({
      total: 0,
      level: 1,
      intoLevel: 0,
      forNextLevel: 100,
    });
    expect(data.streak).toEqual({ current: 0, longest: 0 });
    expect(data.badges.earned).toEqual([]);
    expect(data.mastery).toEqual([]);
  });
});
