import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { prisma } from "@dashmani/db";
import { todayIST } from "@dashmani/shared";
import {
  getSubmissionGaps,
  getSubmissionGapDays,
  invalidateSubmissionGapsCache,
  parseSubmissionGapsQuery,
  parseSubmissionGapDaysQuery,
  shiftDay,
  MAX_RANGES_PER_ROW,
  type SubmissionGapsParams,
  type GapPairRow,
} from "../src/services/submission-gaps.service";
import { createTestRole, generateToken } from "./helpers";
import "./setup";

/**
 * Submission gaps — DB-backed. "Today" is PINNED (2026-09-20) for the service tests so
 * every expected day below is exact; the route tests use the real clock and only assert
 * the gate, validation and shape.
 *
 * Fixture timeline (today = 2026-09-20, window 2026-09-10 → 2026-09-20):
 *   asha → igA  assigned 2026-09-01 IST. Posts on 10, 11, 14 (00:30 IST), 15 and today.
 *               12 has only scheduled / null / blank links — still missed.
 *               → counted 10–19 (10), active 4, missed 12–13 + 16–19, current gap 4.
 *   asha → fbB  assigned 2026-09-14T20:00Z = 2026-09-15 01:30 IST (UTC date is the 14th).
 *               No posts → counted 15–19 (5), all missed, gap 5, NOT open-ended.
 *   asha → igP  PAUSED channel → excluded (counted in inactiveChannelAssignments).
 *   bilal → igA assigned 2026-09-01, team T2 via membership only, never posts
 *               → counted 10 missed 10, gap open-ended (runs back past the window start).
 *   bilal → fbB unassigned 2026-09-05 → not current → excluded.
 *   divya (Admin + Employee roles) → fbB assigned 2026-09-18 15:30 IST, posts on 19
 *               → counted 18–19, active 1, missed 18.
 *   Excluded people: a pure-Admin user and an INACTIVE employee, both assigned to igA.
 */

const TODAY = "2026-09-20";
const START = "2026-09-10";
const END = "2026-09-20";

let seq = 0;
let adminId: string;
let adminToken: string;
let ids: Record<string, string>;

function params(over: Partial<SubmissionGapsParams> = {}): SubmissionGapsParams {
  return { startDate: START, endDate: END, today: TODAY, teamId: null, platform: null, employeeId: null, ...over };
}

async function mkUser(
  name: string,
  roleIds: string[],
  opts: { status?: "ACTIVE" | "INACTIVE"; orgUnitId?: string } = {},
): Promise<string> {
  const u = await prisma.user.create({
    data: {
      name,
      email: `gaps-${++seq}-${Date.now()}@test.local`,
      passwordHash: "not-a-real-hash",
      status: opts.status ?? "ACTIVE",
      orgUnitId: opts.orgUnitId ?? null,
      roles: { create: roleIds.map((roleId) => ({ roleId })) },
    },
  });
  return u.id;
}

async function assign(employeeId: string, accountId: string, assignedAt: string, unassignedAt?: string) {
  await prisma.accountAssignment.create({
    data: {
      employeeId,
      accountId,
      assignedBy: adminId,
      assignedAt: new Date(assignedAt),
      unassignedAt: unassignedAt ? new Date(unassignedAt) : null,
    },
  });
}

/** One link on the (employee, day) report — creating the report if needed. */
async function post(
  employeeId: string,
  accountId: string,
  day: string,
  opts: { firstSeenAt?: string; url?: string | null; scheduled?: boolean; reportCreatedAt?: string } = {},
) {
  const date = new Date(`${day}T00:00:00.000Z`);
  const report =
    (await prisma.dailyReport.findUnique({ where: { employeeId_date: { employeeId, date } } })) ??
    (await prisma.dailyReport.create({
      data: {
        employeeId,
        date,
        ...(opts.reportCreatedAt ? { createdAt: new Date(opts.reportCreatedAt) } : {}),
      },
    }));
  await prisma.reportLink.create({
    data: {
      reportId: report.id,
      accountId,
      url: opts.url === undefined ? `https://www.instagram.com/reel/${day}-${++seq}/` : opts.url,
      platform: "instagram",
      isScheduled: opts.scheduled ?? false,
      // Default: 10:00 IST on that day.
      firstSeenAt: new Date(opts.firstSeenAt ?? `${day}T04:30:00.000Z`),
    },
  });
}

