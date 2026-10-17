/**
 * creator-payout-cron.test.ts — the linked-account activation poll (cron/creator-payout.cron.ts).
 *
 * Razorpay sends no notification when an account activates or fails verification, so a 5-minute poll keeps
 * the status true. What these pin: who is polled and how often, the 20-call budget, the skip while a setup
 * holds the lease, the failure brakes (cooldown, three-in-a-row stop, overlap guard), staff being told ONCE
 * per episode (field references only), the hourly digest of bank-change requests that staff have left
 * waiting over 24 hours, and the privacy rule: the product answer echoes the full account number and
 * Razorpay's free-text descriptions, and neither reaches a column, a log line or an email. The log spy
 * (tests/payout-privacy.ts) renders an Error's message and stack, so "never logs a body" cannot pass blind.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import { notifyAdminByEmail } from "../src/services/email.service";
import { FakeRazorpay, is } from "./fake-razorpay-route";
import { captureConsole, renderLogArgs, scanDatabase as scan } from "./payout-privacy";
import { flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { PRE_PAYOUT_TERMS_VERSION } from "../src/services/creator/creator-config";
import { TICK_CALL_BUDGET, resetCreatorPayoutCronForTests, runCreatorPayoutTick, warnIfPayoutTermsPending } from "../src/cron/creator-payout.cron";

const notifyMock = vi.mocked(notifyAdminByEmail);
const fake = new FakeRazorpay();
const ACCOUNT_NUMBER = "60987654321012";
const PAN = "ABCPE1234F";
let n = 0;

interface SeedOpts {
  status?: string;
  setupStep?: string;
  lastCheckedAt?: Date | null;
  lastError?: string | null;
  setupLockedUntil?: Date | null;
  product?: boolean;
  fakeStatus?: string;
  requirements?: any[];
  settlements?: any;
  creator?: boolean;
}

/** One account row (and the matching account in the fake). Returns ids for assertions. */
async function seed(o: SeedOpts = {}) {
  const k = ++n;
  const accountId = `acc_PollAcct${String(k).padStart(3, "0")}x`;
  const productId = `acc_prd_PollProd${String(k).padStart(3, "0")}x`;
  let creatorId = randomUUID();
  if (o.creator) {
    const c = await prisma.creator.create({ data: { email: `poll-${Date.now()}-${k}@creators.test`, passwordHash: "x", name: "Asha Iyer", status: "approved", emailVerifiedAt: new Date() } });
    creatorId = c.id;
  }
  fake.seedAccount({ id: accountId, email: `poll${k}@x.test`, productId, status: o.fakeStatus ?? o.status ?? "under_review", requirements: o.requirements ?? [], settlements: o.settlements });
  const row = await prisma.creatorPayoutAccount.create({
    data: {
      creatorId,
      razorpayAccountId: accountId,
      razorpayProductId: o.product === false ? null : productId,
      setupStep: o.setupStep ?? "done",
      activationStatus: o.status ?? "under_review",
      requirements: [],
      lastCheckedAt: o.lastCheckedAt === undefined ? null : o.lastCheckedAt,
      lastError: o.lastError ?? null,
      setupLockedUntil: o.setupLockedUntil ?? null,
    },
  });
  return { row, accountId, productId, creatorId };
}

