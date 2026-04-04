import { prisma } from "@dashmani/db";
import { beforeEach, afterAll } from "vitest";

beforeEach(async () => {
  // Use raw SQL to truncate all tables, avoiding FK ordering issues
  // from async audit log writes that may land between transaction steps
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE audit_logs, attendance, leave_requests, refresh_tokens,
      user_roles, role_permissions, users, roles, org_units, settings
    CASCADE
  `);
});

afterAll(async () => {
  await prisma.$disconnect();
});