function expect400(fn: () => unknown, label: string) {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect((thrown as { statusCode?: number } | undefined)?.statusCode, label).toBe(400);
}

function row(rows: GapPairRow[], employeeId: string, accountId: string): GapPairRow {
  const r = rows.find((x) => x.employee.id === employeeId && x.account.id === accountId);
  if (!r) throw new Error(`no row for ${employeeId}/${accountId}`);
  return r;
}

// ⚠️ Everything lives inside ONE describe so this beforeEach runs AFTER tests/setup.ts's
// TRUNCATE: vitest 1.x runs same-level hooks in PARALLEL (sequence.hooks="parallel"),
// so a root-level beforeEach would race the truncate and lose its fixtures.
describe("submission gaps", () => {
  beforeEach(async () => {
    // ⚠️ Mandatory: module-level single-flight memo — reset per test or results bleed.
    invalidateSubmissionGapsCache();
    seq = 0;

    const employeeRole = await createTestRole("Employee", [{ resource: "tasks", action: "view", scope: "own" }]);
    const adminRole = await createTestRole("Admin", [{ resource: "reports", action: "view", scope: "global" }]);

    const t1 = await prisma.orgUnit.create({ data: { name: "Team One", type: "TEAM" } });
    const t2 = await prisma.orgUnit.create({ data: { name: "Team Two", type: "TEAM" } });

    adminId = await mkUser("Zed Admin", [adminRole.id]);
    adminToken = generateToken(adminId, "admin@test.local", ["Admin"]);

    const ig = await prisma.platform.create({ data: { name: "Instagram", slug: "instagram" } });
    const fb = await prisma.platform.create({ data: { name: "Facebook", slug: "facebook" } });
    const igA = await prisma.socialAccount.create({
      data: { handle: "reelsdaily", displayName: "Reels Daily", platformId: ig.id, status: "ACTIVE" },
    });
    const fbB = await prisma.socialAccount.create({
      data: { handle: "filmypage", displayName: "Filmy Page", platformId: fb.id, status: "ACTIVE" },
    });
    const igP = await prisma.socialAccount.create({
      data: { handle: "pausedone", displayName: "Paused One", platformId: ig.id, status: "PAUSED" },
    });

    const asha = await mkUser("Asha", [employeeRole.id], { orgUnitId: t1.id });
    const bilal = await mkUser("Bilal", [employeeRole.id]);
    await prisma.teamMembership.create({ data: { userId: bilal, orgUnitId: t2.id } });
    const divya = await mkUser("Divya", [adminRole.id, employeeRole.id]);
    const inactive = await mkUser("Chetan", [employeeRole.id], { status: "INACTIVE" });

    await assign(asha, igA.id, "2026-09-01T04:00:00.000Z");
    await assign(asha, fbB.id, "2026-09-14T20:00:00.000Z");
    await assign(asha, igP.id, "2026-09-01T04:00:00.000Z");
    await assign(bilal, igA.id, "2026-09-01T04:00:00.000Z");
    await assign(bilal, fbB.id, "2026-08-01T04:00:00.000Z", "2026-09-05T04:00:00.000Z");
    await assign(divya, fbB.id, "2026-09-18T10:00:00.000Z");
    await assign(adminId, igA.id, "2026-09-01T04:00:00.000Z");
    await assign(inactive, igA.id, "2026-09-01T04:00:00.000Z");

    // asha → igA
    await post(asha, igA.id, "2026-09-10");
    await post(asha, igA.id, "2026-09-11");
    await post(asha, igA.id, "2026-09-11");
    await post(asha, igA.id, "2026-09-12", { scheduled: true });
    await post(asha, igA.id, "2026-09-12", { url: null });
    await post(asha, igA.id, "2026-09-12", { url: "   " });
    // 00:30 IST on the 14th == 19:00 UTC on the 13th.
    await post(asha, igA.id, "2026-09-14", { firstSeenAt: "2026-09-13T19:00:00.000Z" });
    await post(asha, igA.id, "2026-09-15", { firstSeenAt: "2026-09-15T12:45:00.000Z" });
    await post(asha, igA.id, TODAY, { firstSeenAt: "2026-09-20T03:00:00.000Z" });
    // Posted BEFORE the window: never counted, never the "last posted" in the window.
    await post(asha, igA.id, "2026-09-05");
    // A link on the paused channel must not make any counted day active.
    await post(asha, igP.id, "2026-09-13");
    // divya → fbB
    await post(divya, fbB.id, "2026-09-19", { firstSeenAt: "2026-09-19T06:00:00.000Z" });
    // The excluded people post too — they must still not appear.
    await post(adminId, igA.id, "2026-09-16");
    await post(inactive, igA.id, "2026-09-16");

    ids = { asha, bilal, divya, inactive, igA: igA.id, fbB: fbB.id, igP: igP.id, t1: t1.id, t2: t2.id };
  });

  describe("submission gaps — summary", () => {
    it("counts every calendar day, with missed ranges and the current gap", async () => {
      const res = await getSubmissionGaps(params());
      const r = row(res.rows, ids.asha, ids.igA);

      expect(r.assignedSince).toBe("2026-09-01");
      expect(r.countedFrom).toBe("2026-09-10");
      expect(r.countedThrough).toBe("2026-09-19");
      expect(r.countedDays).toBe(10);
      expect(r.activeDays).toBe(4); // 10, 11, 14, 15
      expect(r.missedDays).toBe(6);
      expect(r.missedRanges).toEqual([
        ["2026-09-12", "2026-09-13"],
        ["2026-09-16", "2026-09-19"],
      ]);
      expect(r.missedRangeCount).toBe(2);
      expect(r.missedRangesTruncated).toBe(false);
      expect(r.longestGapDays).toBe(4);
      expect(r.currentGapDays).toBe(4);
      expect(r.currentGapOpenEnded).toBe(false);
      expect(r.activeRate).toBeCloseTo(0.4, 5);
      // Links on counted days only: 10 (1) + 11 (2) + 14 (1) + 15 (1) — today and the
      // pre-window post on the 5th are not included.
      expect(r.linkCount).toBe(5);
    });

    it("ignores scheduled, null-url and blank-url links", async () => {
      const res = await getSubmissionGaps(params({ startDate: "2026-09-12", endDate: "2026-09-12" }));
      const r = row(res.rows, ids.asha, ids.igA);
      expect(r.countedDays).toBe(1);
      expect(r.activeDays).toBe(0);
      expect(r.missedRanges).toEqual([["2026-09-12", "2026-09-12"]]);
      expect(r.linkCount).toBe(0);
      expect(r.lastPostedAt).toBeNull();
    });

    it("respects the assignment start in IST (a 01:30 IST assignment is that IST day)", async () => {
      const res = await getSubmissionGaps(params());
      const r = row(res.rows, ids.asha, ids.fbB);
      // assigned_at is 2026-09-14T20:00Z — the 14th in UTC, the 15th in IST.
      expect(r.assignedSince).toBe("2026-09-15");
      expect(r.countedFrom).toBe("2026-09-15");
      expect(r.countedDays).toBe(5);
      expect(r.missedDays).toBe(5);
      expect(r.missedRanges).toEqual([["2026-09-15", "2026-09-19"]]);
      expect(r.currentGapDays).toBe(5);
      // The gap starts at the assignment, so it is exact — not "at least".
      expect(r.currentGapOpenEnded).toBe(false);
      expect(r.lastPostedAt).toBeNull();
    });

    it("marks a gap that reaches back past the window start as open-ended", async () => {
      const res = await getSubmissionGaps(params());
      const r = row(res.rows, ids.bilal, ids.igA);
      expect(r.countedDays).toBe(10);
      expect(r.missedDays).toBe(10);
      expect(r.currentGapDays).toBe(10);
      expect(r.currentGapOpenEnded).toBe(true);
      expect(r.missedRanges).toEqual([["2026-09-10", "2026-09-19"]]);
    });

    it("never counts today, and reports it separately", async () => {
      const res = await getSubmissionGaps(params());
      expect(res.range.includesToday).toBe(true);
      expect(res.range.countedThrough).toBe("2026-09-19");

      const ashaIg = row(res.rows, ids.asha, ids.igA);
      expect(ashaIg.todayStatus).toBe("posted");
      expect(ashaIg.todayLinks).toBe(1);
      // Today's post is the last post, in IST.
      expect(ashaIg.lastPostedIST).toBe("2026-09-20 08:30");
      expect(ashaIg.lastPostedAt).toBe("2026-09-20T03:00:00.000Z");
      expect(ashaIg.lastPostedApprox).toBe(false);

      expect(row(res.rows, ids.asha, ids.fbB).todayStatus).toBe("not_yet");
      expect(res.totals.notYetToday).toBe(3); // asha/fbB, bilal/igA, divya/fbB

      // A window of today only: nothing is countable yet, today still reported.
      const onlyToday = await getSubmissionGaps(params({ startDate: TODAY, endDate: TODAY }));
      const t = row(onlyToday.rows, ids.asha, ids.igA);
      expect(t.countedDays).toBe(0);
      expect(t.countedFrom).toBeNull();
      expect(t.missedDays).toBe(0);
      expect(t.activeRate).toBeNull();
      expect(t.todayStatus).toBe("posted");

      // A window ending before today carries no today status at all.
      const past = await getSubmissionGaps(params({ endDate: "2026-09-15" }));
      expect(past.range.includesToday).toBe(false);
      expect(row(past.rows, ids.asha, ids.igA).todayStatus).toBeNull();
      expect(past.totals.notYetToday).toBeNull();
      expect(row(past.rows, ids.asha, ids.igA).countedThrough).toBe("2026-09-15");
    });

    it("attributes a 00:30 IST post to its IST day and shows its IST time", async () => {
      const res = await getSubmissionGaps(params({ startDate: "2026-09-13", endDate: "2026-09-14" }));
      const r = row(res.rows, ids.asha, ids.igA);
      expect(r.activeDays).toBe(1);
      // The 14th is active and the 13th missed — a UTC reading would flip them.
      expect(r.missedRanges).toEqual([["2026-09-13", "2026-09-13"]]);
      expect(r.lastPostedIST).toBe("2026-09-14 00:30");
    });

    it("excludes pure admins, inactive people, past assignments and paused channels", async () => {
      const res = await getSubmissionGaps(params());
      const keys = res.rows.map((r) => `${r.employee.name}/${r.account.handle}`).sort();
      expect(keys).toEqual(["Asha/filmypage", "Asha/reelsdaily", "Bilal/reelsdaily", "Divya/filmypage"]);
      expect(res.totals.assignments).toBe(4);
      expect(res.totals.truncated).toBe(false);
      expect(res.excluded.inactiveChannelAssignments).toBe(1);
      // The paused channel's link on the 13th did not make the 13th active anywhere.
      expect(row(res.rows, ids.asha, ids.igA).missedRanges[0]).toEqual(["2026-09-12", "2026-09-13"]);
    });

    it("computes per-employee aggregates across all assigned channels", async () => {
      const res = await getSubmissionGaps(params());
      const asha = res.employees.find((e) => e.employee.id === ids.asha)!;
      expect(asha.accountCount).toBe(2);
      expect(asha.employee.team).toEqual({ id: ids.t1, name: "Team One" });
      expect(asha.countedDays).toBe(10);
      // Days with a link on at least one channel: 10, 11, 14, 15.
      expect(asha.activeDays).toBe(4);
      // Days with NO link on ANY assigned channel.
      expect(asha.missedDays).toBe(6);
      expect(asha.missedRanges).toEqual([
        ["2026-09-12", "2026-09-13"],
        ["2026-09-16", "2026-09-19"],
      ]);
      // The 15th: igA posted, fbB (assigned that day) did not.
      expect(asha.partialDays).toBe(1);
      expect(asha.missedChannelDays).toBe(11); // 6 on igA + 5 on fbB
      expect(asha.currentGapDays).toBe(4);
      expect(asha.currentGapOpenEnded).toBe(false);
      expect(asha.todayStatus).toBe("partial");
      expect(asha.todayPostedAccounts).toBe(1);
      expect(asha.linkCount).toBe(5);

      const bilal = res.employees.find((e) => e.employee.id === ids.bilal)!;
      expect(bilal.employee.team).toEqual({ id: ids.t2, name: "Team Two" }); // via membership
      expect(bilal.missedDays).toBe(10);
      expect(bilal.currentGapOpenEnded).toBe(true);
      expect(bilal.todayStatus).toBe("not_yet");
      expect(bilal.lastPostedAt).toBeNull();

      const divya = res.employees.find((e) => e.employee.id === ids.divya)!;
      expect(divya.countedDays).toBe(2);
      expect(divya.activeDays).toBe(1);
      expect(divya.currentGapDays).toBe(0);
      expect(res.employees).toHaveLength(3);
    });

    it("filters by team (primary team or membership), platform and employee", async () => {
      const t1 = await getSubmissionGaps(params({ teamId: ids.t1 }));
      expect(t1.rows.map((r) => r.account.handle).sort()).toEqual(["filmypage", "reelsdaily"]);
      expect(new Set(t1.rows.map((r) => r.employee.id))).toEqual(new Set([ids.asha]));

      const t2 = await getSubmissionGaps(params({ teamId: ids.t2 }));
      expect(t2.rows.map((r) => `${r.employee.name}/${r.account.handle}`)).toEqual(["Bilal/reelsdaily"]);

      const fb = await getSubmissionGaps(params({ platform: "facebook" }));
      expect(fb.rows.map((r) => r.employee.name).sort()).toEqual(["Asha", "Divya"]);
      // The employee aggregate is scoped to the filtered channels: fbB alone for Asha.
      const ashaFb = fb.employees.find((e) => e.employee.id === ids.asha)!;
      expect(ashaFb.accountCount).toBe(1);
      expect(ashaFb.missedDays).toBe(5);

      const one = await getSubmissionGaps(params({ employeeId: ids.bilal }));
      expect(one.rows).toHaveLength(1);
      expect(one.rows[0].employee.id).toBe(ids.bilal);

      // Filter options are returned regardless of the filter in force.
      expect(one.filters.teams.map((t) => t.name)).toEqual(["Team One", "Team Two"]);
      expect(one.filters.platforms.map((p) => p.slug).sort()).toEqual(["facebook", "instagram"]);
    });

    it("flags times before 2026-06-03 as approximate and uses the report's created time", async () => {
      const employeeRole = await prisma.role.findUniqueOrThrow({ where: { name: "Employee" } });
      const esha = await mkUser("Esha", [employeeRole.id]);
      await assign(esha, ids.igA, "2026-05-20T06:00:00.000Z");
      // Pre-cutover: the link's first_seen_at is a backfilled last-edit time (18:30 IST);
      // the report was first created at 10:30 IST — that is the time to show.
      await post(esha, ids.igA, "2026-06-01", {
        firstSeenAt: "2026-06-01T13:00:00.000Z",
        reportCreatedAt: "2026-06-01T05:00:00.000Z",
      });
      await post(esha, ids.igA, "2026-06-04", { firstSeenAt: "2026-06-04T09:15:00.000Z" });

      const days = await getSubmissionGapDays({
        employeeId: esha,
        accountId: ids.igA,
        startDate: "2026-05-30",
        endDate: "2026-06-05",
        today: "2026-06-06",
      });
      const june1 = days.days.find((d) => d.date === "2026-06-01")!;
      expect(june1.status).toBe("posted");
      expect(june1.approximate).toBe(true);
      expect(june1.firstPostedIST).toBe("2026-06-01 10:30");
      const june4 = days.days.find((d) => d.date === "2026-06-04")!;
      expect(june4.approximate).toBe(false);
      expect(june4.firstPostedIST).toBe("2026-06-04 14:45");

      // The summary's last-posted flag follows the same rule.
      const onlyJune1 = await getSubmissionGaps(
        params({ startDate: "2026-05-30", endDate: "2026-06-02", today: "2026-06-06", employeeId: esha }),
      );
      expect(onlyJune1.rows[0].lastPostedApprox).toBe(true);
      expect(onlyJune1.rows[0].lastPostedIST).toBe("2026-06-01 10:30");
      const withJune4 = await getSubmissionGaps(
        params({ startDate: "2026-05-30", endDate: "2026-06-05", today: "2026-06-06", employeeId: esha }),
      );
      expect(withJune4.rows[0].lastPostedApprox).toBe(false);
      expect(withJune4.rows[0].lastPostedIST).toBe("2026-06-04 14:45");
    });

    it("keeps only the most recent missed ranges per row and says so", async () => {
      const employeeRole = await prisma.role.findUniqueOrThrow({ where: { name: "Employee" } });
      const farah = await mkUser("Farah", [employeeRole.id]);
      await assign(farah, ids.igA, "2026-07-01T04:00:00.000Z");
      // Posts on every other day from 1 Jul (offset 0) to 19 Sep (offset 80): 40 one-day gaps.
      for (let i = 0; i <= 80; i += 2) await post(farah, ids.igA, shiftDay("2026-07-01", i));

      const res = await getSubmissionGaps(params({ startDate: "2026-07-01", employeeId: farah }));
      const r = res.rows[0];
      expect(r.countedDays).toBe(81);
      expect(r.activeDays).toBe(41);
      expect(r.missedRangeCount).toBe(40);
      expect(r.missedRanges).toHaveLength(MAX_RANGES_PER_ROW);
      expect(r.missedRangesTruncated).toBe(true);
      // The newest 20, in chronological order: offsets 41, 43 … 79.
      expect(r.missedRanges[0]).toEqual([shiftDay("2026-07-01", 41), shiftDay("2026-07-01", 41)]);
      expect(r.missedRanges[MAX_RANGES_PER_ROW - 1]).toEqual(["2026-09-18", "2026-09-18"]);
      expect(r.longestGapDays).toBe(1);
      expect(r.currentGapDays).toBe(0);
    });

    it("serves repeat calls from the 60s memo until invalidated", async () => {
      const first = await getSubmissionGaps(params({ employeeId: ids.bilal }));
      expect(first.rows[0].activeDays).toBe(0);

      await post(ids.bilal, ids.igA, "2026-09-18");
      const cached = await getSubmissionGaps(params({ employeeId: ids.bilal }));
      expect(cached).toBe(first); // same promise result — no recompute inside the TTL

      invalidateSubmissionGapsCache();
      const fresh = await getSubmissionGaps(params({ employeeId: ids.bilal }));
      expect(fresh.rows[0].activeDays).toBe(1);
      expect(fresh.rows[0].currentGapDays).toBe(1); // the 19th
    });
  });

  describe("submission gaps — day-by-day", () => {
    it("returns one row per day, newest first, with IST times", async () => {
      const res = await getSubmissionGapDays({
        employeeId: ids.asha,
        accountId: ids.igA,
        startDate: START,
        endDate: END,
        today: TODAY,
      });
      expect(res.assignedSince).toBe("2026-09-01");
      expect(res.days.map((d) => d.date)).toEqual([
        "2026-09-20", "2026-09-19", "2026-09-18", "2026-09-17", "2026-09-16", "2026-09-15",
        "2026-09-14", "2026-09-13", "2026-09-12", "2026-09-11", "2026-09-10",
      ]);
      const byDate = Object.fromEntries(res.days.map((d) => [d.date, d]));
      expect(byDate["2026-09-20"].status).toBe("today_posted");
      expect(byDate["2026-09-19"].status).toBe("missed");
      expect(byDate["2026-09-12"].status).toBe("missed"); // scheduled/null/blank only
      expect(byDate["2026-09-12"].linkCount).toBe(0);
      expect(byDate["2026-09-11"]).toMatchObject({ status: "posted", linkCount: 2 });
      expect(byDate["2026-09-14"].firstPostedIST).toBe("2026-09-14 00:30");
      expect(byDate["2026-09-14"].firstPostedAt).toBe("2026-09-13T19:00:00.000Z");
      expect(byDate["2026-09-15"].lastPostedIST).toBe("2026-09-15 18:15");
      expect(byDate["2026-09-19"].firstPostedAt).toBeNull();
    });

    it("starts at the assignment day and marks today pending", async () => {
      const res = await getSubmissionGapDays({
        employeeId: ids.asha,
        accountId: ids.fbB,
        startDate: START,
        endDate: END,
        today: TODAY,
      });
      expect(res.days.map((d) => d.date)).toEqual([
        "2026-09-20", "2026-09-19", "2026-09-18", "2026-09-17", "2026-09-16", "2026-09-15",
      ]);
      expect(res.days[0].status).toBe("today_pending");
    });

    it("404s for a pair that is not a current assignment", async () => {
      await expect(
        getSubmissionGapDays({ employeeId: ids.bilal, accountId: ids.fbB, startDate: START, endDate: END, today: TODAY }),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("submission gaps — parameter validation", () => {
    it("defaults to the 30 days ending today", () => {
      const p = parseSubmissionGapsQuery({}, TODAY);
      expect(p).toMatchObject({ startDate: shiftDay(TODAY, -29), endDate: TODAY, today: TODAY });
    });

    it("rejects malformed, impossible, reversed and over-long ranges with 400", () => {
      const bad: Record<string, unknown>[] = [
        { startDate: "2026-9-1" },
        { startDate: "2026-02-30" },
        { endDate: "2026-13-01" },
        { startDate: "2026-09-20", endDate: "2026-09-10" },
        { startDate: "2025-09-19", endDate: "2026-09-20" }, // 367 days
        { platform: "Instagram; DROP" },
        { teamId: "x".repeat(65) },
      ];
      for (const q of bad) expect400(() => parseSubmissionGapsQuery(q, TODAY), JSON.stringify(q));
      // Exactly 366 days is allowed.
      expect(parseSubmissionGapsQuery({ startDate: "2025-09-20", endDate: "2026-09-20" }, TODAY).startDate).toBe(
        "2025-09-20",
      );
      expect400(() => parseSubmissionGapDaysQuery({ employeeId: "a" }, TODAY), "missing accountId");
    });
  });

  describe("submission gaps — routes", () => {
    const today = todayIST();
    const from = shiftDay(today, -6);

    it("requires authentication (401) and the reports.view permission (403)", async () => {
      const anon = await request(app).get(`/v1/admin/reports/submission-gaps?startDate=${from}&endDate=${today}`);
      expect(anon.status).toBe(401);

      const employeeToken = generateToken(ids.asha, "asha@test.local", ["Employee"]);
      const forbidden = await request(app)
        .get(`/v1/admin/reports/submission-gaps?startDate=${from}&endDate=${today}`)
        .set("Authorization", `Bearer ${employeeToken}`);
      expect(forbidden.status).toBe(403);

      const forbiddenDays = await request(app)
        .get(`/v1/admin/reports/submission-gaps/days?employeeId=${ids.asha}&accountId=${ids.igA}`)
        .set("Authorization", `Bearer ${employeeToken}`);
      expect(forbiddenDays.status).toBe(403);
    });

    it("returns the summary envelope and a clean 400 for a bad range", async () => {
      const ok = await request(app)
        .get(`/v1/admin/reports/submission-gaps?startDate=${from}&endDate=${today}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(ok.status).toBe(200);
      expect(ok.body.success).toBe(true);
      expect(ok.body.data.range).toMatchObject({ startDate: from, endDate: today, today, includesToday: true });
      expect(Array.isArray(ok.body.data.rows)).toBe(true);
      expect(ok.body.data.rows.length).toBe(4);

      const bad = await request(app)
        .get(`/v1/admin/reports/submission-gaps?startDate=${shiftDay(today, -400)}&endDate=${today}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(bad.status).toBe(400);
      expect(bad.body.success).toBe(false);
      expect(bad.body.error.code).toBe("INVALID_PARAMS");
    });

    it("serves the day-by-day view, 400 without ids and 404 for a non-current pair", async () => {
      const ok = await request(app)
        .get(`/v1/admin/reports/submission-gaps/days?employeeId=${ids.asha}&accountId=${ids.igA}&startDate=${from}&endDate=${today}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(ok.status).toBe(200);
      expect(ok.body.data.days.length).toBe(7);

      const missing = await request(app)
        .get(`/v1/admin/reports/submission-gaps/days?employeeId=${ids.asha}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(missing.status).toBe(400);

      const notCurrent = await request(app)
        .get(`/v1/admin/reports/submission-gaps/days?employeeId=${ids.bilal}&accountId=${ids.fbB}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(notCurrent.status).toBe(404);
    });
  });
});
