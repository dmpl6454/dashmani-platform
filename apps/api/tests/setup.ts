import { prisma } from "@dashmani/db";
import { beforeEach, afterAll } from "vitest";

const TRUNCATE_SQL = `
    TRUNCATE TABLE content_posts, approvals, project_files, project_tasks, project_accounts, projects,
      client_refresh_tokens, clients,
      task_comments, tasks, report_links, daily_reports, account_growth_snapshots, account_assignments, social_accounts, platforms,
      otp_tokens, audit_logs, attendance, leave_requests, refresh_tokens,
      user_roles, role_permissions, users, roles, org_units, settings
    CASCADE
  `;

/**
 * TRUNCATE every table between tests, retrying on deadlock.
 *
 * ⚠️ WHY THE RETRY EXISTS. Several service paths write FIRE-AND-FORGET (audit logs,
 * recordApiUsage, dispatchNotification) — they are deliberately not awaited so a logging
 * failure can never break a request. That means when a test returns, one of those INSERTs
 * can still be in flight on a DIFFERENT pooled connection. This beforeEach then asks for an
 * AccessExclusiveLock (TRUNCATE) while that INSERT holds a RowExclusiveLock on one of the
 * same tables and is itself waiting on a table TRUNCATE has already locked — a genuine
 * lock-order inversion, which Postgres resolves by killing one side with SQLSTATE 40P01.
 *
 * Observed in CI as `tests/leaderboard-engagement.test.ts` failing 5 tests on one run and
 * passing on the next with byte-identical code (it failed on a docs-only commit), i.e. a
 * pure flake — but a flaky gate trains people to ignore CI, so it is worth handling.
 *
 * 40P01 is transient BY DEFINITION: Postgres kills one participant precisely so the other
 * can proceed, so the loser simply needs to run again. Whichever side lost, by the time we
 * retry the in-flight write has finished or been rolled back. Only deadlock is retried —
 * every other error still fails the test immediately, so this cannot mask a real bug.
 *
 * The file's original comment already noted these "async audit log writes that may land
 * between transaction steps"; this handles the deadlock that race actually produces.
 */
/**
 * Wait until no OTHER backend on this database is running a query.
 *
 * ⚠️ This is the half that actually prevents the deadlock rather than recovering from it.
 * Retrying the TRUNCATE only helps when TRUNCATE is the side Postgres chooses to kill; when
 * it picks the other side, the victim is the in-flight fire-and-forget INSERT — and if that
 * INSERT belonged to the test currently running, THAT test fails and no amount of retrying
 * here can save it. Draining first means the lock-order inversion never forms.
 *
 * Prisma pools several connections, so an unawaited audit-log / recordApiUsage /
 * dispatchNotification write from the previous test is typically still active on a different
 * backend when the next test's beforeEach fires. Idle pooled connections are state='idle' and
 * are correctly ignored — only genuinely running statements block us.
 *
 * Bounded to ~1s total: this is best-effort, and truncateAll()'s retry remains the backstop.
 */
async function waitForQuiesce(maxWaitMs = 1000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const rows = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'active'
      `;
      if (!rows[0] || rows[0].n === 0) return;
    } catch {
      return; // pg_stat_activity unavailable → fall through to the retrying TRUNCATE
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function truncateAll(attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$executeRawUnsafe(TRUNCATE_SQL);
      return;
    } catch (err: unknown) {
      const e = err as { code?: string; meta?: { code?: string }; message?: string };
      const isDeadlock =
        e?.code === "40P01" ||
        e?.meta?.code === "40P01" ||
        String(e?.message ?? "").includes("deadlock detected");
      if (!isDeadlock || attempt >= attempts) throw err;
      // Brief linear backoff to let the competing write drain before we relock.
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

beforeEach(async () => {
  // Drain first (prevents the deadlock forming), then truncate (retries if one forms anyway).
  await waitForQuiesce();
  await truncateAll();
});

afterAll(async () => {
  await prisma.$disconnect();
});
