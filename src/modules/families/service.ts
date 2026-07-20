// Gestión de familias por el admin (ISSUE-18). Orquesta la creación atómica de
// User padre + Family + alumnos, y los conteos del overview. Reusa hashPassword
// (argon2) para la contraseña temporal del padre y el PIN inicial de cada alumno.

import type { PrismaClient } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";
import { isPrismaError } from "../../lib/prisma-errors.js";
import { hashPassword } from "../auth/password.js";

export interface StudentInput {
  name: string;
  avatar: string;
  pin: string;
  gradeId?: string;
}
export interface CreateFamilyInput {
  name: string;
  parent: { email: string; password: string };
  students: StudentInput[];
}

const studentSelect = {
  id: true,
  name: true,
  avatar: true,
  gradeId: true,
  createdAt: true,
} as const;

const familyDetailSelect = {
  id: true,
  name: true,
  status: true,
  adminNote: true,
  createdAt: true,
  updatedAt: true,
  parentUser: { select: { id: true, email: true } },
  students: { select: studentSelect },
} as const;

async function hashedStudents(students: StudentInput[]) {
  return Promise.all(
    students.map(async (s) => ({
      name: s.name,
      avatar: s.avatar,
      pinHash: await hashPassword(s.pin),
      gradeId: s.gradeId,
    })),
  );
}

export async function createFamily(
  prisma: PrismaClient,
  input: CreateFamilyInput,
) {
  const passwordHash = await hashPassword(input.parent.password);
  const students = await hashedStudents(input.students);
  try {
    return await prisma.$transaction(async (tx) => {
      const parent = await tx.user.create({
        data: {
          email: input.parent.email,
          passwordHash,
          role: "parent",
        },
      });
      return tx.family.create({
        data: {
          name: input.name,
          parentUserId: parent.id,
          students: { create: students },
        },
        select: familyDetailSelect,
      });
    });
  } catch (err) {
    if (isPrismaError(err, "P2002"))
      throw new AppError("CONFLICT", "El email del padre ya está en uso.");
    if (isPrismaError(err, "P2003"))
      throw new AppError("VALIDATION_ERROR", "El grado indicado no existe.");
    throw err;
  }
}

export async function addStudent(
  prisma: PrismaClient,
  familyId: string,
  input: StudentInput,
) {
  const pinHash = await hashPassword(input.pin);
  try {
    return await prisma.studentProfile.create({
      data: {
        familyId,
        name: input.name,
        avatar: input.avatar,
        pinHash,
        gradeId: input.gradeId,
      },
      select: studentSelect,
    });
  } catch (err) {
    // familyId ya se verificó en la ruta (NOT_FOUND); acá solo puede ser el grado.
    if (isPrismaError(err, "P2003"))
      throw new AppError("VALIDATION_ERROR", "El grado indicado no existe.");
    throw err;
  }
}

export async function getOverview(prisma: PrismaClient) {
  const [active, suspended, students] = await Promise.all([
    prisma.family.count({ where: { status: "active" } }),
    prisma.family.count({ where: { status: "suspended" } }),
    prisma.studentProfile.count(),
  ]);
  return {
    families: { active, suspended, total: active + suspended },
    students: { total: students },
  };
}
