import { existsSync } from "node:fs";
import { expect, test } from "vitest";

const modules = [
  "auth",
  "families",
  "catalog",
  "progress",
  "gamification",
  "admin",
];

test.each(modules)("el módulo '%s' tiene un README", (name) => {
  expect(existsSync(`src/modules/${name}/README.md`)).toBe(true);
});

test("existe el directorio de plugins con README", () => {
  expect(existsSync("src/plugins/README.md")).toBe(true);
});
