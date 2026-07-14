import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");

const compose = readFileSync(
  resolve(projectRoot, "docker-compose.dev.yml"),
  "utf8",
);

describe("docker-compose.dev.yml", () => {
  test("define un servicio de PostgreSQL", () => {
    expect(compose).toMatch(/image:\s*postgres:/);
  });

  test("expone el puerto solo en localhost (127.0.0.1)", () => {
    // El binding del puerto debe estar acotado a 127.0.0.1, nunca 0.0.0.0 / público.
    expect(compose).toMatch(/127\.0\.0\.1:5432:5432/);
    expect(compose).not.toMatch(/(^|\s)-\s*["']?5432:5432/m);
    expect(compose).not.toMatch(/0\.0\.0\.0:5432/);
  });

  test("usa un volumen nombrado para persistencia de datos", () => {
    expect(compose).toMatch(/\/var\/lib\/postgresql\/data/);
    expect(compose).toMatch(/^volumes:/m);
  });

  test("declara un healthcheck para saber cuándo está listo", () => {
    expect(compose).toMatch(/healthcheck:/);
    expect(compose).toMatch(/pg_isready/);
  });

  test("monta un script de init que crea la base de datos de tests separada", () => {
    expect(compose).toMatch(/docker-entrypoint-initdb\.d/);

    const initSql = readFileSync(
      resolve(
        projectRoot,
        "docker",
        "postgres",
        "init",
        "01-create-test-db.sql",
      ),
      "utf8",
    );
    expect(initSql).toMatch(/CREATE DATABASE\s+piensa_test/i);
  });
});

describe(".env.example", () => {
  const example = readFileSync(resolve(projectRoot, ".env.example"), "utf8");

  test("documenta DATABASE_URL (requerida por la app y por prisma validate)", () => {
    expect(example).toMatch(/^DATABASE_URL=/m);
  });

  test("documenta la base de datos separada para tests", () => {
    expect(example).toMatch(/piensa_test/);
  });
});
