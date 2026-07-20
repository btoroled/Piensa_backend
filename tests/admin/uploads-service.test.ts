import { describe, expect, test, vi } from "vitest";
import {
  requestUpload,
  MAX_UPLOAD_BYTES_DEFAULT,
  type RequestUploadDeps,
} from "../../src/modules/admin/uploads.js";

const deps = (over: Partial<RequestUploadDeps> = {}): RequestUploadDeps => ({
  presignUpload: vi.fn(async () => "https://signed.example/put"),
  maxBytes: MAX_UPLOAD_BYTES_DEFAULT,
  expiresInSeconds: 300,
  ...over,
});

const bad = async (p: Promise<unknown>) => {
  await expect(p).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
};

describe("requestUpload", () => {
  test("pdf válido → fileKey documents/…​.pdf + url + expiración", async () => {
    const d = deps();
    const res = await requestUpload(d, {
      contentType: "application/pdf",
      sizeBytes: 1000,
    });
    expect(res.fileKey).toMatch(/^documents\/[0-9a-f-]+\.pdf$/);
    expect(res.uploadUrl).toBe("https://signed.example/put");
    expect(res.expiresInSeconds).toBe(300);
    expect(d.presignUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: "application/pdf",
        contentLength: 1000,
      }),
    );
  });
  test("imágenes → prefijo images/ y extensión correcta", async () => {
    const png = await requestUpload(deps(), {
      contentType: "image/png",
      sizeBytes: 10,
    });
    expect(png.fileKey).toMatch(/^images\/[0-9a-f-]+\.png$/);
    const jpg = await requestUpload(deps(), {
      contentType: "image/jpeg",
      sizeBytes: 10,
    });
    expect(jpg.fileKey).toMatch(/\.jpg$/);
  });
  test("tipo no permitido → VALIDATION_ERROR (no firma)", async () => {
    const d = deps();
    await bad(requestUpload(d, { contentType: "image/svg+xml", sizeBytes: 10 }));
    expect(d.presignUpload).not.toHaveBeenCalled();
  });
  test("tamaño mayor al máximo → VALIDATION_ERROR", async () => {
    await bad(
      requestUpload(deps({ maxBytes: 100 }), {
        contentType: "application/pdf",
        sizeBytes: 101,
      }),
    );
  });
  test("tamaño 0 o negativo → VALIDATION_ERROR", async () => {
    await bad(
      requestUpload(deps(), { contentType: "application/pdf", sizeBytes: 0 }),
    );
  });
});
