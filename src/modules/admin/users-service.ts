// Gestión de cuentas admin por un super_admin (ISSUE-35). Sin Fastify ni Prisma
// directo: recibe sus dependencias para probarse en aislamiento. Regla de
// seguridad: solo puede actuar sobre usuarios rol `admin` (nunca super_admin ni
// parent); ningún camino produce un super_admin.

import type { UserRole, UserStatus } from "@prisma/client";
import { AppError } from "../../plugins/errors.js";

export interface AdminUserView {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
}

export interface AdminUsersDeps {
  findUserById: (
    id: string,
  ) => Promise<{ id: string; role: UserRole; status: UserStatus } | null>;
  setUserStatus: (id: string, status: UserStatus) => Promise<void>;
  deleteUser: (id: string) => Promise<void>;
  createUser: (input: {
    email: string;
    passwordHash: string;
  }) => Promise<AdminUserView>;
  listAdmins: () => Promise<AdminUserView[]>;
  hashPassword: (plain: string) => Promise<string>;
}

/** Carga un usuario y exige que sea rol `admin`; si no, corta sin actuar. */
async function loadAdminTarget(deps: AdminUsersDeps, id: string) {
  const user = await deps.findUserById(id);
  if (!user) {
    throw new AppError("NOT_FOUND", "Usuario no encontrado.");
  }
  if (user.role !== "admin") {
    // Un super_admin (o parent) no se gestiona por API (Spec §2, ISSUE-35).
    throw new AppError(
      "FORBIDDEN",
      "Solo se pueden gestionar cuentas de administrador.",
    );
  }
  return user;
}

export async function createAdmin(
  deps: AdminUsersDeps,
  input: { email: string; password: string },
): Promise<AdminUserView> {
  const passwordHash = await deps.hashPassword(input.password);
  // createUser fija el rol a `admin` en la capa de datos: este servicio nunca
  // produce un super_admin.
  return deps.createUser({ email: input.email, passwordHash });
}

export function listAdmins(deps: AdminUsersDeps): Promise<AdminUserView[]> {
  return deps.listAdmins();
}

export async function suspendAdmin(
  deps: AdminUsersDeps,
  id: string,
): Promise<void> {
  await loadAdminTarget(deps, id);
  await deps.setUserStatus(id, "suspended");
}

export async function reactivateAdmin(
  deps: AdminUsersDeps,
  id: string,
): Promise<void> {
  await loadAdminTarget(deps, id);
  await deps.setUserStatus(id, "active");
}

export async function deleteAdmin(
  deps: AdminUsersDeps,
  id: string,
): Promise<void> {
  await loadAdminTarget(deps, id);
  await deps.deleteUser(id);
}
