/**
 * creator-payout-cron.test.ts — the linked-account activation poll (cron/creator-payout.cron.ts).
 *
 * Razorpay sends no notification when an account activates or fails verification, so a 5-minute poll keeps
 * the status true. What these pin: who is polled and how often, the 20-call budget, the skip while a setup
 * holds the lease, the failure brakes (cooldown, three-in-a-row stop, overlap guard), staff being told ONCE
 * per episode (field references only), and the privacy rule: the product answer echoes the full account
 * number and Razorpay's free-text descriptions, and neither reaches a column, a log line or an email.
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
import { flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { TICK_CALL_BUDGET, resetCreatorPayoutCronForTests, runCreatorPayoutTick } from "../src/cron/creator-payout.cron";

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

async function scan(needles: string[]): Promise<string[]> {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
  const patterns = needles.map((x) => `%${x}%`);
  const hits: string[] = [];
  for (const { table_name } of tables) {
    const marks = patterns.map((_, i) => `$${i + 1}`).join(",");
    const rows = await prisma.$queryRawUnsafe<Array<{ c: number }>>(`SELECT count(*)::int AS c FROM "${table_name}" t WHERE t::text ILIKE ANY (ARRAY[${marks}])`, ...patterns);
    if (rows[0].c > 0) hits.push(table_name);
  }
  return hits;
}

let logged: string[] = [];
const consoleSpies: Array<{ mockRestore: () => void }> = [];
function spyConsole() {
  logged = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))));
  }
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
    expect(text).not.toContain(ACCOUNT_NUMBER);
    expect(text).not.toContain(PAN);
    expect(text).not.toContain("internal error");

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
