/**
 * creator-admin-payout.test.ts — Phase 2 of the creator payouts, the STAFF side: the payout account on
 * GET /v1/admin/creators/:id and the action POST /v1/admin/creators/:id/payout-account/bank-change/cleared
 * (docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md, "Phase 2: Bank connect").
 *
 * What these pin:
 *   - the gate: no token, a non-admin employee, and client / HR / creator tokens are all refused, on the
 *     read and on the write, and a refused write changes nothing;
 *   - the response carries the creator's payout view plus ONLY the staff fields on the allow-list: the exact
 *     key sets are asserted, and a row poisoned with text a later phase might have stored is shown as nothing;
 *   - a failed payout read says so (payoutAccountError) instead of reading as "no payout account", and does
 *     not take the review page down;
 *   - "mark processed" works only while a request is open (409 otherwise), has exactly ONE winner when two
 *     clicks race, writes a scrubbed creator_payout_events row, emails the creator without bank details, and
 *     starts the 72-hour release pause;
 *   - ⚠️ PRIVACY: after a REAL setup (fake Razorpay echoing PAN, number and name back), a bank change request
 *     and the staff clearing it, no column of any table, no response, no log line and no email holds a
 *     submitted value, and no audit_logs row was written.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { hash } from "bcrypt";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import app from "../src/app";
import { sendEmail, notifyAdminByEmail } from "../src/services/email.service";
import { createTestUser, generateToken, generateClientToken, generateHrToken, generateCreatorToken } from "./helpers";
import { FakeRazorpay } from "./fake-razorpay-route";
import { creatorConfig } from "../src/services/creator/creator-config";
import { flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { BANK_CHANGE_HOLD_MS } from "../src/services/creator/payout-account-view";

const sendMock = vi.mocked(sendEmail);
const notifyMock = vi.mocked(notifyAdminByEmail);
const fake = new FakeRazorpay();
let n = 0;

// Distinctive values: each is searched for in every table, log line, email and response.
const SECRET = {
  pan: "ABCPE1234F",
  account: "60987654321012",
  ifsc: "HDFC0001234",
  name: "Zorbaxia Quillfeather",
  street: "Quillfeather Marg 77",
  street2: "Near Marker Tower",
  phone: "9123456780",
};
const NEEDLES = [SECRET.pan, SECRET.account, SECRET.ifsc, SECRET.name, SECRET.street, SECRET.street2, SECRET.phone];

const ADMIN_PAYOUT_KEYS = [
  "accountCreatedAt",
  "activatedAt",
  "bankChange",
  "bankChangePending",
  "bookableAfter",
  "destinationHint",
  "lastCheckedAt",
  "lastErrorCode",
  "razorpayAccountId",
  "razorpayProductId",
  "razorpayStakeholderId",
  "releaseHold",
  "requirements",
  "setupStep",
  "status",
  "termsVersion",
  "updatedAt",
];

async function seedCreator(over: Partial<{ name: string; status: string }> = {}) {
  const email = `adm-payout-${Date.now()}-${++n}@creators.test`;
  const c = await prisma.creator.create({
    data: {
      email,
      passwordHash: await hash("Creator@123", 4),
      name: over.name ?? "Asha Iyer",
      country: "IN",
      phone: "+91 98100 00000",
      status: over.status ?? "approved",
      emailVerifiedAt: new Date(),
      termsAcceptedAt: new Date(),
      submittedAt: new Date(),
    },
  });
  return { c, auth: `Bearer ${generateCreatorToken(c.id, c.email)}` };
}

const H = 3_600_000;

/** A finished account (all four steps done, under review) with whatever a test overrides. */
function seedAccount(creatorId: string, over: Record<string, unknown> = {}) {
  return prisma.creatorPayoutAccount.create({
    data: {
      creatorId,
      razorpayAccountId: `acc_Adm${++n}x`,
      razorpayStakeholderId: `sth_Adm${n}x`,
      razorpayProductId: `acc_prd_Adm${n}x`,
      setupStep: "done",
      activationStatus: "under_review",
      destinationHint: "HDFC ••••1012",
      termsVersion: creatorConfig.termsVersion(),
      accountCreatedAt: new Date(Date.now() - 2 * H),
      lastCheckedAt: new Date(Date.now() - 5 * 60_000),
      ...over,
    },
  });
}

