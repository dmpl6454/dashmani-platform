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

/**
 * Per-process counter for default test emails.
 *
 * ⚠️ `Date.now()` alone is NOT unique: users created in the same millisecond (parallel
 * `createTestUser()` calls, or two awaits that resolve within 1 ms) collided on the
 * `users.email` UNIQUE constraint and failed with a P2002 flake. The counter makes every
 * default email distinct within the (single-fork) test process even when the clock does
 * not move; `Date.now()` stays in the string so emails from different runs never repeat.
 */
let testEmailCounter = 0;

export async function createTestUser(overrides: { name?: string; email?: string; password?: string; roleNames?: string[] } = {}) {
  // Reserve the email synchronously, BEFORE the bcrypt await, so its value never depends
  // on how the parallel hashes happen to interleave.
  const email = overrides.email || `test-${Date.now()}-${++testEmailCounter}@test.com`;
  const passwordHash = await hash(overrides.password || "TestPass123!", 12);
  const user = await prisma.user.create({
    data: {
      name: overrides.name || "Test User",
      email,
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
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "15m" }
  );
}

/**
 * An HR-portal access token, the shape `hr-auth.service.ts` issues (`type: "hr"`).
 * Signed with the same secret as `generateToken` so `authenticateHr` accepts it.
 */
export function generateHrToken(userId: string, email: string, roles: string[] = []) {
  return jwt.sign(
    { userId, email, roles, type: "hr" },
    process.env.JWT_SECRET || "dev-secret",
    { expiresIn: "15m" }
  );
}
