import { describe, expect, test } from "vitest";
import {
  hashPassword,
  verifyPassword,
} from "../../src/modules/auth/password.js";

describe("password hashing (argon2id)", () => {
  test("un hash verifica contra la contraseña original", async () => {
    const hash = await hashPassword("s3creta-correcta");
    await expect(verifyPassword(hash, "s3creta-correcta")).resolves.toBe(true);
  });

  test("una contraseña incorrecta no verifica", async () => {
    const hash = await hashPassword("s3creta-correcta");
    await expect(verifyPassword(hash, "otra-cosa")).resolves.toBe(false);
  });

  test("el hash usa argon2id y es salteado (dos hashes difieren)", async () => {
    const a = await hashPassword("misma-clave");
    const b = await hashPassword("misma-clave");
    expect(a).toMatch(/^\$argon2id\$/);
    expect(a).not.toBe(b);
  });

  test("verificar contra un hash malformado devuelve false, no lanza", async () => {
    await expect(verifyPassword("no-es-un-hash", "x")).resolves.toBe(false);
  });
});
