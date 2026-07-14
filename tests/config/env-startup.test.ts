import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const tsxBin = resolve(projectRoot, "node_modules", ".bin", "tsx");
const serverEntry = resolve(projectRoot, "src", "server.ts");

test("arrancar el servidor sin DATABASE_URL termina con mensaje claro y sin stack trace", () => {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.DATABASE_URL;

  const result = spawnSync(tsxBin, [serverEntry], {
    cwd: projectRoot,
    env: childEnv,
    encoding: "utf8",
    timeout: 30_000,
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  // El proceso termina y no queda escuchando.
  expect(result.status).toBe(1);
  // Mensaje claro que nombra la variable faltante.
  expect(output).toContain("DATABASE_URL");
  expect(output).toMatch(/\.env\.example/);
  // No se filtra un stack trace (frames "at ..." ni el nombre del error crudo).
  expect(output).not.toMatch(/\n\s*at .+:\d+:\d+/);
  expect(output).not.toContain("EnvValidationError");
});
