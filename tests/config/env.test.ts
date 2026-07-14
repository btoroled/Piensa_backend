import { describe, expect, test } from "vitest";
import { EnvValidationError, loadEnv } from "../../src/config/env.js";

const validEnv = {
  DATABASE_URL:
    "postgresql://piensa:piensa@localhost:5432/piensa_dev?schema=public",
};

describe("loadEnv", () => {
  test("con las variables requeridas devuelve una config tipada", () => {
    const env = loadEnv({ ...validEnv, NODE_ENV: "test", PORT: "4000" });

    expect(env).toEqual({
      DATABASE_URL: validEnv.DATABASE_URL,
      NODE_ENV: "test",
      PORT: 4000,
    });
  });

  test("aplica defaults para NODE_ENV y PORT cuando no se proveen", () => {
    const env = loadEnv({ ...validEnv });

    expect(env.NODE_ENV).toBe("development");
    expect(env.PORT).toBe(3000);
  });

  test("lanza EnvValidationError cuando falta DATABASE_URL", () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
  });

  test("trata una DATABASE_URL vacía o en blanco como ausente", () => {
    expect(() => loadEnv({ DATABASE_URL: "   " })).toThrow(EnvValidationError);
  });

  test("el error nombra la variable faltante con un mensaje accionable, sin stack", () => {
    let caught: unknown;
    try {
      loadEnv({});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EnvValidationError);
    const error = caught as EnvValidationError;
    expect(error.missing).toEqual(["DATABASE_URL"]);
    expect(error.message).toContain("DATABASE_URL");
    // El mensaje es claro y guía al usuario al .env.example.
    expect(error.message).toMatch(/\.env\.example/);
    // El mensaje no debe contener rastros de stack (frames "at ...").
    expect(error.message).not.toMatch(/\n\s*at /);
  });

  test("rechaza un PORT no numérico", () => {
    expect(() => loadEnv({ ...validEnv, PORT: "no-soy-un-puerto" })).toThrow(
      EnvValidationError,
    );
  });

  test("rechaza un NODE_ENV desconocido", () => {
    expect(() => loadEnv({ ...validEnv, NODE_ENV: "staging" })).toThrow(
      EnvValidationError,
    );
  });
});
