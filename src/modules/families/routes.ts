// Rutas de gestión de familias (ISSUE-18), bajo /api/v1/admin, solo admin.
// Crear/listar/detallar familias, agregar alumnos, suspender/reactivar, overview.
// Sin DELETE: las familias se suspenden, no se borran (spec §2).

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { isPrismaError } from "../../lib/prisma-errors.js";
import {
  UUID_PATTERN,
  EMAIL_PATTERN,
  PIN_PATTERN,
} from "../../lib/validation.js";
import { createFamily, addStudent, getOverview } from "./service.js";

export interface FamiliesRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const studentSchema = {
  type: "object",
  required: ["name", "avatar", "pin"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    avatar: { type: "string", minLength: 1, maxLength: 100 },
    pin: { type: "string", pattern: PIN_PATTERN },
    gradeId: { type: "string", pattern: UUID_PATTERN },
    subjectIds: {
      type: "array",
      maxItems: 50,
      uniqueItems: true,
      items: { type: "string", pattern: UUID_PATTERN },
    },
  },
} as const;

const createFamilyBodySchema = {
  type: "object",
  required: ["name", "parent", "students"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    parent: {
      type: "object",
      required: ["email", "password"],
      additionalProperties: false,
      properties: {
        email: { type: "string", pattern: EMAIL_PATTERN, maxLength: 254 },
        password: { type: "string", minLength: 8, maxLength: 1024 },
      },
    },
    students: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: studentSchema,
    },
  },
} as const;

const suspendBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: { adminNote: { type: "string", maxLength: 500 } },
} as const;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

interface IdParams {
  id: string;
}
interface StudentBody {
  name: string;
  avatar: string;
  pin: string;
  gradeId?: string;
  subjectIds?: string[];
}
interface CreateFamilyBody {
  name: string;
  parent: { email: string; password: string };
  students: StudentBody[];
}
interface SuspendBody {
  adminNote?: string;
}

const familyListSelect = {
  id: true,
  name: true,
  status: true,
  adminNote: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { students: true } },
} as const;

const familyDetailSelect = {
  id: true,
  name: true,
  status: true,
  adminNote: true,
  createdAt: true,
  updatedAt: true,
  parentUser: { select: { id: true, email: true } },
  students: {
    select: {
      id: true,
      name: true,
      avatar: true,
      gradeId: true,
      createdAt: true,
    },
  },
} as const;

export const familiesRoutes: FastifyPluginAsync<FamiliesRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];

  app.post<{ Body: CreateFamilyBody }>(
    "/admin/families",
    { schema: { body: createFamilyBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      const family = await createFamily(prisma, request.body);
      reply.code(201);
      return { data: family };
    },
  );

  app.get("/admin/families", { preHandler: adminOnly }, async () => ({
    data: await prisma.family.findMany({
      select: familyListSelect,
      orderBy: { createdAt: "asc" },
    }),
  }));

  app.get<{ Params: IdParams }>(
    "/admin/families/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const family = await prisma.family.findUnique({
        where: { id: request.params.id },
        select: familyDetailSelect,
      });
      if (!family) throw new AppError("NOT_FOUND", "Familia no encontrada.");
      return { data: family };
    },
  );

  app.post<{ Params: IdParams; Body: StudentBody }>(
    "/admin/families/:id/students",
    {
      schema: { params: idParamsSchema, body: studentSchema },
      preHandler: adminOnly,
    },
    async (request, reply) => {
      const family = await prisma.family.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!family) throw new AppError("NOT_FOUND", "Familia no encontrada.");
      const student = await addStudent(prisma, request.params.id, request.body);
      reply.code(201);
      return { data: student };
    },
  );

  app.post<{ Params: IdParams; Body: SuspendBody }>(
    "/admin/families/:id/suspend",
    {
      schema: { params: idParamsSchema, body: suspendBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        const family = await prisma.family.update({
          where: { id: request.params.id },
          data: {
            status: "suspended",
            adminNote: request.body.adminNote ?? null,
          },
          select: familyListSelect,
        });
        return { data: family };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Familia no encontrada.");
        throw err;
      }
    },
  );

  app.post<{ Params: IdParams }>(
    "/admin/families/:id/reactivate",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        const family = await prisma.family.update({
          where: { id: request.params.id },
          data: { status: "active" },
          select: familyListSelect,
        });
        return { data: family };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Familia no encontrada.");
        throw err;
      }
    },
  );

  // Overview: conteos de familias/alumnos + alumnos activos últimos 7 días
  // (ISSUE-18 + follow-up M3).
  app.get("/admin/overview", { preHandler: adminOnly }, async () => ({
    data: await getOverview(prisma),
  }));
};
