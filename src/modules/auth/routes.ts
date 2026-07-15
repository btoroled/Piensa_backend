// Rutas de autenticación (Spec §5). Cablea el servicio de login contra Prisma.
//
// Decisión sobre la nota de review de ISSUE-03 (ajv con `coerceTypes: true`):
// los campos sensibles se validan con `pattern`/límites, no solo con `type`, de
// modo que un tipo incorrecto se rechace en vez de coaccionarse en silencio. Se
// aplica a todo Milestone 1.

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { login } from "./service.js";

export interface AuthRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

// Pattern de email deliberadamente conservador: descarta tipos coaccionados y
// formas obviamente inválidas. La validación real de existencia la hace el
// login contra la BD.
const EMAIL_PATTERN = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";

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

interface LoginBody {
  email: string;
  password: string;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;

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
          findParentFamilyId: async (userId) => {
            const family = await prisma.family.findFirst({
              where: { parentUserId: userId },
              select: { id: true },
            });
            return family?.id ?? null;
          },
          persistRefreshToken: async (input) => {
            await prisma.refreshToken.create({ data: input });
          },
        },
        { email, password },
      );

      return { data: result };
    },
  );
};
