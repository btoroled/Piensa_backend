import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { PrismaClient } from "@prisma/client";

// Constraints del modelo de Personas contra una BD PostgreSQL real (Spec §4,
// ISSUE-05). Requiere una base migrada en DATABASE_URL.
//
// Entorno: en local sin Docker no hay Postgres; estos tests se AUTO-SALTAN
// (nada de verde fabricado). En CI (ISSUE-04) hay un service container Postgres
// con las migraciones aplicadas por `migrate deploy`, así que SÍ se ejecutan y
// son la evidencia real de los criterios de aceptación.

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");

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
  // Deja constancia de por qué se saltan, sin ensuciar el reporte de fallos.
  console.warn(
    "[personas-constraints] BD no disponible en DATABASE_URL: se saltan los tests de constraints (se ejecutan en CI).",
  );
}

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});

// Divide un script SQL en sentencias individuales, ignorando comentarios `--`.
function splitStatements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

// Concatena TODAS las migraciones en orden lexicográfico (que es el orden
// cronológico por el prefijo de timestamp). Aplicarlas todas mantiene el
// round-trip simétrico con el schema completo: la bajada (diff del schema
// actual → vacío) dropea exactamente lo que la subida creó, sin acoplarse a una
// sola migración. Así el test no se rompe cuando un issue agrega migraciones.
function migrationUpSql(): string {
  const migrationsDir = resolve(projectRoot, "prisma", "migrations");
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (dirs.length === 0) throw new Error("No se encontró ninguna migración");
  return dirs
    .map((name) =>
      readFileSync(resolve(migrationsDir, name, "migration.sql"), "utf8"),
    )
    .join("\n");
}

const client = prisma as PrismaClient;

describe.skipIf(!dbAvailable)("Personas — constraints contra BD", () => {
  test("email duplicado en User falla (índice único)", async () => {
    const email = `dup-${randomUUID()}@piensa.test`;
    const first = await client.user.create({
      data: { email, passwordHash: "x", role: "parent" },
    });
    try {
      await expect(
        client.user.create({
          data: { email, passwordHash: "y", role: "admin" },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    } finally {
      await client.user.delete({ where: { id: first.id } });
    }
  });

  test("borrar una Family con StudentProfiles falla (FK Restrict, no huérfanos)", async () => {
    const user = await client.user.create({
      data: {
        email: `parent-${randomUUID()}@piensa.test`,
        passwordHash: "x",
        role: "parent",
      },
    });
    const family = await client.family.create({
      data: { name: "Los Prueba", parentUserId: user.id },
    });
    const student = await client.studentProfile.create({
      data: {
        familyId: family.id,
        name: "Ana",
        avatar: "fox",
        pinHash: "hashed-pin",
      },
    });

    try {
      // La FK con ON DELETE RESTRICT debe impedir el borrado.
      await expect(
        client.family.delete({ where: { id: family.id } }),
      ).rejects.toMatchObject({ code: "P2003" });

      // El perfil sigue vivo: no quedó huérfano ni se borró en cascada.
      const stillThere = await client.studentProfile.findUnique({
        where: { id: student.id },
      });
      expect(stillThere).not.toBeNull();
    } finally {
      await client.studentProfile.delete({ where: { id: student.id } });
      await client.family.delete({ where: { id: family.id } });
      await client.user.delete({ where: { id: user.id } });
    }
  });

  test("las migraciones aplican y revierten limpiamente (round-trip aislado)", async () => {
    // Se ejercita en un schema PostgreSQL efímero para no tocar el schema
    // migrado que usan los tests de arriba.
    const iso = `it_roundtrip_${randomUUID().replace(/-/g, "")}`;

    // Sentencias de subida (migración real) sin el CREATE SCHEMA "public".
    const upStatements = splitStatements(migrationUpSql()).filter(
      (stmt) => !/^CREATE SCHEMA/i.test(stmt),
    );

    // Sentencias de bajada generadas por Prisma; se descalifican de "public"
    // para que resuelvan contra el schema efímero vía search_path.
    const downSql = execFileSync(
      "npx",
      [
        "prisma",
        "migrate",
        "diff",
        "--from-schema-datamodel",
        "prisma/schema.prisma",
        "--to-empty",
        "--script",
      ],
      { cwd: projectRoot, encoding: "utf8" },
    ).replace(/"public"\./g, "");
    const downStatements = splitStatements(downSql);

    try {
      await client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${iso}"`);
        await tx.$executeRawUnsafe(`SET search_path TO "${iso}"`);

        // Aplica: crea enums, tablas, índices y FKs en el schema efímero.
        for (const stmt of upStatements) {
          await tx.$executeRawUnsafe(stmt);
        }

        const tablesAfterUp = await tx.$queryRawUnsafe<
          { table_name: string }[]
        >(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = '${iso}'`,
        );
        const names = tablesAfterUp.map((r) => r.table_name).sort();
        // Subset tolerante: verifica que las tablas migradas hasta hoy existen,
        // sin romperse cuando un issue futuro agregue más.
        expect(names).toEqual(
          expect.arrayContaining([
            "Family",
            "RefreshToken",
            "StudentProfile",
            "User",
          ]),
        );

        // Revierte: dropea FKs, tablas y enums generados por la migración.
        for (const stmt of downStatements) {
          await tx.$executeRawUnsafe(stmt);
        }

        const tablesAfterDown = await tx.$queryRawUnsafe<
          { table_name: string }[]
        >(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = '${iso}'`,
        );
        expect(tablesAfterDown).toHaveLength(0);

        const enumsAfterDown = await tx.$queryRawUnsafe<{ typname: string }[]>(
          `SELECT t.typname FROM pg_type t
             JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = '${iso}' AND t.typtype = 'e'`,
        );
        expect(enumsAfterDown).toHaveLength(0);
      });
    } finally {
      await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${iso}" CASCADE`);
    }
    // Round-trip pesado: aplica y revierte TODAS las migraciones y spawnea
    // `prisma migrate diff`. Con el catálogo (ISSUE-12) hay más tablas; bajo la
    // carga de la suite completa el default de 5s de vitest queda corto. Margen
    // amplio para que no sea flaky (en aislamiento corre en ~2.6s).
  }, 30_000);
});
