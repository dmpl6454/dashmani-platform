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
 *   - "close without a change" (the honest way out of a request that will not be carried out): pending ends, NO
 *     pause applies, the audit kind is bank_change_declined, the creator is never told their account was
 *     updated (and a closed creator is told nothing), and it races "processed" with exactly one winner;
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
import { BANK_CHANGE_HOLD_MS, bankChangeBlocksRelease, bankChangePending } from "../src/services/creator/payout-account-view";
import { captureConsole, scanDatabase as scanTables, type ConsoleCapture } from "./payout-privacy";

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
  "attention",
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
const decline = (auth: string, id: string) => request(app).post(`/v1/admin/creators/${id}/payout-account/bank-change/declined`).set("Authorization", auth);
const eventsOf = (accountId: string) => prisma.creatorPayoutEvent.findMany({ where: { payoutId: accountId }, orderBy: { createdAt: "asc" } });
const rowOf = (creatorId: string) => prisma.creatorPayoutAccount.findUnique({ where: { creatorId } });

/** Which tables hold any needle (the shared scan, which has its own positive control in payout-privacy.test.ts). */
const scanDatabase = (needles: string[] = NEEDLES) => scanTables(needles);

// The shared capture renders an Error's message and stack too, so a leak through console.error(e) is seen.
let cap: ConsoleCapture | null = null;
function spyConsole() {
  cap?.restore();
  cap = captureConsole();
}
const logText = () => (cap ? cap.lines.join("\n") : "");

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
    // Bank connect stays closed on the pre-payout terms ("terms_pending"): these tests need it open.
    vi.stubEnv("CREATOR_TERMS_VERSION", "2026-11-01");
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
    cap?.restore();
    cap = null;
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
        const close = token
          ? await decline(token, c.id)
          : await request(app).post(`/v1/admin/creators/${c.id}/payout-account/bank-change/declined`);
        expect(allowed, `close without a change with ${label}: ${close.status}`).toContain(close.status);
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
      expect(Object.keys(view.bankChange).sort()).toEqual(["clearedAt", "outcome", "requestedAt"]);
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
        bankChange: { requestedAt: requestedAt.toISOString(), clearedAt: null, outcome: null },
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

    it("the list row carries ONE payout fact, whether a bank change is waiting, and nothing else about payouts", async () => {
      const { c } = await seedCreator();
      await seedAccount(c.id);
      const res = await request(app).get("/v1/admin/creators").set("Authorization", admin);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data.creators[0]).sort()).toEqual(
        ["bankChangePending", "connectionStatus", "country", "createdAt", "email", "followers", "id", "name", "pages", "publishablePages", "status", "submittedAt"],
      );
      expect(Object.keys(res.body.data).sort()).toEqual(["bankChangesWaiting", "counts", "creators"]);
      expect(res.body.data.creators[0].bankChangePending).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(/payoutAccount|razorpay|destinationHint|lastError|requirements/i);
    });

    it("the failing-account view says whether the creator can fix it: attention is on the staff view too", async () => {
      const { c: fix } = await seedCreator();
      await seedAccount(fix.id, { setupStep: "product", lastError: "BANK_DETAILS_REJECTED|settlements.ifsc_code" });
      const { c: conflict } = await seedCreator();
      await seedAccount(conflict.id, { setupStep: "none", razorpayAccountId: null, razorpayStakeholderId: null, razorpayProductId: null, lastError: "ACCOUNT_CONFLICT" });
      const { c: fine } = await seedCreator();
      await seedAccount(fine.id);
      const attentionOf = async (id: string) => (await getDetail(admin, id)).body.data.payoutAccount;
      expect(await attentionOf(fix.id)).toMatchObject({ status: "failed", attention: "fix_details", lastErrorCode: "BANK_DETAILS_REJECTED" });
      expect(await attentionOf(conflict.id)).toMatchObject({ status: "failed", attention: "contact_us", lastErrorCode: "ACCOUNT_CONFLICT" });
      expect(await attentionOf(fine.id)).toMatchObject({ status: "under_review", attention: null });
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
        expect(logText()).toContain("could not read the payout account");
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

  // ── List: bank changes waiting ─────────────────────────────────────────────────────────────

  describe("list: bank changes waiting", () => {
    const list = (qs = "") => request(app).get(`/v1/admin/creators${qs}`).set("Authorization", admin);
    type Row = { name: string; bankChangePending: boolean };

    it("flags each creator with an unprocessed request, floats them to the top with the review queue, and counts them", async () => {
      // oldest first, so the default newest-first order would put them last
      const { c: pending } = await seedCreator({ name: "Pending Bank", status: "approved" });
      await seedAccount(pending.id, { bankChangeRequestedAt: new Date(Date.now() - 2 * H) });
      const { c: cleared } = await seedCreator({ name: "Cleared Bank", status: "approved" });
      await seedAccount(cleared.id, { bankChangeRequestedAt: new Date(Date.now() - 20 * H), bankChangeClearedAt: new Date(Date.now() - 10 * H) });
      const { c: again } = await seedCreator({ name: "Asked Again", status: "approved" });
      await seedAccount(again.id, { bankChangeRequestedAt: new Date(Date.now() - H), bankChangeClearedAt: new Date(Date.now() - 5 * H) });
      const { c: plain } = await seedCreator({ name: "No Request", status: "approved" });
      await seedAccount(plain.id);
      await seedCreator({ name: "No Account", status: "approved" });
      await seedCreator({ name: "Queue Member", status: "in_review" });

      const res = await list();
      expect(res.status).toBe(200);
      const rows: Row[] = res.body.data.creators;
      expect(Object.fromEntries(rows.map((r) => [r.name, r.bankChangePending]))).toEqual({
        "Pending Bank": true,
        "Cleared Bank": false, // staff processed it
        "Asked Again": true, // a request AFTER the clearing is open again (the same rule as the staff card)
        "No Request": false,
        "No Account": false,
        "Queue Member": false,
      });
      expect(res.body.data.bankChangesWaiting).toBe(2);
      // the work queue (in review + bank change waiting) comes first, the rest follow
      const firstFour = rows.slice(0, 3).map((r) => r.name).sort();
      expect(firstFour).toEqual(["Asked Again", "Pending Bank", "Queue Member"]);
      expect(rows.slice(3).every((r) => !r.bankChangePending)).toBe(true);
      expect(JSON.stringify(res.body)).not.toMatch(/razorpay|destinationHint|lastError/i);

      // marking one processed takes it out of both the flag and the count
      expect((await clear(admin, pending.id)).status).toBe(200);
      const after = await list();
      expect(after.body.data.bankChangesWaiting).toBe(1);
      expect((after.body.data.creators as Row[]).find((r) => r.name === "Pending Bank")!.bankChangePending).toBe(false);
    });

    it("counts waiting requests across every tab, so the default 'In review' view still says one is waiting", async () => {
      const { c } = await seedCreator({ name: "Approved Waiting", status: "approved" });
      await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      await seedCreator({ name: "In Review", status: "in_review" });

      const tab = await list("?status=in_review");
      expect((tab.body.data.creators as Row[]).map((r) => r.name)).toEqual(["In Review"]);
      expect(tab.body.data.bankChangesWaiting).toBe(1);
      // a search narrows the rows, not the number of requests waiting
      const searched = await list("?q=zzz-no-such-creator");
      expect(searched.body.data.creators).toHaveLength(0);
      expect(searched.body.data.bankChangesWaiting).toBe(1);
    });

    it("works the same while payouts are dark: a request made before the switch went off is still listed", async () => {
      const { c } = await seedCreator({ status: "approved" });
      await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      vi.stubEnv("CREATOR_ROUTE_ENABLED", "");
      const res = await list();
      expect(res.body.data.bankChangesWaiting).toBe(1);
      expect(res.body.data.creators[0].bankChangePending).toBe(true);
    });

    it("a failed read says 'could not check' (null), never 'none', and does not take the queue down", async () => {
      const { c } = await seedCreator({ name: "Waiting But Unreadable", status: "approved" });
      await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      spyConsole();
      await prisma.$executeRawUnsafe(`ALTER TABLE creator_payout_accounts RENAME TO creator_payout_accounts_gone`);
      try {
        const res = await list();
        expect(res.status).toBe(200);
        expect(res.body.data.bankChangesWaiting).toBeNull();
        expect((res.body.data.creators as Row[]).map((r) => r.name)).toEqual(["Waiting But Unreadable"]);
        expect(JSON.stringify(res.body)).not.toMatch(/relation|creator_payout_accounts/i);
        expect(logText()).toContain("could not read pending bank changes");
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE creator_payout_accounts_gone RENAME TO creator_payout_accounts`);
      }
      const again = await list();
      expect(again.body.data.bankChangesWaiting).toBe(1);
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
        bankChange: { requestedAt: requestedAt.toISOString(), clearedAt: row.bankChangeClearedAt!.toISOString(), outcome: "processed" },
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
      // ⚠️ It says what is true now (the Razorpay record was updated) and nothing about when payments happen:
      // no payment exists in this phase, and the hold rule belongs to the release gate, not to an email.
      expect(mail.html).toContain("has been updated");
      expect(mail.html).not.toMatch(/72|hours|paused|pause|hold|as normal|payments? (to you|will|go)/i);
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
      expectNoSecrets("the log", logText());
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

  // ── Close a bank change request WITHOUT a change ────────────────────────────────────────────

  describe("close a bank change request without a change", () => {
    it("404s an unknown creator; 409s a creator with no account and an account with no open request", async () => {
      expect((await decline(admin, "00000000-0000-0000-0000-000000000000")).status).toBe(404);
      const { c: bare } = await seedCreator();
      const noAccount = await decline(admin, bare.id);
      expect([noAccount.status, noAccount.body.error.code]).toEqual([409, "NO_BANK_CHANGE_REQUEST"]);

      const { c } = await seedCreator();
      const acc = await seedAccount(c.id);
      const none = await decline(admin, c.id);
      expect([none.status, none.body.error.code]).toEqual([409, "NO_BANK_CHANGE_REQUEST"]);
      expect((await rowOf(c.id))!.bankChangeClearedAt).toBeNull();
      expect(await eventsOf(acc.id)).toHaveLength(0);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("ends the request with nothing changed: not pending, NO release pause even right after the request, an audit row of its own, and a note that says nothing was updated", async () => {
      const { c, auth: creatorAuth } = await seedCreator({ name: "Asha <b>Iyer</b>" });
      const requestedAt = new Date(Date.now() - H); // asked an hour ago: a PROCESSED clearing would pause releases for 72 hours from now
      const acc = await seedAccount(c.id, { bankChangeRequestedAt: requestedAt });

      const res = await decline(admin, c.id);
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.body.data).toMatchObject({ emailSent: true, emailSkipped: null });
      expect(res.body.data.creator.id).toBe(c.id);

      // cleared exactly AT the request: pending is false, and the equality is what reads "declined"
      const row = (await rowOf(c.id))!;
      expect(row.bankChangeRequestedAt!.getTime()).toBe(requestedAt.getTime());
      expect(row.bankChangeClearedAt!.getTime()).toBe(requestedAt.getTime());
      expect(bankChangePending(row)).toBe(false);
      expect(bankChangeBlocksRelease(row)).toBe(false); // ⚠️ the 72-hour pause is not applied to a change that never happened

      const view = res.body.data.payoutAccount;
      expect(Object.keys(view).sort()).toEqual(ADMIN_PAYOUT_KEYS);
      expect(view).toMatchObject({
        bankChangePending: false,
        bankChange: { requestedAt: requestedAt.toISOString(), clearedAt: requestedAt.toISOString(), outcome: "declined" },
        releaseHold: { active: false, resumesAt: null },
      });

      // one audit row, of the declined kind, and NO processed row
      const events = await eventsOf(acc.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ payoutId: acc.id, bookingId: null, kind: "bank_change_declined", actorType: "staff", actorId: staff.id, amountPaise: null, razorpayEventId: null });
      expect(events[0].note).toContain("without a change");
      expect(events[0].note).not.toMatch(/\d{5}/);
      expect(events.some((e) => e.kind === "bank_change_cleared")).toBe(false);

      // the creator hears that it was closed and that nothing changed: never "updated", and nothing about holds or payments
      expect(sendMock).toHaveBeenCalledTimes(1);
      const mail = sendMock.mock.calls[0][0] as { to: string; subject: string; html: string };
      expect(mail.to).toBe((await prisma.creator.findUnique({ where: { id: c.id } }))!.email);
      expect(mail.subject).toBe("Your bank account change request was closed");
      expect(mail.html).toContain("Nothing about your payout account with Razorpay was changed");
      expect(mail.html).not.toMatch(/has been updated|was processed|completed the bank/i);
      expect(mail.html).not.toMatch(/72|hours|paused|pause|hold|payments? (to you|will|go)/i);
      expect(mail.html).toContain("We never ask for bank details by email");
      expect(mail.html).not.toContain("<b>Iyer</b>"); // escaped
      expect(fake.calls).toHaveLength(0); // nothing reaches Razorpay

      // and the creator's own view says the same (their card words "closed without a change", never "updated")
      const mine = await request(app).get("/v1/creator/payout-account").set("Authorization", creatorAuth);
      expect(mine.body.data.account.bankChange).toEqual({ requestedAt: requestedAt.toISOString(), clearedAt: requestedAt.toISOString(), outcome: "declined" });
    });

    it("a second click, a click on 'processed' afterwards, and a second staff member all get 409 and change nothing", async () => {
      const { c } = await seedCreator();
      const acc = await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      expect((await decline(admin, c.id)).status).toBe(200);
      const first = (await rowOf(c.id))!.bankChangeClearedAt!;

      const other = await createTestUser({ name: "Other Staff" });
      const otherAuth = `Bearer ${generateToken(other.id, other.email, ["Super Admin"])}`;
      for (const r of [await decline(admin, c.id), await decline(otherAuth, c.id), await clear(admin, c.id)]) {
        expect([r.status, r.body.error.code]).toEqual([409, "NO_BANK_CHANGE_REQUEST"]);
      }
      expect((await rowOf(c.id))!.bankChangeClearedAt!.getTime()).toBe(first.getTime());
      expect(await eventsOf(acc.id)).toHaveLength(1);
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it("'processed' and 'close without a change' at the same moment have exactly one winner: one 200, one audit row, one email", async () => {
      const { c } = await seedCreator();
      const acc = await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      const other = await createTestUser({ name: "Other Staff" });
      const second = `Bearer ${generateToken(other.id, other.email, ["Admin"])}`;
      const rs = await Promise.all([clear(admin, c.id), decline(second, c.id), decline(admin, c.id), clear(second, c.id)]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
      expect(await eventsOf(acc.id)).toHaveLength(1);
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it("the creator can ask again after it was closed: pending again, releases paused again, and it can be closed or processed again", async () => {
      const { c, auth: creatorAuth } = await seedCreator();
      const acc = await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - 2 * H) });
      expect((await decline(admin, c.id)).status).toBe(200);

      await new Promise((r) => setTimeout(r, 15));
      const asked = await request(app).post("/v1/creator/payout-account/bank-change").set("Authorization", creatorAuth);
      expect(asked.status).toBe(200);
      expect(asked.body.data.account.bankChange.outcome).toBeNull(); // waiting again
      let row = (await rowOf(c.id))!;
      expect(bankChangePending(row)).toBe(true);
      expect(bankChangeBlocksRelease(row)).toBe(true);
      expect((await getDetail(admin, c.id)).body.data.payoutAccount).toMatchObject({ bankChangePending: true, releaseHold: { active: true, resumesAt: null } });

      // this time the change is carried out: the normal pause applies, and the answer reads "processed"
      await new Promise((r) => setTimeout(r, 15));
      const done = await clear(admin, c.id);
      expect(done.status).toBe(200);
      row = (await rowOf(c.id))!;
      expect(row.bankChangeClearedAt!.getTime()).toBeGreaterThan(row.bankChangeRequestedAt!.getTime());
      expect(done.body.data.payoutAccount).toMatchObject({ bankChange: { outcome: "processed" }, releaseHold: { active: true } });
      expect((await eventsOf(acc.id)).map((e) => e.kind)).toEqual(["bank_change_declined", "bank_change_cleared"]);
    });

    it("'processed' is always stamped strictly after the request (equal means declined), even when the click lands in the request's own millisecond", async () => {
      const { c } = await seedCreator();
      const future = new Date(Date.now() + 60_000); // a request stamped ahead of this clock: the clamp must still leave it strictly later
      await seedAccount(c.id, { bankChangeRequestedAt: future });
      const res = await clear(admin, c.id);
      expect(res.status).toBe(200);
      const row = (await rowOf(c.id))!;
      expect(row.bankChangeClearedAt!.getTime()).toBe(future.getTime() + 1);
      expect(res.body.data.payoutAccount.bankChange.outcome).toBe("processed");
      expect(bankChangeBlocksRelease(row, new Date(future.getTime() + H))).toBe(true);
    });

    it("a CLOSED creator: the request still closes, but no email is sent (they cannot sign in), whichever way it is closed, and the answer says why", async () => {
      const { c: a } = await seedCreator({ status: "closed" });
      const accA = await seedAccount(a.id, { bankChangeRequestedAt: new Date(Date.now() - 40 * H) });
      const declined = await decline(admin, a.id);
      expect(declined.status).toBe(200);
      expect(declined.body.data).toMatchObject({ emailSent: false, emailSkipped: "creator_closed" });
      expect(declined.body.data.payoutAccount).toMatchObject({ bankChangePending: false, bankChange: { outcome: "declined" }, releaseHold: { active: false } });
      expect((await eventsOf(accA.id)).map((e) => e.kind)).toEqual(["bank_change_declined"]);

      // "processed" on a closed creator is allowed too (a change really was done), but never mails the false "updated" notice to a dead account
      const { c: b } = await seedCreator({ status: "closed" });
      await seedAccount(b.id, { bankChangeRequestedAt: new Date(Date.now() - 40 * H) });
      const processed = await clear(admin, b.id);
      expect(processed.status).toBe(200);
      expect(processed.body.data).toMatchObject({ emailSent: false, emailSkipped: "creator_closed" });
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("an email that cannot be sent does not undo the closing, and the answer says so", async () => {
      const { c } = await seedCreator();
      await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      spyConsole();
      sendMock.mockResolvedValueOnce(null as never);
      const res = await decline(admin, c.id);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ emailSent: false, emailSkipped: null }); // a failure to send, not a deliberate skip
      expect((await rowOf(c.id))!.bankChangeClearedAt).not.toBeNull();

      const { c: c2 } = await seedCreator();
      await seedAccount(c2.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      sendMock.mockRejectedValueOnce(new Error(`SMTP down for ${SECRET.account}`));
      const res2 = await decline(admin, c2.id);
      expect(res2.status).toBe(200);
      expect(res2.body.data.emailSent).toBe(false);
      expectNoSecrets("the log", logText());
    });

    it("takes the creator out of the waiting list and its count, like processing does", async () => {
      const { c } = await seedCreator({ name: "Mistaken Request", status: "approved" });
      await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      const before = await request(app).get("/v1/admin/creators").set("Authorization", admin);
      expect(before.body.data.bankChangesWaiting).toBe(1);
      expect((await decline(admin, c.id)).status).toBe(200);
      const after = await request(app).get("/v1/admin/creators").set("Authorization", admin);
      expect(after.body.data.bankChangesWaiting).toBe(0);
      expect((after.body.data.creators as Array<{ name: string; bankChangePending: boolean }>).find((r) => r.name === "Mistaken Request")!.bankChangePending).toBe(false);
    });

    it("works while payouts are dark, writes no audit_logs row, and nothing it answers or mails holds a submitted value", async () => {
      const { c } = await seedCreator();
      await seedAccount(c.id, { bankChangeRequestedAt: new Date(Date.now() - H) });
      vi.stubEnv("CREATOR_ROUTE_ENABLED", "");
      vi.stubEnv("RAZORPAY_KEY_ID", "");
      vi.stubEnv("RAZORPAY_KEY_SECRET", "");
      spyConsole();
      const auditBefore = await prisma.auditLog.count();
      const res = await decline(admin, c.id);
      expect(res.status).toBe(200);
      expect(res.body.data.payoutRouteEnabled).toBe(false);
      expectNoSecrets("the response", res.body);
      expectNoSecrets("the email", sendMock.mock.calls);
      expectNoSecrets("the log", logText());
      expect(await prisma.auditLog.count()).toBe(auditBefore);
      expect(await scanDatabase()).toEqual([]);
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
      expectNoSecrets("console output", logText());
      expectNoSecrets("emails to creators", sendMock.mock.calls);
      expectNoSecrets("emails to staff", notifyMock.mock.calls);
      expect(await prisma.auditLog.count()).toBe(auditBefore);
      expect(sendMock).toHaveBeenCalledTimes(1);
    });
  });
});
