// Rutas de autenticación (Spec §5). Cablea los servicios de auth contra Prisma.
//
// Decisión sobre la nota de review de ISSUE-03 (ajv con `coerceTypes: true`):
// los campos sensibles se validan con `pattern`/límites, no solo con `type`, de
// modo que un tipo incorrecto se rechace en vez de coaccionarse en silencio. Se
// aplica a todo Milestone 1.

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { login, refresh } from "./service.js";

export interface AuthRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

// Pattern de email deliberadamente conservador: descarta tipos coaccionados y
// formas obviamente inválidas. La validación real de existencia la hace el
// login contra la BD.
const EMAIL_PATTERN = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";

// El refresh token es base64url de 32 bytes: solo caracteres url-safe.
const REFRESH_TOKEN_PATTERN = "^[A-Za-z0-9_-]+$";

const loginBodySchema = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: false,
  properties: {
    email: {
      type: "string",
      pattern: EMAIL_PATTERN,
      maxLength: 254,
    },
    password: {
      type: "string",
      minLength: 1,
      maxLength: 1024,
    },
  },
} as const;

const refreshBodySchema = {
  type: "object",
  required: ["refreshToken"],
  additionalProperties: false,
  properties: {
    refreshToken: {
      type: "string",
      pattern: REFRESH_TOKEN_PATTERN,
      minLength: 32,
      maxLength: 512,
    },
  },
} as const;

interface LoginBody {
  email: string;
  password: string;
}

interface RefreshBody {
  refreshToken: string;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;

  const familyIdOf = async (userId: string): Promise<string | null> => {
    const family = await prisma.family.findFirst({
      where: { parentUserId: userId },
      select: { id: true },
    });
    return family?.id ?? null;
  };

  app.post<{ Body: LoginBody }>(
    "/auth/login",
    { schema: { body: loginBodySchema } },
    async (request) => {
      const { email, password } = request.body;

      const result = await login(
        {
          jwtSecret,
          now: () => new Date(),
          findUserByEmail: (e) =>
            prisma.user.findUnique({ where: { email: e } }),
          findParentFamilyId: familyIdOf,
          persistRefreshToken: async (input) => {
            await prisma.refreshToken.create({ data: input });
          },
        },
        { email, password },
      );

      return { data: result };
    },
  );

  app.post<{ Body: RefreshBody }>(
    "/auth/refresh",
    { schema: { body: refreshBodySchema } },
    async (request) => {
      const { refreshToken } = request.body;

      const result = await refresh(
        {
          jwtSecret,
          now: () => new Date(),
          findRefreshTokenByHash: (tokenHash) =>
            prisma.refreshToken.findUnique({
              where: { tokenHash },
              select: {
                id: true,
                sessionId: true,
                userId: true,
                revokedAt: true,
                expiresAt: true,
              },
            }),
          findUserById: (id) =>
            prisma.user.findUnique({
              where: { id },
              select: { id: true, role: true },
            }),
          findParentFamilyId: familyIdOf,
          rotate: async (input) => {
            // Atómico: revocar el viejo e insertar el nuevo van juntos o nada.
            await prisma.$transaction([
              prisma.refreshToken.update({
                where: { id: input.oldTokenId },
                data: { revokedAt: input.now },
              }),
              prisma.refreshToken.create({
                data: {
                  userId: input.userId,
                  sessionId: input.sessionId,
                  tokenHash: input.newTokenHash,
                  expiresAt: input.expiresAt,
                },
              }),
            ]);
          },
          revokeSession: async (sessionId, now) => {
            await prisma.refreshToken.updateMany({
              where: { sessionId, revokedAt: null },
              data: { revokedAt: now },
            });
          },
        },
        { refreshToken },
      );

      return { data: result };
    },
  );
};