const polled = () => fake.calls.filter(is.fetchProduct).map((c) => c.path.split("/")[2]);
const reload = (id: string) => prisma.creatorPayoutAccount.findUniqueOrThrow({ where: { id } });
const ago = (ms: number, base = Date.now()) => new Date(base - ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

let logged: string[] = [];
const consoleSpies: Array<{ mockRestore: () => void }> = [];
function spyConsole() {
  const c = captureConsole();
  logged = c.lines;
  consoleSpies.push({ mockRestore: c.restore });
}

beforeEach(() => {
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
  vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
  fake.reset();
  fake.install();
  notifyMock.mockClear();
  resetPayoutAlertsForTests();
  resetCreatorPayoutCronForTests();
});
afterEach(async () => {
  await flushPayoutAlertsForTests();
  fake.restore();
  while (consoleSpies.length) consoleSpies.pop()!.mockRestore();
  vi.unstubAllEnvs();
});
afterAll(() => fake.restore());

describe("the activation poll", () => {
  it("does nothing, and asks nobody, while the Razorpay keys are absent or the kill switch is set", async () => {
    await seed();
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    expect(await runCreatorPayoutTick()).toMatchObject({ ran: false, polled: 0 });
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
    expect(await runCreatorPayoutTick()).toMatchObject({ ran: false, polled: 0 });
    expect(fake.calls).toHaveLength(0);
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "1");
    expect((await runCreatorPayoutTick()).ran).toBe(true);
  });

  it("runs without the route switch: switching the feature off never stops reconciling an account", async () => {
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "0");
    const a = await seed();
    expect(await runCreatorPayoutTick()).toMatchObject({ ran: true, polled: 1 });
    expect(polled()).toEqual([a.accountId]);
  });

  it("applies what Razorpay says through the shared mapping, takes the masked hint from its echo, and keeps no number or description", async () => {
    spyConsole();
    const a = await seed({
      fakeStatus: "activated",
      settlements: { account_number: ACCOUNT_NUMBER, ifsc_code: "HDFC0001234", beneficiary_name: "Echoed Name Zorbaxia" },
      requirements: [{ field_reference: "settlements.ifsc_code", reason_code: "kyc_failed", status: "required", description: `Account ${ACCOUNT_NUMBER} and PAN ${PAN} do not match` }],
    });
    const out = await runCreatorPayoutTick();
    expect(out).toMatchObject({ ran: true, polled: 1, changed: 1, failed: 0 });
    const r = await reload(a.row.id);
    expect(r.activationStatus).toBe("activated");
    expect(r.activatedAt).not.toBeNull();
    expect(r.bookableAfter!.getTime() - r.activatedAt!.getTime()).toBe(86_400_000);
    expect(r.destinationHint).toBe("HDFC ••••1012");
    expect(r.lastCheckedAt).not.toBeNull();
    expect(await scan([ACCOUNT_NUMBER, PAN, "Echoed Name Zorbaxia"])).toEqual([]);
    expect(logged.join("\n")).not.toContain(ACCOUNT_NUMBER);
    // a second tick has nothing due: an activated account is checked once a day
    fake.calls = [];
    expect(await runCreatorPayoutTick()).toMatchObject({ polled: 0 });
    expect(fake.calls).toHaveLength(0);
  });

  it("spends at most 20 Razorpay calls a tick and works through the rest on the next one", async () => {
    expect(TICK_CALL_BUDGET).toBe(20);
    for (let i = 0; i < 25; i++) await seed();
    expect(await runCreatorPayoutTick()).toMatchObject({ polled: 20 });
    expect(fake.calls).toHaveLength(20);
    fake.calls = [];
    expect(await runCreatorPayoutTick()).toMatchObject({ polled: 5 }); // the 20 just checked are not due again yet
    expect(new Set(polled()).size).toBe(5);
    fake.calls = [];
    expect(await runCreatorPayoutTick()).toMatchObject({ polled: 0 });
  });

  it("polls each account on its own cadence, oldest first, and skips what is not due, has no product, or is being set up", async () => {
    const now = new Date();
    const t = (ms: number | null) => (ms === null ? null : ago(ms, now.getTime()));
    const rows = {
      doneFresh: await seed({ lastCheckedAt: t(3 * MIN) }), // done, non-final: every 4+ minutes
      doneDue: await seed({ lastCheckedAt: t(5 * MIN) }),
      neverChecked: await seed({ lastCheckedAt: null }),
      clarification: await seed({ status: "needs_clarification", lastCheckedAt: t(10 * MIN) }),
      requested: await seed({ status: "requested", lastCheckedAt: t(10 * MIN) }),
      midFresh: await seed({ setupStep: "product", lastCheckedAt: t(30 * MIN) }), // setup unfinished: hourly
      midDue: await seed({ setupStep: "product", lastCheckedAt: t(61 * MIN) }),
      activeFresh: await seed({ status: "activated", lastCheckedAt: t(23 * HOUR) }), // final: daily
      activeDue: await seed({ status: "activated", lastCheckedAt: t(25 * HOUR) }),
      suspendedDue: await seed({ status: "suspended", lastCheckedAt: t(25 * HOUR) }),
      noProduct: await seed({ product: false }),
      leased: await seed({ lastCheckedAt: null, setupLockedUntil: new Date(now.getTime() + 60_000) }),
      leaseExpired: await seed({ lastCheckedAt: t(10 * MIN), setupLockedUntil: new Date(now.getTime() - 1000) }),
    };
    const out = await runCreatorPayoutTick({ now, budget: 50 });
    const expected = ["doneDue", "neverChecked", "clarification", "requested", "midDue", "activeDue", "suspendedDue", "leaseExpired"];
    expect(new Set(polled())).toEqual(new Set(expected.map((k) => (rows as any)[k].accountId)));
    expect(out.polled).toBe(expected.length);
    // the oldest check is asked first (never-checked rows before any dated one)
    expect(polled()[0]).toBe(rows.neverChecked.accountId);
  });

  it("an unchanged answer stamps last_checked_at, so the account is not asked again at once", async () => {
    const a = await seed({ fakeStatus: "under_review" });
    expect(await runCreatorPayoutTick()).toMatchObject({ polled: 1, changed: 0 });
    expect((await reload(a.row.id)).lastCheckedAt).not.toBeNull();
    fake.calls = [];
    expect(await runCreatorPayoutTick()).toMatchObject({ polled: 0 });
  });
});