const getDetail = (auth: string, id: string) => request(app).get(`/v1/admin/creators/${id}`).set("Authorization", auth);
const clear = (auth: string, id: string) => request(app).post(`/v1/admin/creators/${id}/payout-account/bank-change/cleared`).set("Authorization", auth);
const eventsOf = (accountId: string) => prisma.creatorPayoutEvent.findMany({ where: { payoutId: accountId }, orderBy: { createdAt: "asc" } });
const rowOf = (creatorId: string) => prisma.creatorPayoutAccount.findUnique({ where: { creatorId } });

/** Every table, every column (as the row's text): which tables hold any needle. */
async function scanDatabase(needles: string[] = NEEDLES): Promise<string[]> {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`;
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
  const text = (a: unknown) => {
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a, Object.getOwnPropertyNames(a as object));
    } catch {
      return String(a);
    }
  };
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    consoleSpies.push(
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(text).join(" "));
      }),
    );
  }
}

function expectNoSecrets(where: string, haystack: unknown) {
  const s = typeof haystack === "string" ? haystack : JSON.stringify(haystack);
  for (const needle of NEEDLES) expect(s, `${where} must not contain ${needle}`).not.toContain(needle);
}

describe("Creator admin: payout account", () => {
  let staff: { id: string; email: string };
  let admin: string;

  beforeEach(async () => {
    vi.stubEnv("CREATORS_ENABLED", "1");
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
    vi.stubEnv("RATE_LIMIT_CREATOR_PAYOUT_MAX", "1000");
    fake.reset();
    fake.install();
    sendMock.mockClear();
    notifyMock.mockClear();
    resetPayoutAlertsForTests();
    staff = await createTestUser({ name: "Review Staff" });
    admin = `Bearer ${generateToken(staff.id, staff.email, ["Admin"])}`;
  });
  afterEach(async () => {
    await flushPayoutAlertsForTests();
    fake.restore();
    vi.restoreAllMocks();
    while (consoleSpies.length) consoleSpies.pop()!.mockRestore();
    vi.unstubAllEnvs();
  });
  afterAll(() => {
    fake.restore();
  });

  // ── Gate ───────────────────────────────────────────────────────────────────────────────────

  describe("gate", () => {
    it("refuses no token, a non-admin employee, and client / HR / creator tokens on the read AND on the write; a refused write changes nothing", async () => {
      const { c, auth: creatorAuth } = await seedCreator();
      const requestedAt = new Date(Date.now() - H);
      const acc = await seedAccount(c.id, { bankChangeRequestedAt: requestedAt });

      const tokens: Array<[string, string | null, number[]]> = [
        ["no token", null, [401]],
        ["a non-admin employee", `Bearer ${generateToken(staff.id, staff.email, ["Employee"])}`, [403]],
        ["a client token", `Bearer ${generateClientToken(staff.id, staff.email)}`, [403]],
        ["an HR token (even for an admin user)", `Bearer ${generateHrToken(staff.id, staff.email, ["Admin"])}`, [403]],
        ["a creator token (the creator's own)", creatorAuth, [401, 403]],
      ];
      for (const [label, token, allowed] of tokens) {
        const read = token ? await getDetail(token, c.id) : await request(app).get(`/v1/admin/creators/${c.id}`);
        expect(allowed, `read with ${label}: ${read.status}`).toContain(read.status);
        expect(JSON.stringify(read.body)).not.toContain(acc.razorpayAccountId!);
        const write = token
          ? await clear(token, c.id)
          : await request(app).post(`/v1/admin/creators/${c.id}/payout-account/bank-change/cleared`);
        expect(allowed, `write with ${label}: ${write.status}`).toContain(write.status);
      }

      const row = (await rowOf(c.id))!;
      expect(row.bankChangeClearedAt).toBeNull();
      expect(row.bankChangeRequestedAt!.getTime()).toBe(requestedAt.getTime());
      expect(await eventsOf(acc.id)).toHaveLength(0);
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  // ── Detail ─────────────────────────────────────────────────────────────────────────────────

  describe("detail", () => {
    it("a creator with no payout account reads as null (not an error), with the switch state", async () => {
      const { c } = await seedCreator();
      const res = await getDetail(admin, c.id);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(Object.keys(res.body.data).sort()).toEqual(["assets", "connection", "creator", "payoutAccount", "payoutAccountError", "payoutRouteEnabled"]);
      expect(res.body.data).toMatchObject({ payoutAccount: null, payoutAccountError: false, payoutRouteEnabled: true });

      // Dark: the switch is off, so the screen can say why nothing is there. Nothing else about the response changes.
      vi.stubEnv("CREATOR_ROUTE_ENABLED", "");
      const dark = await getDetail(admin, c.id);
      expect(dark.status).toBe(200);
      expect(dark.body.data).toMatchObject({ payoutAccount: null, payoutAccountError: false, payoutRouteEnabled: false });
    });

    it("shows the creator's view plus exactly the staff fields, and not one key more", async () => {
      const { c } = await seedCreator();
      const requestedAt = new Date(Date.now() - 3 * H);
      const acc = await seedAccount(c.id, {
        activationStatus: "needs_clarification",
        requirements: [
          { field_reference: "settlements.ifsc_code", reason_code: "field_missing", status: "required" },
          { field_reference: "kyc.pan", reason_code: "invalid_value", status: "needs_clarification" },
          { field_reference: "phone", reason_code: "x", status: "resolved" },
        ],
        lastError: "ACCOUNT_UNKNOWN",
        bankChangeRequestedAt: requestedAt,
      });

      const res = await getDetail(admin, c.id);
      expect(res.status).toBe(200);
      const view = res.body.data.payoutAccount;
      expect(Object.keys(view).sort()).toEqual(ADMIN_PAYOUT_KEYS);
      expect(Object.keys(view.bankChange).sort()).toEqual(["clearedAt", "requestedAt"]);
      expect(Object.keys(view.releaseHold).sort()).toEqual(["active", "resumesAt"]);
      for (const r of view.requirements) expect(Object.keys(r).sort()).toEqual(["field", "reason"]);
      expect(view).toMatchObject({
        status: "needs_clarification",
        setupStep: "done",
        destinationHint: "HDFC ••••1012",
        razorpayAccountId: acc.razorpayAccountId,
        razorpayStakeholderId: acc.razorpayStakeholderId,
        razorpayProductId: acc.razorpayProductId,
        lastErrorCode: "ACCOUNT_UNKNOWN",
        termsVersion: creatorConfig.termsVersion(),
        bankChange: { requestedAt: requestedAt.toISOString(), clearedAt: null },
        bankChangePending: true,
        releaseHold: { active: true, resumesAt: null },
        activatedAt: null,
        bookableAfter: null,
      });
      expect(view.requirements).toEqual([
        { field: "settlements.ifsc_code", reason: "field_missing" },
        { field: "kyc.pan", reason: "invalid_value" },
      ]);
      expect(view.lastCheckedAt).toBe(acc.lastCheckedAt!.toISOString());
      expect(view.accountCreatedAt).toBe(acc.accountCreatedAt!.toISOString());
    });

    it("after staff cleared a request the hold shows when releases resume; a long-cleared one shows no hold", async () => {
      const { c } = await seedCreator();
      const clearedAt = new Date(Date.now() - 10 * H);
      await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - 20 * H), bankChangeClearedAt: clearedAt });
      let res = await getDetail(admin, c.id);
      expect(res.body.data.payoutAccount).toMatchObject({
        bankChangePending: false,
        releaseHold: { active: true, resumesAt: new Date(clearedAt.getTime() + BANK_CHANGE_HOLD_MS).toISOString() },
      });

      await prisma.creatorPayoutAccount.update({
        where: { creatorId: c.id },
        data: { bankChangeRequestedAt: new Date(Date.now() - 100 * H), bankChangeClearedAt: new Date(Date.now() - 80 * H) },
      });
      res = await getDetail(admin, c.id);
      expect(res.body.data.payoutAccount).toMatchObject({ bankChangePending: false, releaseHold: { active: false, resumesAt: null } });
    });

    it("a row holding text no phase should have stored shows as nothing: free-text errors, odd ids, a bare number as a hint, extra requirement keys", async () => {
      const { c } = await seedCreator();
      await seedAccount(c.id, {
        razorpayAccountId: "acc bad id with spaces",
        razorpayStakeholderId: SECRET.account,
        razorpayProductId: "acc_prd_fine1",
        destinationHint: SECRET.account,
        lastError: `Razorpay said ${SECRET.name} at ${SECRET.street} ${SECRET.ifsc} ${SECRET.pan}`,
        activationStatus: "needs_clarification",
        requirements: [
          {
            field_reference: "settlements.ifsc_code",
            reason_code: "field_missing",
            status: "required",
            description: `please fix ${SECRET.pan}`,
            account_number: SECRET.account,
            ifsc: SECRET.ifsc,
            beneficiary_name: SECRET.name,
          },
          { field_reference: `bad ${SECRET.account}`, reason_code: SECRET.name },
        ],
      });
      const res = await getDetail(admin, c.id);
      expect(res.status).toBe(200);
      expectNoSecrets("the staff detail", res.body);
      expect(res.body.data.payoutAccount).toMatchObject({
        razorpayAccountId: null,
        razorpayStakeholderId: null,
        razorpayProductId: "acc_prd_fine1",
        destinationHint: null,
        lastErrorCode: null,
        requirements: [{ field: "settlements.ifsc_code", reason: "field_missing" }],
      });
      expect(Object.keys(res.body.data.payoutAccount).sort()).toEqual(ADMIN_PAYOUT_KEYS);
    });

    it("the list view is unchanged: no payout field on a row", async () => {
      const { c } = await seedCreator();
      await seedAccount(c.id);
      const res = await request(app).get("/v1/admin/creators").set("Authorization", admin);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data.creators[0]).sort()).toEqual(
        ["connectionStatus", "country", "createdAt", "email", "followers", "id", "name", "pages", "publishablePages", "status", "submittedAt"],
      );
      expect(JSON.stringify(res.body)).not.toMatch(/payoutAccount|razorpay|bankChange/i);
    });

    it("a failed payout read says so, and does not read as 'no payout account' or take the review page down", async () => {
      const { c } = await seedCreator();
      await seedAccount(c.id);
      spyConsole();
      // A REAL failure: the table is not there (the DDL is applied by hand before a deploy). Put back in `finally`.
      await prisma.$executeRawUnsafe(`ALTER TABLE creator_payout_accounts RENAME TO creator_payout_accounts_gone`);
      try {
        const res = await getDetail(admin, c.id);
        expect(res.status).toBe(200);
        expect(res.body.data.creator.id).toBe(c.id);
        expect(res.body.data).toMatchObject({ payoutAccount: null, payoutAccountError: true });
        expectNoSecrets("the response", res.body);
        expect(JSON.stringify(res.body)).not.toMatch(/relation|creator_payout_accounts/i);
        expect(logged.join("\n")).toContain("could not read the payout account");
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE creator_payout_accounts_gone RENAME TO creator_payout_accounts`);
      }

      // and the next read is fine again
      const again = await getDetail(admin, c.id);
      expect(again.body.data).toMatchObject({ payoutAccountError: false });
      expect(again.body.data.payoutAccount).not.toBeNull();
    });

    it("review actions return the same detail shape (the screen replaces its data with it)", async () => {
      const { c } = await seedCreator({ status: "in_review" });
      await seedAccount(c.id);
      const res = await request(app).post(`/v1/admin/creators/${c.id}/approve`).set("Authorization", admin).send({});
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data.payoutAccount).sort()).toEqual(ADMIN_PAYOUT_KEYS);
      expect(res.body.data).toMatchObject({ payoutAccountError: false, payoutRouteEnabled: true, emailSent: true });
    });

    it("reading never calls Razorpay and never writes", async () => {
      const { c } = await seedCreator();
      const acc = await seedAccount(c.id);
      const before = (await rowOf(c.id))!;
      for (let i = 0; i < 3; i++) expect((await getDetail(admin, c.id)).status).toBe(200);
      expect(fake.calls).toHaveLength(0);
      expect((await rowOf(c.id))!.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(await eventsOf(acc.id)).toHaveLength(0);
    });
  });

  // ── Mark the bank change processed ─────────────────────────────────────────────────────────

  describe("mark bank change processed", () => {
    it("404s an unknown creator; 409s a creator with no account and an account with no open request", async () => {
      const missing = await clear(admin, "00000000-0000-0000-0000-000000000000");
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe("NOT_FOUND");

      const { c: bare } = await seedCreator();
      const noAccount = await clear(admin, bare.id);
      expect(noAccount.status).toBe(409);
      expect(noAccount.body.error.code).toBe("NO_BANK_CHANGE_REQUEST");

      const { c } = await seedCreator();
      const acc = await seedAccount(c.id);
      const none = await clear(admin, c.id);
      expect(none.status).toBe(409);
      expect(none.body.error.code).toBe("NO_BANK_CHANGE_REQUEST");
      expect((await rowOf(c.id))!.bankChangeClearedAt).toBeNull();
      expect(await eventsOf(acc.id)).toHaveLength(0);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("clears an open request: timestamp, one scrubbed audit row, an email to the creator, and the 72-hour hold in the answer", async () => {
      const { c } = await seedCreator({ name: "Asha <b>Iyer</b>" });
      const requestedAt = new Date(Date.now() - H);
      const acc = await seedAccount(c.id, { bankChangeRequestedAt: requestedAt });
      const t0 = Date.now();

      const res = await clear(admin, c.id);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body.data.emailSent).toBe(true);
      expect(res.body.data.creator.id).toBe(c.id);

      const row = (await rowOf(c.id))!;
      expect(row.bankChangeRequestedAt!.getTime()).toBe(requestedAt.getTime());
      expect(row.bankChangeClearedAt!.getTime()).toBeGreaterThanOrEqual(t0 - 1);
      expect(row.bankChangeClearedAt!.getTime()).toBeGreaterThan(requestedAt.getTime());

      const view = res.body.data.payoutAccount;
      expect(Object.keys(view).sort()).toEqual(ADMIN_PAYOUT_KEYS);
      expect(view).toMatchObject({
        bankChangePending: false,
        bankChange: { requestedAt: requestedAt.toISOString(), clearedAt: row.bankChangeClearedAt!.toISOString() },
        releaseHold: { active: true, resumesAt: new Date(row.bankChangeClearedAt!.getTime() + BANK_CHANGE_HOLD_MS).toISOString() },
      });

      const events = await eventsOf(acc.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        payoutId: acc.id,
        bookingId: null,
        kind: "bank_change_cleared",
        actorType: "staff",
        actorId: staff.id,
        amountPaise: null,
        razorpayEventId: null,
      });
      expect(events[0].note).toContain("bank change");
      expect(events[0].note).not.toMatch(/\d{5}/);

      expect(sendMock).toHaveBeenCalledTimes(1);
      const mail = sendMock.mock.calls[0][0] as { to: string; subject: string; html: string };
      const creatorRow = await prisma.creator.findUnique({ where: { id: c.id } });
      expect(mail.to).toBe(creatorRow!.email);
      expect(mail.subject).toBe("Your bank account change was processed");
      expect(mail.html).toContain("72 hours");
      expect(mail.html).toContain("We never ask for bank details by email");
      expect(mail.html).not.toContain("<b>Iyer</b>"); // the name is escaped
      expect(mail.html).toContain("/payouts");
      expect(fake.calls).toHaveLength(0);
    });

    it("a second click, and a second staff member, get 409 and change nothing", async () => {
      const { c } = await seedCreator();
      const acc = await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      expect((await clear(admin, c.id)).status).toBe(200);
      const first = (await rowOf(c.id))!.bankChangeClearedAt!;

      const other = await createTestUser({ name: "Other Staff" });
      const again = await clear(`Bearer ${generateToken(other.id, other.email, ["Super Admin"])}`, c.id);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("NO_BANK_CHANGE_REQUEST");
      expect((await clear(admin, c.id)).status).toBe(409);

      expect((await rowOf(c.id))!.bankChangeClearedAt!.getTime()).toBe(first.getTime());
      expect(await eventsOf(acc.id)).toHaveLength(1);
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it("two clicks at the same moment have exactly one winner: one 200, one 409, one audit row, one email", async () => {
      const { c } = await seedCreator();
      const acc = await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      const other = await createTestUser({ name: "Other Staff" });
      const second = `Bearer ${generateToken(other.id, other.email, ["Admin"])}`;
      const rs = await Promise.all([clear(admin, c.id), clear(second, c.id), clear(admin, c.id)]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(await eventsOf(acc.id)).toHaveLength(1);
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it("a request the creator makes after a clearing is open again, and clearable again", async () => {
      const { c } = await seedCreator();
      const acc = await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - 30 * H) });
      expect((await clear(admin, c.id)).status).toBe(200);
      expect((await clear(admin, c.id)).status).toBe(409);

      // the creator asks again (what requestBankChange writes: a request later than the clearing)
      await new Promise((r) => setTimeout(r, 15));
      await prisma.creatorPayoutAccount.update({ where: { creatorId: c.id }, data: { bankChangeRequestedAt: new Date() } });
      const detail = await getDetail(admin, c.id);
      expect(detail.body.data.payoutAccount).toMatchObject({ bankChangePending: true, releaseHold: { active: true, resumesAt: null } });

      await new Promise((r) => setTimeout(r, 15));
      expect((await clear(admin, c.id)).status).toBe(200);
      expect(await eventsOf(acc.id)).toHaveLength(2);
      expect(sendMock).toHaveBeenCalledTimes(2);
      const row = (await rowOf(c.id))!;
      expect(row.bankChangeClearedAt!.getTime()).toBeGreaterThanOrEqual(row.bankChangeRequestedAt!.getTime());
    });

    it("an email that cannot be sent does not undo the clearing, and the answer says so", async () => {
      const { c } = await seedCreator();
      await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      spyConsole();
      sendMock.mockResolvedValueOnce(null as never); // no SMTP / Gmail refused
      const res = await clear(admin, c.id);
      expect(res.status).toBe(200);
      expect(res.body.data.emailSent).toBe(false);
      expect((await rowOf(c.id))!.bankChangeClearedAt).not.toBeNull();

      const { c: c2 } = await seedCreator();
      await seedAccount(c2.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      sendMock.mockRejectedValueOnce(new Error(`SMTP down for ${SECRET.account}`));
      const res2 = await clear(admin, c2.id);
      expect(res2.status).toBe(200);
      expect(res2.body.data.emailSent).toBe(false);
      expect((await rowOf(c2.id))!.bankChangeClearedAt).not.toBeNull();
      expectNoSecrets("the log", logged.join("\n"));
    });

    it("works while payouts are dark: a request made before the switch went off is still clearable", async () => {
      const { c } = await seedCreator();
      await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      vi.stubEnv("CREATOR_ROUTE_ENABLED", "");
      vi.stubEnv("RAZORPAY_KEY_ID", "");
      vi.stubEnv("RAZORPAY_KEY_SECRET", "");
      const res = await clear(admin, c.id);
      expect(res.status).toBe(200);
      expect(res.body.data.payoutRouteEnabled).toBe(false);
      expect((await rowOf(c.id))!.bankChangeClearedAt).not.toBeNull();
    });
  });

  // ── Privacy ────────────────────────────────────────────────────────────────────────────────

  describe("what is kept (privacy)", () => {
    it("after a real setup, a bank change request and staff clearing it, no table, response, log or email holds a submitted value and no audit row was written", async () => {
      const { c, auth } = await seedCreator();
      spyConsole();
      const body = {
        fullName: SECRET.name,
        pan: SECRET.pan,
        phone: "+91 91234 56780",
        address: { street1: SECRET.street, street2: SECRET.street2, city: "Bengaluru", state: "Karnataka", postalCode: "560001" },
        accountNumber: SECRET.account,
        ifsc: SECRET.ifsc,
        acceptTerms: true,
        termsVersion: creatorConfig.termsVersion(),
      };
      expect((await request(app).put("/v1/creator/payout-account").set("Authorization", auth).send(body)).status).toBe(200);
      expect((await request(app).post("/v1/creator/payout-account/bank-change").set("Authorization", auth)).status).toBe(200);
      await flushPayoutAlertsForTests();
      sendMock.mockClear();
      const auditBefore = await prisma.auditLog.count();

      const seen = await getDetail(admin, c.id);
      expect(seen.status).toBe(200);
      const view = seen.body.data.payoutAccount;
      expect(Object.keys(view).sort()).toEqual(ADMIN_PAYOUT_KEYS);
      expect(view).toMatchObject({ status: "under_review", destinationHint: "HDFC ••••1012", bankChangePending: true });
      expect(view.razorpayAccountId).toMatch(/^acc_/);
      expectNoSecrets("the staff read before clearing", seen.body);

      const done = await clear(admin, c.id);
      expect(done.status).toBe(200);
      expectNoSecrets("the clearing response", done.body);
      await flushPayoutAlertsForTests();

      expect(await scanDatabase([...NEEDLES, "ECHOEDPAN1", "Echoed Legal Name"])).toEqual([]);
      expectNoSecrets("console output", logged.join("\n"));
      expectNoSecrets("emails to creators", sendMock.mock.calls);
      expectNoSecrets("emails to staff", notifyMock.mock.calls);
      expect(await prisma.auditLog.count()).toBe(auditBefore);
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
  });
});
