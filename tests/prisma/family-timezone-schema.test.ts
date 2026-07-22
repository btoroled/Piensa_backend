import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// Verificación estática: Family.timezone con default IANA (ISSUE-26).

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(
  resolve(here, "..", "..", "prisma", "schema.prisma"),
  "utf8",
);
function modelBlock(name: string): string {
  const m = schema.match(
    new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  if (!m) throw new Error(`No se encontró el modelo ${name}`);
  return m[1] as string;
}

describe("schema.prisma — Family.timezone (ISSUE-26)", () => {
  test("timezone String con default America/Lima", () => {
    expect(modelBlock("Family")).toMatch(
      /timezone\s+String\s+@default\("America\/Lima"\)/,
    );
  });
});
