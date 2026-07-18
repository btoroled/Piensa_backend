// Rutas de autenticación (Spec §5). Cablea los servicios de auth contra Prisma.
//
// Decisión sobre la nota de review de ISSUE-03 (ajv con `coerceTypes: true`):
// los campos sensibles se validan con `pattern`/límites, no solo con `type`, de
// modo que un tipo incorrecto se rechace en vez de coaccionarse en silencio. Se
// aplica a todo Milestone 1.

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { login, refresh } from "./service.js";
import { createStudentSession } from "./student-session.js";
import { createAuthorization } from "./authorize.js";
import {
  UUID_PATTERN,
  EMAIL_PATTERN,
  PIN_PATTERN,
} from "../../lib/validation.js";
import type { RateLimitRule } from "../../plugins/rate-limit.js";

export interface AuthRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
  /** Límite estricto por IP para los endpoints de credenciales (ISSUE-11). */
  authRateLimit: RateLimitRule;
}

// El refresh token es base64url de 32 bytes: solo caracteres url-safe. Es
// específico de auth y queda local; UUID_PATTERN/EMAIL_PATTERN/PIN_PATTERN se
// comparten desde src/lib/validation.ts (fuente única, ISSUE-35).
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

const studentSessionBodySchema = {
  type: "object",
  required: ["studentProfileId", "pin"],
  additionalProperties: false,
  properties: {
    studentProfileId: {
      type: "string",
      pattern: UUID_PATTERN,
    },
    pin: {
      type: "string",
      pattern: PIN_PATTERN,
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

interface StudentSessionBody {
  studentProfileId: string;
  pin: string;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret, authRateLimit } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });

  // Límite estricto por-ruta sobre los endpoints de credenciales (ISSUE-11).
  const authRateLimitConfig = {
    rateLimit: { max: authRateLimit.max, timeWindow: authRateLimit.timeWindow },
  };

  const familyIdOf = async (userId: string): Promise<string | null> => {
    const family = await prisma.family.findFirst({
      where: { parentUserId: userId },
      select: { id: true },
    });
    return family?.id ?? null;
  };

  app.post<{ Body: LoginBody }>(
    "/auth/login",
    { schema: { body: loginBodySchema }, config: authRateLimitConfig },
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

  app.post<{ Body: StudentSessionBody }>(
    "/auth/student-session",
    {
      schema: { body: studentSessionBodySchema },
      config: authRateLimitConfig,
      preHandler: [authz.authenticate, authz.requireRole("parent")],
    },
    async (request) => {
      const principal = request.authPrincipal;
      if (!principal?.userId) {
        throw new AppError("UNAUTHORIZED", "No autenticado.");
      }
      const parentUserId = principal.userId;

      // La familia del padre se resuelve contra la BD, no desde el token: la
      // pertenencia del perfil se compara contra este valor (Spec §6).
      const parentFamilyId = await familyIdOf(parentUserId);
      if (parentFamilyId === null) {
        throw new AppError(
          "FORBIDDEN",
          "La cuenta no tiene una familia asociada.",
        );
      }

      const { studentProfileId, pin } = request.body;
      const result = await createStudentSession(
        {
          jwtSecret,
          now: () => new Date(),
          findStudentProfile: (id) =>
            prisma.studentProfile.findUnique({
              where: { id },
              select: {
                id: true,
                familyId: true,
                pinHash: true,
                failedPinAttempts: true,
                pinLockedUntil: true,
              },
            }),
          updatePinState: async (id, state) => {
            await prisma.studentProfile.update({
              where: { id },
              data: state,
            });
          },
        },
        { parentFamilyId, studentProfileId, pin },
      );

      return { data: result };
    },
  );
};
