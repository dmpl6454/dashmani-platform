import { describe, it, expect, beforeEach } from "vitest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { prisma } from "@dashmani/db";
import { refresh } from "../src/services/auth.service";
import { refreshHrToken } from "../src/services/hr-auth.service";
import { clientRefresh } from "../src/services/client-auth.service";
import { signRefreshToken } from "../src/utils/jwt";
import { AppError } from "../src/middleware/error-handler";
import {
  getAllAccountsLinkStats,
  invalidateAccountLinkStatsCache,
} from "../src/services/account.service";
import "./setup";

// ── Two production bugs verified live 2026-07-17:
//
// (1) REFRESH-TOKEN RACE (16× HTTP 500 on POST /hr/auth/refresh in real traffic):
//     all three portals' refresh flows do findUnique(stored) → ... → delete(stored.id).
//     Two concurrent refreshes with the SAME token both pass findUnique; the loser's
//     delete throws Prisma P2025 ("Record to delete does not exist") → unhandled → 500.
//     The fix: consume the row idempotently (deleteMany + count check) so the loser
//     gets the SAME clean 401 INVALID_TOKEN every other invalid-token path returns.
//     Single-use semantics preserved: exactly ONE winner ever gets new tokens.
//
// (2) links-by-account (getAllAccountsLinkStats) was the last uncached heavy read on
//     the internal /reports page (~4s on prod, every load, every SWR revalidation).
//     The fix: same 60s TTL memo used by leaderboard.service/_lbCache and
//     social-insights/memoInsights, keyed by date window, with a test-visible
//     invalidate export (the documented cross-test-pollution guard).

async function seedUser(email: string) {
  return prisma.user.create({
    data: { name: "ZZ Refresh", email, passwordHash: "x", status: "ACTIVE" },
  });
}

// Seed a stored refresh token EXACTLY the way login does: sign, sha256, insert.
async function seedRefreshToken(userId: string): Promise<string> {
  const token = signRefreshToken({ userId });
  const hashed = crypto.createHash("sha256").update(token).digest("hex");
  await prisma.refreshToken.create({
    data: { userId, token: hashed, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) },
  });
  return token;
}

// Fire N truly-concurrent refresh calls with ONE token and assert the invariant:
// exactly one winner; every loser fails with a CLEAN AppError 401 — never a raw
// Prisma error (P2025 was reaching users as a 500).
async function raceAssert(fn: (t: string) => Promise<unknown>, token: string) {
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => fn(token)));
  const wins = results.filter((r) => r.status === "fulfilled");
  const losses = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  expect(wins.length).toBe(1); // single-use: exactly one winner
  expect(losses.length).toBe(7);
  for (const l of losses) {
    // The load-bearing assertion: a loser must get the app's own 401, not a Prisma crash.
    expect(l.reason).toBeInstanceOf(AppError);
    expect((l.reason as AppError).statusCode).toBe(401);
    expect((l.reason as AppError).name).not.toBe("PrismaClientKnownRequestError");
  }
}

