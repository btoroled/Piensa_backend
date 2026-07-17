// Primitivas de autorización reutilizables (Spec §6, ISSUE-09).
//
// preHandlers de Fastify que separan autenticación (verificar el token) de
// autorización (rol y pertenencia). La pertenencia se resuelve SIEMPRE contra
// la BD, nunca confiando en los claims del token. Se exponen como una factory
// que recibe sus dependencias (jwtSecret, prisma) para cablearse por módulo y
// probarse en aislamiento.

import type { preHandlerHookHandler } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import {
  verifyAccessToken,
  type AccessTokenClaims,
  type TokenRole,
} from "./tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    // Principal autenticado; lo puebla `authenticate`. Ausente hasta entonces.
    authPrincipal?: AccessTokenClaims;
  }
}

export interface AuthorizationDeps {
  jwtSecret: string;
  prisma: PrismaClient;
}

export interface StudentIdSource {
  from: "params" | "body";
  key: string;
}

export interface Authorization {
  authenticate: preHandlerHookHandler;
  requireRole: (...roles: TokenRole[]) => preHandlerHookHandler;
  requireStudentOwnership: (source: StudentIdSource) => preHandlerHookHandler;
}

export function createAuthorization(deps: AuthorizationDeps): Authorization {
  const { jwtSecret, prisma } = deps;

  const authenticate: preHandlerHookHandler = async (request) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) {
      throw new AppError("UNAUTHORIZED", "Falta el token de autenticación.");
    }
    try {
      request.authPrincipal = await verifyAccessToken(jwtSecret, token);
    } catch {
      throw new AppError("UNAUTHORIZED", "Token de autenticación inválido.");
    }
  };

  const requireRole =
    (...roles: TokenRole[]): preHandlerHookHandler =>
    async (request) => {
      const principal = request.authPrincipal;
      if (!principal) {
        throw new AppError("UNAUTHORIZED", "No autenticado.");
      }
      if (!roles.includes(principal.role)) {
        throw new AppError("FORBIDDEN", "No tienes permiso para esta acción.");
      }
    };

  const familyIdOf = async (userId: string): Promise<string | null> => {
    const family = await prisma.family.findFirst({
      where: { parentUserId: userId },
      select: { id: true },
    });
    return family?.id ?? null;
  };

  const requireStudentOwnership =
    (source: StudentIdSource): preHandlerHookHandler =>
    async (request) => {
      const principal = request.authPrincipal;
      if (!principal) {
        throw new AppError("UNAUTHORIZED", "No autenticado.");
      }
      // Admin gestiona todas las familias: no se le aplica pertenencia.
      if (principal.role === "admin") {
        return;
      }

      const bag = (source.from === "params" ? request.params : request.body) as
        Record<string, unknown> | undefined;
      const studentProfileId = bag?.[source.key];
      if (typeof studentProfileId !== "string") {
        throw forbiddenProfile();
      }

      const profile = await prisma.studentProfile.findUnique({
        where: { id: studentProfileId },
        select: { id: true, familyId: true },
      });
      if (!profile) {
        throw forbiddenProfile();
      }

      if (principal.role === "student") {
        if (profile.id !== principal.studentProfileId) {
          throw forbiddenProfile();
        }
        return;
      }

      // parent: la familia se resuelve desde la BD, no del claim del token.
      const parentFamilyId = principal.userId
        ? await familyIdOf(principal.userId)
        : null;
      if (parentFamilyId === null || profile.familyId !== parentFamilyId) {
        throw forbiddenProfile();
      }
    };

  return { authenticate, requireRole, requireStudentOwnership };
}

function forbiddenProfile(): AppError {
  return new AppError(
    "FORBIDDEN",
    "No tienes permiso para este perfil de alumno.",
  );
}
