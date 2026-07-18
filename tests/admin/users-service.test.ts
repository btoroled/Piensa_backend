import { describe, expect, test, vi } from "vitest";
import type { UserRole, UserStatus } from "@prisma/client";
import {
  suspendAdmin,
  deleteAdmin,
  type AdminUsersDeps,
} from "../../src/modules/admin/users-service.js";

// El servicio solo puede actuar sobre usuarios rol `admin`. Un target super_admin
// o parent (o inexistente) → FORBIDDEN/NOT_FOUND. Sin BD: deps stubbeadas.

const userRow = (
  role: UserRole,
  id = "x",
  status: UserStatus = "active",
): { id: string; role: UserRole; status: UserStatus } => ({ id, role, status });

function deps(overrides: Partial<AdminUsersDeps> = {}): AdminUsersDeps {
  return {
    findUserById: async () => userRow("admin"),
    setUserStatus: vi.fn(async () => {}),
    deleteUser: vi.fn(async () => {}),
    createUser: vi.fn(async () => ({
      id: "new",
      email: "a@b.c",
      role: "admin" as UserRole,
      status: "active" as UserStatus,
    })),
    listAdmins: async () => [],
    hashPassword: async () => "hashed",
    ...overrides,
  };
}

describe("guard de target rol admin", () => {
  test("suspender un target super_admin → FORBIDDEN", async () => {
    const d = deps({
      findUserById: async () => userRow("super_admin", "s"),
    });
    await expect(suspendAdmin(d, "s")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(d.setUserStatus).not.toHaveBeenCalled();
  });

  test("borrar un target parent → FORBIDDEN", async () => {
    const d = deps({
      findUserById: async () => userRow("parent", "p"),
    });
    await expect(deleteAdmin(d, "p")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(d.deleteUser).not.toHaveBeenCalled();
  });

  test("target inexistente → NOT_FOUND", async () => {
    const d = deps({ findUserById: async () => null });
    await expect(suspendAdmin(d, "nope")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("suspender un admin real → llama setUserStatus(suspended)", async () => {
    const d = deps();
    await suspendAdmin(d, "x");
    expect(d.setUserStatus).toHaveBeenCalledWith("x", "suspended");
  });
});
