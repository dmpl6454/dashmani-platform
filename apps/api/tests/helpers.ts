import { prisma } from "@dashmani/db";
import { hash } from "bcrypt";
import jwt from "jsonwebtoken";

export async function createTestRole(name: string, permissions: { resource: string; action: string; scope: string }[]) {
  const role = await prisma.role.create({
    data: {
      name,
      description: `Test role: ${name}`,
      isSystemRole: false,
      permissions: { create: permissions },
    },
  });
  return role;
}

export async function createTestUser(overrides: { name?: string; email?: string; password?: string; roleNames?: string[] } = {}) {
  const passwordHash = await hash(overrides.password || "TestPass123!", 12);
  const user = await prisma.user.create({
    data: {
      name: overrides.name || "Test User",
      email: overrides.email || `test-${Date.now()}@test.com`,
      passwordHash,
      status: "ACTIVE",
    },
  });

  if (overrides.roleNames) {
    for (const roleName of overrides.roleNames) {
      const role = await prisma.role.findUnique({ where: { name: roleName } });
      if (role) {
        await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
      }
    }
  }

  return user;
}

export function generateToken(userId: string, email: string, roles: string[] = []) {
  return jwt.sign(
    { userId, email, roles, type: "employee" },
    process.env.JWT_SECRET || "test-secret",
    { expiresIn: "15m" }
  );
}
