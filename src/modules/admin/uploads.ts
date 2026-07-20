// Servicio de solicitud de subida (ISSUE-17). Puro: valida el tipo (allowlist) y
// el tamaño declarado, arma el fileKey (prefijo por tipo + UUID) y delega la
// firma en el presigner inyectado. No toca Fastify ni R2 directo.

import { randomUUID } from "node:crypto";
import { AppError } from "../../plugins/errors.js";
import type { PresignUpload } from "../../lib/r2.js";

/** Tipos permitidos (deny-by-default): MIME → extensión + prefijo de carpeta. */
const ALLOWED: Record<string, { ext: string; prefix: string }> = {
  "application/pdf": { ext: "pdf", prefix: "documents" },
  "image/png": { ext: "png", prefix: "images" },
  "image/jpeg": { ext: "jpg", prefix: "images" },
  "image/webp": { ext: "webp", prefix: "images" },
};

export const MAX_UPLOAD_BYTES_DEFAULT = 20 * 1024 * 1024; // 20 MB
export const UPLOAD_URL_TTL_SECONDS_DEFAULT = 300; // 5 min

export interface RequestUploadDeps {
  presignUpload: PresignUpload;
  maxBytes: number;
  expiresInSeconds: number;
}

export interface UploadTicket {
  uploadUrl: string;
  fileKey: string;
  expiresInSeconds: number;
}

export async function requestUpload(
  deps: RequestUploadDeps,
  input: { contentType: string; sizeBytes: number },
): Promise<UploadTicket> {
  const kind = ALLOWED[input.contentType];
  if (!kind) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Tipo de archivo no permitido (pdf, png, jpg, webp).",
    );
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new AppError("VALIDATION_ERROR", "Tamaño de archivo inválido.");
  }
  if (input.sizeBytes > deps.maxBytes) {
    throw new AppError(
      "VALIDATION_ERROR",
      `El archivo supera el máximo permitido (${deps.maxBytes} bytes).`,
    );
  }
  const fileKey = `${kind.prefix}/${randomUUID()}.${kind.ext}`;
  const uploadUrl = await deps.presignUpload({
    fileKey,
    contentType: input.contentType,
    contentLength: input.sizeBytes,
    expiresInSeconds: deps.expiresInSeconds,
  });
  return { uploadUrl, fileKey, expiresInSeconds: deps.expiresInSeconds };
}
