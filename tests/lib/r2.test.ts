import { describe, expect, test } from "vitest";
import { loadR2Config } from "../../src/lib/r2.js";

const full = {
  R2_ENDPOINT: "https://acc.r2.cloudflarestorage.com",
  R2_BUCKET: "piensa",
  R2_ACCESS_KEY_ID: "id",
  R2_SECRET_ACCESS_KEY: "secret",
};

describe("loadR2Config", () => {
  test("con todas las vars requeridas devuelve la config", () => {
    const cfg = loadR2Config({ ...full, R2_PUBLIC_BASE_URL: "https://cdn.x" });
    expect(cfg).toMatchObject({
      bucket: "piensa",
      publicBaseUrl: "https://cdn.x",
    });
  });
  test("si falta una var requerida devuelve null (R2 no configurado)", () => {
    expect(loadR2Config({ ...full, R2_BUCKET: "" })).toBeNull();
    expect(loadR2Config({})).toBeNull();
  });
});
