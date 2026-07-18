// Rutas de gestión de admins (ISSUE-35), bajo /api/v1/admin. Todas exigen
// super_admin. `createUser` fija el rol a `admin` acá (nunca super_admin).

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { createAuthorization } from "../auth/authorize.js";
import { hashPassword } from "../auth/password.js";
import { UUID_PATTERN, EMAIL_PATTERN } from "../../lib/validation.js";
import {
  createAdmin,
  listAdmins,
  suspendAdmin,
  reactivateAdmin,
  deleteAdmin,
  type AdminUsersDeps,
} from "./users-service.js";

export interface AdminRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const createAdminBodySchema = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: false,
  properties: {
    email: { type: "string", pattern: EMAIL_PATTERN, maxLength: 254 },
    password: { type: "string", minLength: 12, maxLength: 1024 },
  },
} as const;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

interface CreateAdminBody {
  email: string;
  password: string;
}
interface IdParams {
  id: string;
}

export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const superAdmin = [authz.authenticate, authz.requireRole("super_admin")];

  const deps: AdminUsersDeps = {
    findUserById: (id) =>
      prisma.user.findUnique({
        where: { id },
        select: { id: true, role: true, status: true },
      }),
    setUserStatus: async (id, status) => {
      await prisma.user.update({ where: { id }, data: { status } });
    },
    deleteUser: async (id) => {
      await prisma.user.delete({ where: { id } });
    },
    createUser: (input) =>
      prisma.user.create({
        // Rol fijado a `admin`: la API nunca crea un super_admin (ISSUE-35).
        data: {
          email: input.email,
          passwordHash: input.passwordHash,
          role: "admin",
        },
        select: { id: true, email: true, role: true, status: true },
      }),
    listAdmins: () =>
      prisma.user.findMany({
        where: { role: "admin" },
        select: { id: true, email: true, role: true, status: true },
        orderBy: { createdAt: "asc" },
      }),
    hashPassword,
  };

  app.post<{ Body: CreateAdminBody }>(
    "/admin/users",
    { schema: { body: createAdminBodySchema }, preHandler: superAdmin },
    async (request, reply) => {
      const admin = await createAdmin(deps, request.body);
      reply.code(201);
      return { data: admin };
    },
  );

  app.get("/admin/users", { preHandler: superAdmin }, async () => ({
    data: await listAdmins(deps),
  }));

  app.post<{ Params: IdParams }>(
    "/admin/users/:id/suspend",
    { schema: { params: idParamsSchema }, preHandler: superAdmin },
    async (request) => {
      await suspendAdmin(deps, request.params.id);
      return { data: { id: request.params.id, status: "suspended" } };
    },
  );

  app.post<{ Params: IdParams }>(
    "/admin/users/:id/reactivate",
    { schema: { params: idParamsSchema }, preHandler: superAdmin },
    async (request) => {
      await reactivateAdmin(deps, request.params.id);
      return { data: { id: request.params.id, status: "active" } };
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/users/:id",
    { schema: { params: idParamsSchema }, preHandler: superAdmin },
    async (request) => {
      await deleteAdmin(deps, request.params.id);
      return { data: { id: request.params.id, deleted: true } };
    },
  );
};
