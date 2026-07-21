import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

// El libro de XP es append-only: ningún archivo de src/ puede mutar XPEvent.
// (la cascada al borrar el alumno la hace la BD, no código de aplicación.)

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..", "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("XPEvent es append-only (arquitectura)", () => {
  test("ningún archivo de src/ llama update/delete/upsert sobre xPEvent", () => {
    const forbidden =
      /xPEvent\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/;
    const offenders = walk(srcDir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => forbidden.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
