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
  subjectIds?: string[];
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
      // Inscripción a materias (Milestone 2.5, ISSUE-38), en la misma transacción.
      ...(s.subjectIds && s.subjectIds.length > 0
        ? {
            subjects: {
              create: s.subjectIds.map((id) => ({ subjectId: id })),
            },
          }
        : {}),
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
      throw new AppError(
        "VALIDATION_ERROR",
        "El grado o alguna materia indicada no existe.",
      );
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
        ...(input.subjectIds && input.subjectIds.length > 0
          ? {
              subjects: {
                create: input.subjectIds.map((id) => ({ subjectId: id })),
              },
            }
          : {}),
      },
      select: studentSelect,
    });
  } catch (err) {
    // familyId ya se verificó en la ruta (NOT_FOUND); acá el grado o una materia.
    if (isPrismaError(err, "P2003"))
      throw new AppError(
        "VALIDATION_ERROR",
        "El grado o alguna materia indicada no existe.",
      );
    throw err;
  }
}

// Ventana del panel de operación (follow-up de ISSUE-18, diferido a M3).
// Documentada y ajustable, como el resto de las constantes del spec.
const ACTIVITY_WINDOW_DAYS = 7;

export async function getOverview(prisma: PrismaClient) {
  const since = new Date(
    Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const [active, suspended, students, activeGroups] = await Promise.all([
    prisma.family.count({ where: { status: "active" } }),
    prisma.family.count({ where: { status: "suspended" } }),
    prisma.studentProfile.count(),
    // Distintos alumnos con al menos un XPEvent en la ventana. XPEvent es el
    // libro de eventos append-only (spec §4): toda actividad que cuenta
    // (completar lección, enviar quiz) emite uno, así que es la fuente directa.
    prisma.xPEvent.groupBy({
      by: ["studentProfileId"],
      where: { createdAt: { gte: since } },
    }),
  ]);
  return {
    families: { active, suspended, total: active + suspended },
    students: { total: students },
    activity: {
      activeStudentsLast7Days: activeGroups.length,
      windowDays: ACTIVITY_WINDOW_DAYS,
    },
  };
}
