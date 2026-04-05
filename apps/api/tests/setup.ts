import { prisma } from "@dashmani/db";
import { beforeEach, afterAll } from "vitest";

beforeEach(async () => {
  // Use raw SQL to truncate all tables, avoiding FK ordering issues
  // from async audit log writes that may land between transaction steps
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE content_posts, approvals, project_files, project_tasks, project_accounts, projects,
      client_refresh_tokens, clients,
      task_comments, tasks, report_links, daily_reports, account_growth_snapshots, account_assignments, social_accounts, platforms,
      otp_tokens, audit_logs, attendance, leave_requests, refresh_tokens,
      user_roles, role_permissions, users, roles, org_units, settings
    CASCADE
  `);
});

afterAll(async () => {
  await prisma.$disconnect();
});