describe("refresh-token race — concurrent refreshes never crash (P2025 → clean 401)", () => {
  it("internal portal: refresh() race yields 1 winner + clean 401 losers", async () => {
    const u = await seedUser("zztest-race-internal@example.com");
    const token = await seedRefreshToken(u.id);
    await raceAssert(refresh, token);
  });

  it("HR portal: refreshHrToken() race yields 1 winner + clean 401 losers", async () => {
    const u = await seedUser("zztest-race-hr@example.com");
    const token = await seedRefreshToken(u.id);
    await raceAssert(refreshHrToken, token);
  });

  it("client portal: clientRefresh() race yields 1 winner + clean 401 losers", async () => {
    const c = await prisma.client.create({
      data: {
        companyName: "ZZ Co",
        contactName: "ZZ Contact",
        email: "zztest-race-client@example.com",
        passwordHash: "x",
        status: "ACTIVE",
      },
    });
    // clientRefresh signs/verifies with JWT_SECRET (its own historical convention).
    const token = jwt.sign({ userId: c.id }, process.env.JWT_SECRET || "dev-secret", {
      expiresIn: "7d",
      jwtid: crypto.randomUUID(),
    });
    const hashed = crypto.createHash("sha256").update(token).digest("hex");
    await prisma.clientRefreshToken.create({
      data: { clientId: c.id, token: hashed, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) },
    });
    await raceAssert(clientRefresh, token);
  });

  it("happy path preserved: a single refresh returns rotated tokens (internal)", async () => {
    const u = await seedUser("zztest-happy-internal@example.com");
    const token = await seedRefreshToken(u.id);
    const out = (await refresh(token)) as { accessToken: string; refreshToken: string };
    expect(out.accessToken).toBeTruthy();
    expect(out.refreshToken).toBeTruthy();
    // rotation: the old token is consumed — a second use gets 401, never a crash
    await expect(refresh(token)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("getAllAccountsLinkStats — behavior + 60s cache contract", () => {
  beforeEach(() => {
    // Module-singleton cache MUST be reset per test (the documented leaderboard/_lbCache
    // and link-search coverage-cache cross-test-pollution class).
    invalidateAccountLinkStatsCache();
  });

  async function seedLinks() {
    const emp = await prisma.user.create({
      data: { name: "ZZ Stats Emp", email: "zztest-stats@example.com", passwordHash: "x", status: "ACTIVE" },
    });
    const platform = await prisma.platform.create({ data: { name: "ZZTEST_LS", slug: "zztest-ls" } });
    const acct = await prisma.socialAccount.create({
      data: { handle: "zztest-ls-acct", displayName: "ZZ LS", platformId: platform.id },
    });
    await prisma.dailyReport.create({
      data: {
        employeeId: emp.id,
        date: new Date("2026-07-10"),
        links: {
          create: [
            { accountId: acct.id, url: "https://zztest-ls.example/1", platform: "instagram" },
            { accountId: acct.id, url: "https://zztest-ls.example/2", platform: "instagram" },
          ],
        },
      },
    });
    return { emp, acct };
  }

  it("returns per-account totals with employee breakdown (characterization — same pre/post fix)", async () => {
    const { emp, acct } = await seedLinks();
    const stats = await getAllAccountsLinkStats("2026-07-01", "2026-07-17");
    const row = stats.find((r) => r.accountId === acct.id)!;
    expect(row).toBeDefined();
    expect(row.totalLinks).toBe(2);
    expect(row.employeeCount).toBe(1);
    expect(row.employees[0]).toMatchObject({ employeeId: emp.id, totalLinks: 2, pct: 100 });
  });

  it("serves from cache within the TTL and recomputes after invalidate", async () => {
    const { emp, acct } = await seedLinks();
    const first = await getAllAccountsLinkStats("2026-07-01", "2026-07-17");
    expect(first.find((r) => r.accountId === acct.id)!.totalLinks).toBe(2);

    // add a 3rd link — a cached read must NOT see it yet
    await prisma.dailyReport.create({
      data: {
        employeeId: emp.id,
        date: new Date("2026-07-11"),
        links: { create: [{ accountId: acct.id, url: "https://zztest-ls.example/3", platform: "instagram" }] },
      },
    });
    const cached = await getAllAccountsLinkStats("2026-07-01", "2026-07-17");
    expect(cached.find((r) => r.accountId === acct.id)!.totalLinks).toBe(2); // stale by design (60s TTL)

    invalidateAccountLinkStatsCache();
    const fresh = await getAllAccountsLinkStats("2026-07-01", "2026-07-17");
    expect(fresh.find((r) => r.accountId === acct.id)!.totalLinks).toBe(3); // recomputed
  });

  it("different date windows never share a cache entry", async () => {
    const { acct } = await seedLinks();
    const wide = await getAllAccountsLinkStats("2026-07-01", "2026-07-17");
    const empty = await getAllAccountsLinkStats("2026-01-01", "2026-01-31"); // window with no links
    expect(wide.find((r) => r.accountId === acct.id)).toBeDefined();
    expect(empty.find((r) => r.accountId === acct.id)).toBeUndefined();
  });
});
