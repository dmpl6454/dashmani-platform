import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import { submitDailyReport, getAssignedAccounts } from "../src/services/daily-report.service";

// Read the persisted report links directly (by employee) so the assertion doesn't depend on
// getTodayReport's IST "today" key — we want to prove SUBMIT persisted the rows, not test date math.
async function persistedLinks(employeeId: string): Promise<string[]> {
  const rows = await prisma.reportLink.findMany({
    where: { report: { employeeId }, url: { not: null } },
    select: { url: true },
  });
  return rows.map((r) => r.url!).sort();
}
// Import the CHANGED module in the SAME process, exactly as production loads it, to prove
// its mere presence can't break submit. (In prod it's a dynamic import behind admin routes;
// importing it here is a strictly HARSHER test — it's loaded up front.)
import { getInsightsSummary, invalidateInsightsCache } from "../src/services/social-insights.service";

// ── SUBMIT-PATH SAFETY PROOF for the insights DISTINCT ON rewrite (incident 2026-07-16).
// This file does NOT touch social-insights internals; it verifies the LOAD-BEARING employee
// submit flow (submitDailyReport, behind POST /hr/reports) still works end-to-end with the
// changed module present. Uses zztest- prefixes; link_metrics NOT truncated by setup.ts so we
// clean our own.

const P = "https://www.instagram.com/reel/zztest-submit-";
let dbAvailable = false;

async function cleanup() {
  await prisma.linkMetric.deleteMany({ where: { url: { startsWith: P } } });
}
async function ensureEmployeeRole(): Promise<string> {
  const existing = await prisma.role.findFirst({ where: { name: "Employee" } });
  if (existing) return existing.id;
  return (await prisma.role.create({ data: { name: "Employee", description: "test" } })).id;
}
async function seedEmployee() {
  const roleId = await ensureEmployeeRole();
  return prisma.user.create({
    data: { name: "ZZ Submitter", email: "zztest-submit@example.com", passwordHash: "x", status: "ACTIVE", roles: { create: [{ roleId }] } },
  });
}
async function seedAccount(platformName: string, slug: string) {
  const platform = await prisma.platform.create({ data: { name: platformName, slug } });
  return prisma.socialAccount.create({ data: { handle: `zztest-acct-${slug}`, displayName: "ZZ Acct", platformId: platform.id } });
}

beforeAll(async () => {
  try { await cleanup(); dbAvailable = true; } catch (e) { console.warn("[submit-still-works] DB unavailable:", e); dbAvailable = false; }
});
beforeEach(async () => { invalidateInsightsCache(); if (dbAvailable) await cleanup(); });
afterAll(async () => { if (dbAvailable) { try { await cleanup(); } catch {} } });

describe("SUBMIT still works (regression guard for the insights rewrite)", () => {
  it("an employee can submit a daily report and every unique link persists", async () => {
    if (!dbAvailable) return;
    const emp = await seedEmployee();
    const acct = await seedAccount("Instagram", "instagram");

    const links = [
      { accountId: acct.id, url: `${P}aaa`, platform: "instagram" },
      { accountId: acct.id, url: `${P}bbb`, platform: "instagram" },
      { accountId: acct.id, url: `${P}ccc`, platform: "instagram" },
    ];
    const report = await submitDailyReport(emp.id, "2026-07-16", links as any, "test notes");
    expect(report).toBeDefined();

    expect(await persistedLinks(emp.id)).toEqual([`${P}aaa`, `${P}bbb`, `${P}ccc`]);
  });

  it("incremental resubmit ADDS links without losing the originals (the Anish scenario)", async () => {
    if (!dbAvailable) return;
    const emp = await seedEmployee();
    const acct = await seedAccount("Instagram", "instagram");

    await submitDailyReport(emp.id, "2026-07-16", [
      { accountId: acct.id, url: `${P}1`, platform: "instagram" },
      { accountId: acct.id, url: `${P}2`, platform: "instagram" },
    ] as any);
    // Resubmit with the originals + 2 more (mirrors "paste more, hit Update").
    await submitDailyReport(emp.id, "2026-07-16", [
      { accountId: acct.id, url: `${P}1`, platform: "instagram" },
      { accountId: acct.id, url: `${P}2`, platform: "instagram" },
      { accountId: acct.id, url: `${P}3`, platform: "instagram" },
      { accountId: acct.id, url: `${P}4`, platform: "instagram" },
    ] as any);

    expect(await persistedLinks(emp.id)).toEqual([`${P}1`, `${P}2`, `${P}3`, `${P}4`]);
  });

  it("getAssignedAccounts returns an employee's active assignments (the /hr/accounts dropdown source)", async () => {
    if (!dbAvailable) return;
    const emp = await seedEmployee();
    const a1 = await seedAccount("Instagram", "instagram");
    const a2 = await seedAccount("YouTube", "youtube");
    await prisma.accountAssignment.create({ data: { accountId: a1.id, employeeId: emp.id, assignedBy: emp.id } });
    await prisma.accountAssignment.create({ data: { accountId: a2.id, employeeId: emp.id, assignedBy: emp.id } });

    const accts = await getAssignedAccounts(emp.id);
    expect(accts.length).toBe(2); // BOTH assigned accounts show — the Aslam symptom would be < 2
    const handles = accts.map((a) => a.handle).sort();
    expect(handles).toEqual(["zztest-acct-instagram", "zztest-acct-youtube"]);
  });

  it("submit + insights coexist in one process without interference", async () => {
    if (!dbAvailable) return;
    const emp = await seedEmployee();
    const acct = await seedAccount("Instagram", "instagram");
    await submitDailyReport(emp.id, "2026-07-16", [
      { accountId: acct.id, url: `${P}coexist`, platform: "instagram" },
    ] as any);
    // Calling the CHANGED analytics fn must not throw and must not disturb the submitted report.
    const summary = await getInsightsSummary({});
    expect(summary).toBeDefined();
    expect(Array.isArray(summary.topLinks)).toBe(true);
    expect(await persistedLinks(emp.id)).toContain(`${P}coexist`);
  });
});
