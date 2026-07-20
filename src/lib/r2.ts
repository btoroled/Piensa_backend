// Adapter de Cloudflare R2 (S3 API) — ISSUE-17. La config viene de env; sin
// credenciales la app arranca igual y el presigner no se construye. El presigner
// se inyecta en las rutas para poder mockearlo en tests (nunca se pega a R2 real).

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface R2Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
}

export interface PresignUploadArgs {
  fileKey: string;
  contentType: string;
  contentLength: number;
  expiresInSeconds: number;
}

/** Firma una URL de subida (PUT) directa a R2. Devuelve la URL. */
export type PresignUpload = (args: PresignUploadArgs) => Promise<string>;

/** Lee la config de R2 del entorno; null si falta alguna var requerida. */
export function loadR2Config(
  source: NodeJS.ProcessEnv = process.env,
): R2Config | null {
  const endpoint = source.R2_ENDPOINT?.trim();
  const bucket = source.R2_BUCKET?.trim();
  const accessKeyId = source.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = source.R2_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  const publicBaseUrl = source.R2_PUBLIC_BASE_URL?.trim() || undefined;
  return { endpoint, bucket, accessKeyId, secretAccessKey, publicBaseUrl };
}

/** Construye el presigner real de subida a partir de la config. */
export function createPresignUpload(config: R2Config): PresignUpload {
  const client = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  return async ({ fileKey, contentType, contentLength, expiresInSeconds }) => {
    // Firmar ContentType y ContentLength: R2 exige que la subida coincida, así
    // la URL no sirve para subir otro tipo ni otro tamaño.
    const command = new PutObjectCommand({
      Bucket: config.bucket,
      Key: fileKey,
      ContentType: contentType,
      ContentLength: contentLength,
    });
    return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
  };
}
