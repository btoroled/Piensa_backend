import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Verificación estática (ISSUE-35): el enum UserRole incluye super_admin, existe
// UserStatus y User tiene status. Sin BD; los constraints reales corren en CI.

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const schema = readFileSync(
  resolve(projectRoot, "prisma", "schema.prisma"),
  "utf8",
);

describe("schema.prisma — rol super_admin y estado de User", () => {
  test("UserRole incluye admin, parent y super_admin", () => {
    expect(schema).toMatch(
      /enum\s+UserRole\s*\{[\s\S]*?admin[\s\S]*?parent[\s\S]*?super_admin[\s\S]*?\}/,
    );
  });

  test("UserStatus declara active y suspended", () => {
    expect(schema).toMatch(
      /enum\s+UserStatus\s*\{[\s\S]*?active[\s\S]*?suspended[\s\S]*?\}/,
    );
  });

  test("User tiene status: UserStatus con default active", () => {
    const user = schema.match(/model\s+User\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(user).toMatch(/status\s+UserStatus\s+@default\(active\)/);
  });
});
