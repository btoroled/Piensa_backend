// Ruta POST /admin/uploads (ISSUE-17), solo admin. Devuelve una URL firmada de
// subida directa a R2 + fileKey. El presigner se inyecta (undefined = R2 no
// configurado → error claro de config).

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import type { PresignUpload } from "../../lib/r2.js";
import {
  requestUpload,
  MAX_UPLOAD_BYTES_DEFAULT,
  UPLOAD_URL_TTL_SECONDS_DEFAULT,
} from "./uploads.js";

export interface UploadsRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
  presignUpload?: PresignUpload;
  maxBytes?: number;
}

const uploadBodySchema = {
  type: "object",
  required: ["contentType", "sizeBytes"],
  additionalProperties: false,
  properties: {
    contentType: { type: "string", minLength: 1, maxLength: 100 },
    sizeBytes: { type: "integer", minimum: 1 },
  },
} as const;

interface UploadBody {
  contentType: string;
  sizeBytes: number;
}

export const uploadsRoutes: FastifyPluginAsync<UploadsRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret, presignUpload } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES_DEFAULT;

  app.post<{ Body: UploadBody }>(
    "/admin/uploads",
    { schema: { body: uploadBodySchema }, preHandler: adminOnly },
    async (request) => {
      if (!presignUpload) {
        // Sin credenciales R2: error de servidor claro (no filtra detalles).
        throw new AppError(
          "INTERNAL",
          "El almacenamiento de archivos no está configurado.",
        );
      }
      const ticket = await requestUpload(
        {
          presignUpload,
          maxBytes,
          expiresInSeconds: UPLOAD_URL_TTL_SECONDS_DEFAULT,
        },
        request.body,
      );
      return { data: ticket };
    },
  );
};
