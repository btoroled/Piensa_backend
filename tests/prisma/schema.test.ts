import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Verificación estática del modelo de datos de Personas (Spec §4, ISSUE-05).
// No requiere base de datos: audita que el schema declare los modelos, enums,
// unicidad y reglas de borrado exigidas por los criterios de aceptación. Sirve
// como red local (donde no hay Postgres); los constraints reales se ejercitan
// contra la BD en personas-constraints.test.ts (se corre en CI).

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const schema = readFileSync(
  resolve(projectRoot, "prisma", "schema.prisma"),
  "utf8",
);

// Extrae el bloque `model X { ... }` para asertar sobre sus campos sin que
// coincidencias de otros modelos contaminen la búsqueda.
function modelBlock(name: string): string {
  const match = schema.match(
    new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  if (!match) {
    throw new Error(`No se encontró el modelo ${name} en schema.prisma`);
  }
  return match[1] as string;
}

describe("schema.prisma — modelos de Personas", () => {
  test("declara los enums de rol y estado con los valores del spec", () => {
    expect(schema).toMatch(
      /enum\s+UserRole\s*\{[\s\S]*?admin[\s\S]*?parent[\s\S]*?\}/,
    );
    expect(schema).toMatch(
      /enum\s+FamilyStatus\s*\{[\s\S]*?active[\s\S]*?suspended[\s\S]*?\}/,
    );
  });

  test("User tiene email único, passwordHash y role tipado", () => {
    const user = modelBlock("User");
    expect(user).toMatch(/email\s+String\s+@unique/);
    expect(user).toMatch(/passwordHash\s+String/);
    expect(user).toMatch(/role\s+UserRole/);
  });

  test("Family referencia al User padre con borrado restringido", () => {
    const family = modelBlock("Family");
    expect(family).toMatch(/status\s+FamilyStatus/);
    expect(family).toMatch(/adminNote\s+String\?/);
    expect(family).toMatch(/parentUserId\s+String/);
    // La FK al User padre no debe permitir borrar un User con familias colgando.
    expect(family).toMatch(
      /@relation\([^)]*fields:\s*\[parentUserId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
  });

  test("StudentProfile referencia a Family con borrado restringido (no huérfanos)", () => {
    const profile = modelBlock("StudentProfile");
    expect(profile).toMatch(/familyId\s+String/);
    expect(profile).toMatch(/pinHash\s+String/);
    expect(profile).toMatch(/failedPinAttempts\s+Int/);
    // Criterio de aceptación: borrar una Family con perfiles debe fallar.
    expect(profile).toMatch(
      /@relation\([^)]*fields:\s*\[familyId\][^)]*onDelete:\s*Restrict[^)]*\)/,
    );
  });

  test("los campos opcionales del spec son nullable y los obligatorios no", () => {
    const profile = modelBlock("StudentProfile");
    // gradeId y pinLockedUntil son nullable (spec §4).
    expect(profile).toMatch(/gradeId\s+String\?/);
    expect(profile).toMatch(/pinLockedUntil\s+DateTime\?/);
    // name y pinHash son obligatorios (sin `?`).
    expect(profile).not.toMatch(/name\s+String\?/);
    expect(profile).not.toMatch(/pinHash\s+String\?/);
  });
});
