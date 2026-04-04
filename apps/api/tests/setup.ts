import { prisma } from "@dashmani/db";
import { beforeEach, afterAll } from "vitest";

beforeEach(async () => {
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.attendance.deleteMany(),
    prisma.leaveRequest.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.userRole.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.user.deleteMany(),
    prisma.role.deleteMany(),
    prisma.orgUnit.deleteMany(),
    prisma.setting.deleteMany(),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});
