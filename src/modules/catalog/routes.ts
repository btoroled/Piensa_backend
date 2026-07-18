// CRUD de catálogo para el admin (ISSUE-13), bajo /api/v1/admin. Solo admin
// (super_admin hereda). El borrado con dependientes lo bloquean las FK Restrict
// (ISSUE-12) → CONFLICT vía mapDeleteRestrict.

import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { createAuthorization } from "../auth/authorize.js";
import { UUID_PATTERN } from "../../lib/validation.js";
import { isPrismaError, mapDeleteRestrict } from "../../lib/prisma-errors.js";

export interface CatalogRoutesOptions {
  prisma: PrismaClient;
  jwtSecret: string;
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const createGradeBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
} as const;

const updateGradeBodySchema = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
} as const;

interface IdParams {
  id: string;
}
interface GradeBody {
  name: string;
}

const gradeSelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const catalogRoutes: FastifyPluginAsync<CatalogRoutesOptions> = async (
  app,
  opts,
) => {
  const { prisma, jwtSecret } = opts;
  const authz = createAuthorization({ jwtSecret, prisma });
  const adminOnly = [authz.authenticate, authz.requireRole("admin")];

  // ── Grados ────────────────────────────────────────────────────────────────
  app.post<{ Body: GradeBody }>(
    "/admin/grades",
    { schema: { body: createGradeBodySchema }, preHandler: adminOnly },
    async (request, reply) => {
      const grade = await prisma.grade.create({
        data: { name: request.body.name },
        select: gradeSelect,
      });
      reply.code(201);
      return { data: grade };
    },
  );

  app.get("/admin/grades", { preHandler: adminOnly }, async () => ({
    data: await prisma.grade.findMany({
      select: gradeSelect,
      orderBy: { createdAt: "asc" },
    }),
  }));

  app.get<{ Params: IdParams }>(
    "/admin/grades/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      const grade = await prisma.grade.findUnique({
        where: { id: request.params.id },
        select: gradeSelect,
      });
      if (!grade) throw new AppError("NOT_FOUND", "Grado no encontrado.");
      return { data: grade };
    },
  );

  app.patch<{ Params: IdParams; Body: GradeBody }>(
    "/admin/grades/:id",
    {
      schema: { params: idParamsSchema, body: updateGradeBodySchema },
      preHandler: adminOnly,
    },
    async (request) => {
      try {
        const grade = await prisma.grade.update({
          where: { id: request.params.id },
          data: { name: request.body.name },
          select: gradeSelect,
        });
        return { data: grade };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Grado no encontrado.");
        throw err;
      }
    },
  );

  app.delete<{ Params: IdParams }>(
    "/admin/grades/:id",
    { schema: { params: idParamsSchema }, preHandler: adminOnly },
    async (request) => {
      try {
        await prisma.grade.delete({ where: { id: request.params.id } });
        return { data: { id: request.params.id, deleted: true } };
      } catch (err) {
        if (isPrismaError(err, "P2025"))
          throw new AppError("NOT_FOUND", "Grado no encontrado.");
        // Semanas colgando o alumnos asignados (FK Restrict) → CONFLICT.
        mapDeleteRestrict(
          err,
          "No se puede borrar el grado: tiene semanas o alumnos asociados.",
        );
      }
    },
  );
};