describe("telling staff", () => {
  const reqs = [{ field_reference: "settlements.ifsc_code", reason_code: "kyc_failed", status: "required", description: `Your PAN ${PAN} is wrong` }];

  it("alerts ONCE when a finished setup needs clarification (field references only), stamps it, clears the stamp, and alerts again on a relapse", async () => {
    const a = await seed({ creator: true, fakeStatus: "needs_clarification", requirements: reqs, status: "under_review" });
    expect(await runCreatorPayoutTick()).toMatchObject({ changed: 1, alerted: 1 });
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const [subject, details, path] = notifyMock.mock.calls[0] as any;
    expect(subject).toBe("Creator payout account needs clarification");
    const text = JSON.stringify(details);
    expect(text).toContain("settlements.ifsc_code (kyc_failed)");
    expect(text).toContain(a.accountId);
    expect(text).not.toContain(PAN);
    expect(path).toBe(`/creators/${a.creatorId}`);
    expect((await reload(a.row.id)).lastError).toBe("alerted:needs_clarification");

    // still needs clarification on the next due poll: no second alert. The mailer's in-memory quiet hour is
    // forgotten first (a restart, or an hour later), so only the STORED stamp stands between staff and a repeat.
    resetPayoutAlertsForTests();
    await prisma.creatorPayoutAccount.update({ where: { id: a.row.id }, data: { lastCheckedAt: ago(10 * MIN) } });
    expect(await runCreatorPayoutTick()).toMatchObject({ polled: 1, alerted: 0 });
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(1);

    // it recovers: the stamp is cleared
    fake.setStatus(a.accountId, "under_review", []);
    await prisma.creatorPayoutAccount.update({ where: { id: a.row.id }, data: { lastCheckedAt: ago(10 * MIN) } });
    await runCreatorPayoutTick();
    expect((await reload(a.row.id)).lastError).toBeNull();

    // and relapses: staff hear about it again (an hour later, so the mailer's quiet hour has passed)
    resetPayoutAlertsForTests();
    fake.setStatus(a.accountId, "needs_clarification", reqs);
    await prisma.creatorPayoutAccount.update({ where: { id: a.row.id }, data: { lastCheckedAt: ago(10 * MIN) } });
    expect(await runCreatorPayoutTick()).toMatchObject({ alerted: 1 });
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it("does not alert for the clarification Razorpay shows MID-setup (bank details not sent yet)", async () => {
    await seed({ creator: true, setupStep: "product", fakeStatus: "needs_clarification", requirements: reqs, status: "needs_clarification", lastCheckedAt: ago(2 * HOUR) });
    expect(await runCreatorPayoutTick()).toMatchObject({ polled: 1, alerted: 0 });
    await flushPayoutAlertsForTests();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("alerts when an activated account is found suspended (the daily poll is how that is noticed)", async () => {
    const a = await seed({ creator: true, status: "activated", fakeStatus: "suspended", lastCheckedAt: ago(25 * HOUR) });
    expect(await runCreatorPayoutTick()).toMatchObject({ changed: 1, alerted: 1 });
    await flushPayoutAlertsForTests();
    expect(String(notifyMock.mock.calls[0][0])).toBe("Creator payout account suspended by Razorpay");
    expect((await reload(a.row.id)).activationStatus).toBe("suspended");
    expect((await reload(a.row.id)).lastError).toBe("alerted:suspended");
  });

  it("a failed send is not stamped, so the next tick tries again", async () => {
    const a = await seed({ creator: true, fakeStatus: "needs_clarification", requirements: reqs });
    notifyMock.mockResolvedValueOnce(null as any); // the mailer's "not configured / send failed"
    await runCreatorPayoutTick();
    await flushPayoutAlertsForTests();
    expect((await reload(a.row.id)).lastError).toBeNull();
    await prisma.creatorPayoutAccount.update({ where: { id: a.row.id }, data: { lastCheckedAt: ago(10 * MIN) } });
    expect(await runCreatorPayoutTick()).toMatchObject({ alerted: 1 });
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect((await reload(a.row.id)).lastError).toBe("alerted:needs_clarification");
  });
});

describe("the instruments (controls)", () => {
  it("the console spy SEES an Error's message and stack, so 'never logs a body' is not vacuous", () => {
    spyConsole();
    const planted = "PLANTED-CRON-NEEDLE-5c1e";
    console.error("[creator-payout] poll failed", new Error(planted));
    expect(logged.join("\n")).toContain(planted);
    // what the old spy did: a plain stringify drops the message entirely
    expect(JSON.stringify(new Error(planted))).not.toContain(planted);
    expect(renderLogArgs([new Error(planted)])).toContain(planted);
  });
});

describe("the bank change digest", () => {
  const stamp = (row: { id: string }, requestedHoursAgo: number, now: Date, clearedHoursAgo?: number) =>
    prisma.creatorPayoutAccount.update({
      where: { id: row.id },
      data: {
        bankChangeRequestedAt: new Date(now.getTime() - requestedHoursAgo * HOUR),
        bankChangeClearedAt: clearedHoursAgo === undefined ? null : new Date(now.getTime() - clearedHoursAgo * HOUR),
      },
    });
  const emailOf = async (creatorId: string) => (await prisma.creator.findUniqueOrThrow({ where: { id: creatorId } })).email;
  const digestMails = () => notifyMock.mock.calls.filter((c) => String(c[0]).includes("bank change request"));

  async function seedScene(now: Date) {
    const waiting30 = await seed({ creator: true });
    const waiting50 = await seed({ creator: true });
    const recent = await seed({ creator: true });
    const cleared = await seed({ creator: true });
    const askedAgain = await seed({ creator: true });
    const never = await seed({ creator: true });
    await stamp(waiting30.row, 30, now);
    await stamp(waiting50.row, 50, now);
    await stamp(recent.row, 23, now);
    await stamp(cleared.row, 60, now, 40);
    await stamp(askedAgain.row, 25, now, 50); // cleared long ago, asked again: pending again
    return { waiting30, waiting50, recent, cleared, askedAgain, never };
  }

  it("emails ONE digest of the requests waiting over 24 hours, then stays quiet for the hour, repeats after it, and stops once they are cleared", async () => {
    spyConsole();
    const now = new Date();
    const sc = await seedScene(now);
    const out = await runCreatorPayoutTick({ now, budget: 50 });
    expect(out.bankChangesWaiting).toBe(3);
    expect(out.alerted).toBe(1);
    await flushPayoutAlertsForTests();
    expect(digestMails()).toHaveLength(1);
    const [subject, details, path] = digestMails()[0] as any;
    expect(subject).toBe("3 bank change requests waiting for staff");
    expect(path).toBe("/creators");
    const text = JSON.stringify(details);
    for (const k of ["waiting30", "waiting50", "askedAgain"] as const) expect(text, k).toContain(await emailOf((sc as any)[k].creatorId));
    for (const k of ["recent", "cleared", "never"] as const) expect(text, k).not.toContain(await emailOf((sc as any)[k].creatorId));
    expect(text).toContain("waiting 50h"); // the oldest is named first
    expect(text.indexOf("waiting 50h")).toBeLessThan(text.indexOf("waiting 30h"));
    expect(text).not.toContain(ACCOUNT_NUMBER);

    // ten minutes later: nothing more, and the check is not even run
    const t10 = new Date(now.getTime() + 10 * MIN);
    expect(await runCreatorPayoutTick({ now: t10, budget: 50 })).toMatchObject({ bankChangesWaiting: 0, alerted: 0 });
    await flushPayoutAlertsForTests();
    expect(digestMails()).toHaveLength(1);

    // an hour on, still uncleared: the digest repeats, and the request that was 23 hours old has now waited a day too
    const t61 = new Date(now.getTime() + 61 * MIN);
    expect(await runCreatorPayoutTick({ now: t61, budget: 50 })).toMatchObject({ bankChangesWaiting: 4, alerted: 1 });
    await flushPayoutAlertsForTests();
    expect(digestMails()).toHaveLength(2);
    expect(JSON.stringify((digestMails()[1] as any)[1])).toContain(await emailOf(sc.recent.creatorId));

    // staff clear them all: later there is nothing to say
    for (const k of ["waiting30", "waiting50", "askedAgain", "recent"] as const) {
      await prisma.creatorPayoutAccount.update({ where: { id: (sc as any)[k].row.id }, data: { bankChangeClearedAt: new Date(t61.getTime() + 5 * MIN) } });
    }
    const t130 = new Date(now.getTime() + 130 * MIN);
    expect(await runCreatorPayoutTick({ now: t130, budget: 50 })).toMatchObject({ bankChangesWaiting: 0, alerted: 0 });
    await flushPayoutAlertsForTests();
    expect(digestMails()).toHaveLength(2);
    expect(logged.join("\n")).not.toContain("digest failed");
  });

  it("a digest whose email failed is tried again at the next hourly pass", async () => {
    const now = new Date();
    await stamp((await seed({ creator: true })).row, 40, now);
    notifyMock.mockResolvedValueOnce(null as any); // the mailer's "not configured / send failed"
    expect(await runCreatorPayoutTick({ now })).toMatchObject({ bankChangesWaiting: 1, alerted: 1 });
    await flushPayoutAlertsForTests();
    expect(digestMails()).toHaveLength(1);
    const later = new Date(now.getTime() + 61 * MIN);
    expect(await runCreatorPayoutTick({ now: later })).toMatchObject({ bankChangesWaiting: 1, alerted: 1 });
    await flushPayoutAlertsForTests();
    expect(digestMails()).toHaveLength(2);
  });

  it("names at most 15 creators and says how many more wait", async () => {
    const now = new Date();
    for (let i = 0; i < 17; i++) await stamp((await seed({ creator: true })).row, 30 + i, now);
    expect(await runCreatorPayoutTick({ now, budget: 1 })).toMatchObject({ bankChangesWaiting: 17 });
    await flushPayoutAlertsForTests();
    const text = JSON.stringify((digestMails()[0] as any)[1]);
    expect(digestMails()[0][0]).toBe("17 bank change requests waiting for staff");
    expect(text).toContain("and 2 more");
    expect(text.match(/Asha Iyer/g)).toHaveLength(15);
  });

  it("says nothing when no request is waiting, and nothing at all without the Razorpay keys", async () => {
    const now = new Date();
    await stamp((await seed({ creator: true })).row, 5, now); // asked, but not for a day yet
    expect(await runCreatorPayoutTick({ now })).toMatchObject({ bankChangesWaiting: 0, alerted: 0 });
    await flushPayoutAlertsForTests();
    expect(digestMails()).toHaveLength(0);
    resetCreatorPayoutCronForTests();
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    await stamp((await seed({ creator: true })).row, 40, now);
    expect(await runCreatorPayoutTick({ now })).toMatchObject({ ran: false, bankChangesWaiting: 0 });
    await flushPayoutAlertsForTests();
    expect(digestMails()).toHaveLength(0);
  });
});

describe("a setup stopped at the bank call", () => {
  it("is settled to done by the poll once Razorpay activates the account (a lost answer can never lead to a second bank call)", async () => {
    const a = await seed({ setupStep: "product", status: "needs_clarification", fakeStatus: "activated", lastCheckedAt: ago(2 * HOUR) });
    expect(await runCreatorPayoutTick()).toMatchObject({ polled: 1, changed: 1 });
    expect(await reload(a.row.id)).toMatchObject({ setupStep: "done", activationStatus: "activated", lastError: null });
    // and it is now an ordinary activated account: checked daily
    fake.calls = [];
    expect(await runCreatorPayoutTick()).toMatchObject({ polled: 0 });
    // an account still under review is NOT settled: only an activation proves the bank details were applied
    const b = await seed({ setupStep: "product", status: "needs_clarification", fakeStatus: "under_review", lastCheckedAt: ago(2 * HOUR) });
    await runCreatorPayoutTick();
    expect(await reload(b.row.id)).toMatchObject({ setupStep: "product", activationStatus: "under_review" });
  });
});

describe("the boot check", () => {
  it("warns once at start-up when the switch is on but the terms are still the pre-payout ones, and says nothing otherwise", () => {
    spyConsole();
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
    vi.stubEnv("CREATOR_TERMS_VERSION", "");
    expect(warnIfPayoutTermsPending()).toBe(true);
    expect(logged.join("\n")).toContain("terms_pending");
    expect(logged.join("\n")).toContain(PRE_PAYOUT_TERMS_VERSION);
    logged.length = 0;
    vi.stubEnv("CREATOR_TERMS_VERSION", "2026-11-01");
    expect(warnIfPayoutTermsPending()).toBe(false);
    vi.stubEnv("CREATOR_TERMS_VERSION", "");
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "0");
    expect(warnIfPayoutTermsPending()).toBe(false);
    expect(logged).toEqual([]);
  });
});

describe("when Razorpay misbehaves", () => {
  it("counts a failure, leaves that account alone for a while, logs a code and never a body", async () => {
    spyConsole();
    const a = await seed();
    const b = await seed();
    fake.intercept({
      match: (c) => is.fetchProduct(c) && c.path.includes(a.accountId),
      mode: "reject",
      status: 500,
      body: { error: { code: "SERVER_ERROR", description: `internal error for account ${ACCOUNT_NUMBER} and PAN ${PAN}` } },
    });
    const out = await runCreatorPayoutTick();
    expect(out).toMatchObject({ polled: 1, failed: 1 });
    expect(new Set(polled())).toEqual(new Set([a.accountId, b.accountId])); // both were asked (their order is not defined)
    const text = logged.join("\n");
    expect(text).toContain(`poll failed for ${a.row.id}`);
    expect(text).toContain("SERVER_ERROR 500"); // a code and a status
    expect(text).not.toContain(ACCOUNT_NUMBER);
    expect(text).not.toContain(PAN);
    expect(text).not.toContain("internal error"); // Razorpay's description (it reaches RazorpayError.message)
    // and not an Error object either: its name and a stack frame are what logging `e` would add
    expect(text).not.toContain("RazorpayError");
    expect(text).not.toMatch(/\n\s+at \S+/);

    // the failed account is skipped for 30 minutes (in memory); the other is simply not due yet
    fake.calls = [];
    await prisma.creatorPayoutAccount.updateMany({ data: { lastCheckedAt: ago(10 * MIN) } });
    expect(await runCreatorPayoutTick()).toMatchObject({ polled: 1, failed: 0 });
    expect(polled()).toEqual([b.accountId]);
  });

  it("stops after three failures in a row (Razorpay is down) instead of spending the whole budget", async () => {
    for (let i = 0; i < 6; i++) await seed();
    fake.intercept({ match: is.fetchProduct, mode: "reject", status: 503, body: { error: { code: "SERVER_ERROR", description: "down" } }, times: 99 });
    const out = await runCreatorPayoutTick();
    expect(out.failed).toBe(3);
    expect(fake.calls).toHaveLength(3);
  });

  it("tells staff once when Razorpay refuses our credentials", async () => {
    await seed();
    await seed();
    fake.intercept({ match: is.fetchProduct, mode: "reject", status: 401, body: { error: { code: "BAD_REQUEST_ERROR", description: "The api key provided is invalid" } }, times: 9 });
    expect(await runCreatorPayoutTick()).toMatchObject({ failed: 2 });
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(1); // one per hour, however many accounts failed
    expect(String(notifyMock.mock.calls[0][0])).toContain("refused");
  });

  it("never runs two ticks at once", async () => {
    await seed();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.intercept({ match: is.fetchProduct, mode: "hold", gate });
    const first = runCreatorPayoutTick();
    await vi.waitFor(() => expect(fake.calls.filter(is.fetchProduct)).toHaveLength(1));
    expect(await runCreatorPayoutTick()).toMatchObject({ ran: false, polled: 0 });
    release();
    expect(await first).toMatchObject({ ran: true, polled: 1 });
    expect(fake.calls.filter(is.fetchProduct)).toHaveLength(1);
    // and the flag is released afterwards
    expect((await runCreatorPayoutTick()).ran).toBe(true);
  });
});
