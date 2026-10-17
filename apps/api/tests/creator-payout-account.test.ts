/**
 * creator-payout-account.test.ts — Phase 2 of the creator payouts: bank connect
 * (docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md, "Phase 2: Bank connect").
 *
 * Razorpay is a FAKE with real state (tests/fake-razorpay-route.ts): one account per email, one
 * stakeholder and one product per account, and it echoes the PAN, account number, IFSC, name and address
 * back the way Razorpay does. What these pin:
 *   - the feature is dark unless CREATOR_ROUTE_ENABLED=1 and the keys exist, and gated to approved,
 *     email-verified creators;
 *   - setup is RESUMABLE at every step and never creates a second linked account (not on a retry after a
 *     failure, not when two requests overlap, not after a lost answer);
 *   - a returning creator's account is adopted ONLY on an equal verified email and when no other creator
 *     holds it;
 *   - the daily creation cap holds and counts new creations only;
 *   - a refusal of the product step is a staff step, never "your details" (the call carries none of them);
 *   - ⚠️ nothing ever sends bank details to an account Razorpay already holds past setup (a lost answer cannot
 *     lead to an overwrite), and a bank rejection never invites a correction the retry would ignore;
 *   - bank connect stays closed on the pre-payout terms (terms_pending) and behind CREATORS_ENABLED;
 *   - ⚠️ PRIVACY: after a full setup (and after rejections) NO column of ANY table holds the PAN, account
 *     number, IFSC, name, street or phone that was submitted, nothing is logged or emailed, and no
 *     response or validation error quotes them.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { prisma, Prisma, PrismaClient } from "@dashmani/db";
import { hash } from "bcrypt";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import app from "../src/app";
import { sendEmail, notifyAdminByEmail } from "../src/services/email.service";
import { createTestUser, generateCreatorToken, generateToken } from "./helpers";
import { FakeRazorpay, is } from "./fake-razorpay-route";
import { captureConsole, scanDatabase as scanTables } from "./payout-privacy";
import { PRE_PAYOUT_TERMS_VERSION, creatorConfig } from "../src/services/creator/creator-config";
import { flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import {
  applyProductStatus,
  istDayStartUtc,
  mapProductFacts,
  PAYOUT_CAP_LOCK_KEY,
  payoutUnavailableReason,
  requestBankChange,
  routeAvailable,
} from "../src/services/creator/payout-account.service";
import {
  BANK_CHANGE_HOLD_MS,
  bankChangeBlocksRelease,
  bankChangePending,
  canSetUp,
  decodeSetupError,
  encodeSetupError,
  payoutAccountStatus,
  razorpayHoldsAccount,
  toPayoutAccountView,
} from "../src/services/creator/payout-account-view";
import {
  PAYOUT_STATES,
  PAYOUT_STATE_CHOICES,
  creatorPayoutAccountSchema,
  formFieldForReference,
  normalisePayoutPhone,
  referencesForRejection,
  splitBankRejection,
} from "@dashmani/shared/src/validators/creator-payout";

const sendEmailMock = vi.mocked(sendEmail);
const notifyMock = vi.mocked(notifyAdminByEmail);

// Distinctive values: each one is searched for in every table, every log line and every email.
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
/** Which tables hold any submitted value (the shared scan; its positive control is tests/payout-privacy.test.ts). */
const scanDatabase = (needles: string[] = NEEDLES) => scanTables(needles);

const fake = new FakeRazorpay();
let n = 0;

function bodyOf(over: Record<string, any> = {}) {
  return {
    fullName: SECRET.name,
    pan: SECRET.pan,
    phone: "+91 91234 56780",
    address: { street1: SECRET.street, street2: SECRET.street2, city: "Bengaluru", state: "Karnataka", postalCode: "560001" },
    accountNumber: SECRET.account,
    ifsc: SECRET.ifsc,
    acceptTerms: true,
    termsVersion: creatorConfig.termsVersion(),
    ...over,
  };
}

async function seedCreator(over: Partial<{ status: string; verified: boolean; email: string }> = {}) {
  const email = over.email ?? `payout-${Date.now()}-${++n}@creators.test`;
  const c = await prisma.creator.create({
    data: {
      email,
      passwordHash: await hash("Creator@123", 4),
      name: "Asha Iyer",
      country: "IN",
      phone: "+91 98100 00000",
      status: over.status ?? "approved",
      emailVerifiedAt: over.verified === false ? null : new Date(),
      termsAcceptedAt: new Date(),
    },
  });
  return { c, auth: `Bearer ${generateCreatorToken(c.id, c.email)}` };
}

const put = (auth: string, body: unknown) => request(app).put("/v1/creator/payout-account").set("Authorization", auth).send(body as any);
const get = (auth: string) => request(app).get("/v1/creator/payout-account").set("Authorization", auth);
const postChange = (auth: string) => request(app).post("/v1/creator/payout-account/bank-change").set("Authorization", auth);
const rowOf = (creatorId: string) => prisma.creatorPayoutAccount.findUnique({ where: { creatorId } });

let logged: string[] = [];
const consoleSpies: Array<{ mockRestore: () => void }> = [];
function spyConsole() {
  // Renders an Error's message and stack too (tests/payout-privacy.ts), so "nothing was logged" cannot pass blind.
  const c = captureConsole();
  logged = c.lines;
  consoleSpies.push({ mockRestore: c.restore });
}

function expectNoSecrets(where: string, haystack: unknown) {
  const s = typeof haystack === "string" ? haystack : JSON.stringify(haystack);
  for (const needle of NEEDLES) expect(s, `${where} must not contain ${needle}`).not.toContain(needle);
}

function expectNoSecretsAnywhere() {
  expectNoSecrets("console output", logged.join("\n"));
  expectNoSecrets("emails to creators", sendEmailMock.mock.calls);
  expectNoSecrets("emails to staff", notifyMock.mock.calls);
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for the condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Bank connect opens only on payout terms: the shipped default is the pre-payout version, so every test that
// needs the feature ON names a later one (the terms_pending tests below put the default back).
const PAYOUT_TERMS = "2026-11-01";

beforeEach(() => {
  vi.stubEnv("CREATORS_ENABLED", "1");
  vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
  vi.stubEnv("CREATOR_TERMS_VERSION", PAYOUT_TERMS);
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
  vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
  vi.stubEnv("RATE_LIMIT_CREATOR_PAYOUT_MAX", "1000");
  fake.reset();
  fake.install();
  sendEmailMock.mockClear();
  notifyMock.mockClear();
  resetPayoutAlertsForTests();
});
afterEach(async () => {
  await flushPayoutAlertsForTests();
  fake.restore();
  while (consoleSpies.length) consoleSpies.pop()!.mockRestore();
  vi.unstubAllEnvs();
});
afterAll(() => {
  fake.restore();
});

// ── Pure: the view, who may set up, the bank-change pause ───────────────────────────────────────

describe("payout account view (pure)", () => {
  const T = new Date("2026-10-17T10:00:00Z");
  const base = {
    razorpayAccountId: null as string | null,
    setupStep: "none",
    activationStatus: "not_started",
    requirements: null as any,
    destinationHint: null as string | null,
    termsVersion: null as string | null,
    activatedAt: null as Date | null,
    bookableAfter: null as Date | null,
    bankChangeRequestedAt: null as Date | null,
    bankChangeClearedAt: null as Date | null,
    accountCreatedAt: null as Date | null,
    setupLockedUntil: null as Date | null,
    lastError: null as string | null,
    updatedAt: T,
  };
  const reqs = [
    { field_reference: "settlements.ifsc_code", reason_code: "field_missing", status: "required" },
    { field_reference: "settlements.beneficiary_name", reason_code: "kyc_failed", status: "resolved" },
  ];

  it("maps stored status and step to the status and setupStep the creator reads", () => {
    const table: Array<[string, any, string, string]> = [
      ["nothing stored", { ...base }, "not_started", "account"],
      ["reservation made, outcome unknown", { ...base, accountCreatedAt: T, lastError: "ACCOUNT_UNKNOWN" }, "setting_up", "account"],
      ["account done", { ...base, setupStep: "account", razorpayAccountId: "acc_1" }, "setting_up", "stakeholder"],
      ["stakeholder done", { ...base, setupStep: "stakeholder", razorpayAccountId: "acc_1" }, "setting_up", "product"],
      ["product done, settlements missing (Razorpay says needs_clarification mid-setup)", { ...base, setupStep: "product", razorpayAccountId: "acc_1", activationStatus: "needs_clarification", requirements: reqs }, "setting_up", "bank"],
      ["a request holds the lease", { ...base, setupLockedUntil: new Date(T.getTime() + 60_000) }, "setting_up", "account"],
      ["rejected PAN", { ...base, setupStep: "account", razorpayAccountId: "acc_1", lastError: "PAN_REJECTED|kyc.pan" }, "failed", "stakeholder"],
      ["account conflict", { ...base, lastError: "ACCOUNT_CONFLICT" }, "failed", "account"],
      ["done, requested", { ...base, setupStep: "done", razorpayAccountId: "acc_1", activationStatus: "requested" }, "under_review", "done"],
      ["done, under_review", { ...base, setupStep: "done", razorpayAccountId: "acc_1", activationStatus: "under_review" }, "under_review", "done"],
      ["done, needs_clarification", { ...base, setupStep: "done", razorpayAccountId: "acc_1", activationStatus: "needs_clarification", requirements: reqs }, "needs_clarification", "done"],
      ["done, activated", { ...base, setupStep: "done", razorpayAccountId: "acc_1", activationStatus: "activated" }, "activated", "done"],
      ["done, suspended", { ...base, setupStep: "done", razorpayAccountId: "acc_1", activationStatus: "suspended" }, "suspended", "done"],
      ["stored 'bank' reads as done", { ...base, setupStep: "bank", razorpayAccountId: "acc_1", activationStatus: "under_review" }, "under_review", "done"],
    ];
    for (const [label, row, status, step] of table) {
      expect(payoutAccountStatus(row, T), label).toBe(status);
      const v = toPayoutAccountView(row, T)!;
      expect(v.status, label).toBe(status);
      expect(v.setupStep, label).toBe(step);
    }
    expect(toPayoutAccountView(null)).toBeNull();
    expect(payoutAccountStatus(null)).toBe("not_started");
    // an expired lease is no lease
    expect(payoutAccountStatus({ ...base, setupStep: "account", razorpayAccountId: "acc_1", setupLockedUntil: new Date(T.getTime() - 1) }, T)).toBe("setting_up");
  });

  it("shows requirements only once setup is done (resolved ones dropped), or the rejected references when failed", () => {
    const done = toPayoutAccountView({ ...base, setupStep: "done", razorpayAccountId: "acc_1", activationStatus: "needs_clarification", requirements: reqs }, T)!;
    expect(done.requirements).toEqual([{ field: "settlements.ifsc_code", reason: "field_missing" }]);
    const mid = toPayoutAccountView({ ...base, setupStep: "product", razorpayAccountId: "acc_1", activationStatus: "needs_clarification", requirements: reqs }, T)!;
    expect(mid.requirements).toEqual([]);
    const failed = toPayoutAccountView({ ...base, lastError: encodeSetupError("BANK_DETAILS_REJECTED", ["settlements.ifsc_code", "settlements.account_number"]) }, T)!;
    expect(failed.status).toBe("failed");
    expect(failed.requirements).toEqual([
      { field: "settlements.ifsc_code", reason: "rejected" },
      { field: "settlements.account_number", reason: "rejected" },
    ]);
    const active = toPayoutAccountView({ ...base, setupStep: "done", razorpayAccountId: "acc_1", activationStatus: "activated", requirements: reqs }, T)!;
    expect(active.requirements).toEqual([]);
  });

  it("says what a FAILED setup asks of the creator: correct the marked details, or write to us", () => {
    const failed = (lastError: string) => toPayoutAccountView({ ...base, lastError }, T)!;
    expect(failed(encodeSetupError("BANK_DETAILS_REJECTED", ["settlements.ifsc_code"]))).toMatchObject({ status: "failed", attention: "fix_details" });
    expect(failed(encodeSetupError("PAN_REJECTED", ["kyc.pan"])).attention).toBe("fix_details");
    expect(failed(encodeSetupError("DETAILS_REJECTED", ["phone", "address.city"])).attention).toBe("fix_details");
    // nothing the creator can retype: an account Razorpay holds under their email, a refusal naming no field, one naming a field the form lacks
    expect(failed("ACCOUNT_CONFLICT")).toMatchObject({ status: "failed", attention: "contact_us", requirements: [] });
    expect(failed(encodeSetupError("ACCOUNT_CONFLICT", ["kyc.pan"])).attention).toBe("contact_us"); // the conflict outranks any reference
    expect(failed("DETAILS_REJECTED")).toMatchObject({ status: "failed", attention: "contact_us", requirements: [] });
    expect(failed(encodeSetupError("DETAILS_REJECTED", ["email"])).attention).toBe("contact_us");
    // only a failed setup has one
    const quiet: any[] = [
      { ...base },
      { ...base, setupStep: "account", razorpayAccountId: "acc_1", lastError: "PRODUCT_UNKNOWN" },
      { ...base, setupStep: "done", razorpayAccountId: "acc_1", activationStatus: "needs_clarification", requirements: reqs },
      { ...base, setupStep: "done", razorpayAccountId: "acc_1", activationStatus: "activated" },
      { ...base, setupStep: "done", razorpayAccountId: "acc_1", activationStatus: "suspended" },
    ];
    for (const row of quiet) expect(toPayoutAccountView(row, T)!.attention).toBeNull();
  });

  it("knows when Razorpay holds an account past setup, whatever our own step says", () => {
    expect(razorpayHoldsAccount(null)).toBe(false);
    for (const [status, held] of [["not_started", false], ["requested", false], ["under_review", false], ["needs_clarification", false], ["activated", true], ["suspended", true]] as const) {
      expect(razorpayHoldsAccount({ activationStatus: status }), status).toBe(held);
    }
  });

  it("lets only whitelisted shapes out: a hint, a field reference, a reason code", () => {
    const hostile = [
      { field_reference: "settlements.ifsc_code", reason_code: "Account 60987654321012 is wrong", status: "required" },
      { field_reference: "not a field because spaces", reason_code: "field_missing", status: "required" },
      { field_reference: "ABCPE1234F", reason_code: "kyc_failed", status: "required" },
    ];
    const v = toPayoutAccountView({ ...base, setupStep: "done", razorpayAccountId: "acc_1", activationStatus: "needs_clarification", requirements: hostile, destinationHint: "60987654321012" }, T)!;
    expect(v.destinationHint).toBeNull();
    expect(v.requirements).toEqual([
      { field: "settlements.ifsc_code", reason: "unspecified" },
      { field: "[redacted]", reason: "kyc_failed" },
    ]);
    expect(JSON.stringify(v)).not.toContain("60987654321012");
    expect(JSON.stringify(v)).not.toContain("ABCPE1234F");
    expect(toPayoutAccountView({ ...base, destinationHint: "HDFC ••••1234" }, T)!.destinationHint).toBe("HDFC ••••1234");
    expect(toPayoutAccountView({ ...base, destinationHint: "••••1234" }, T)!.destinationHint).toBe("••••1234");
  });

  it("carries only status: dates as ISO strings, bank change, terms, and no id", () => {
    const v = toPayoutAccountView(
      { ...base, setupStep: "done", razorpayAccountId: "acc_1", activationStatus: "activated", activatedAt: T, bookableAfter: new Date(T.getTime() + 86_400_000), termsVersion: "2026-10-17", bankChangeRequestedAt: T },
      T,
    )!;
    expect(Object.keys(v).sort()).toEqual(["activatedAt", "attention", "bankChange", "bookableAfter", "destinationHint", "requirements", "setupStep", "status", "termsVersion", "updatedAt"]);
    expect(v.activatedAt).toBe("2026-10-17T10:00:00.000Z");
    expect(v.bookableAfter).toBe("2026-10-18T10:00:00.000Z");
    expect(v.bankChange).toEqual({ requestedAt: "2026-10-17T10:00:00.000Z", clearedAt: null });
    expect(JSON.stringify(v)).not.toContain("acc_1");
  });

  it("decides who may set up: approved and verified only; closed outranks the rest", () => {
    const ok = new Date();
    expect(canSetUp({ status: "approved", emailVerifiedAt: ok })).toEqual({ canSetUp: true, blockedReason: null });
    expect(canSetUp({ status: "approved", emailVerifiedAt: null })).toEqual({ canSetUp: false, blockedReason: "email_not_verified" });
    for (const status of ["draft", "in_review", "rejected", "suspended"]) {
      expect(canSetUp({ status, emailVerifiedAt: ok }), status).toEqual({ canSetUp: false, blockedReason: "not_approved" });
    }
    expect(canSetUp({ status: "closed", emailVerifiedAt: null })).toEqual({ canSetUp: false, blockedReason: "closed" });
  });

  it("encodes and decodes a setup error as a code and references, and ignores an alert stamp", () => {
    expect(encodeSetupError("PAN_REJECTED", ["kyc.pan", "bad ref!"])).toBe("PAN_REJECTED|kyc.pan");
    expect(encodeSetupError("ACCOUNT_UNKNOWN")).toBe("ACCOUNT_UNKNOWN");
    expect(decodeSetupError("BANK_DETAILS_REJECTED|a.b,c")).toEqual({ code: "BANK_DETAILS_REJECTED", references: ["a.b", "c"] });
    expect(decodeSetupError("alerted:needs_clarification")).toBeNull();
    expect(decodeSetupError(null)).toBeNull();
  });

  it("pauses releases from a bank-change request until staff clear it, plus 72 hours", () => {
    const req = new Date("2026-10-10T00:00:00Z");
    const cleared = new Date("2026-10-12T00:00:00Z");
    const at = (ms: number) => new Date(cleared.getTime() + ms);
    const table: Array<[string, any, Date, boolean]> = [
      ["no account", null, req, false],
      ["never asked", { bankChangeRequestedAt: null, bankChangeClearedAt: null }, req, false],
      ["asked, not cleared", { bankChangeRequestedAt: req, bankChangeClearedAt: null }, at(10 * 86_400_000), true],
      ["cleared 10 minutes ago", { bankChangeRequestedAt: req, bankChangeClearedAt: cleared }, at(10 * 60_000), true],
      ["cleared 71h59m ago", { bankChangeRequestedAt: req, bankChangeClearedAt: cleared }, at(BANK_CHANGE_HOLD_MS - 60_000), true],
      ["cleared exactly 72h ago", { bankChangeRequestedAt: req, bankChangeClearedAt: cleared }, at(BANK_CHANGE_HOLD_MS), false],
      ["cleared long ago", { bankChangeRequestedAt: req, bankChangeClearedAt: cleared }, at(30 * 86_400_000), false],
      ["asked again after a clearing", { bankChangeRequestedAt: new Date(cleared.getTime() + 5 * 86_400_000), bankChangeClearedAt: cleared }, at(30 * 86_400_000), true],
    ];
    for (const [label, row, now, blocked] of table) expect(bankChangeBlocksRelease(row, now), label).toBe(blocked);
    expect(bankChangePending({ bankChangeRequestedAt: req, bankChangeClearedAt: cleared })).toBe(false);
    expect(bankChangePending({ bankChangeRequestedAt: req, bankChangeClearedAt: null })).toBe(true);
  });

  it("the IST day starts at 18:30 UTC the evening before", () => {
    expect(istDayStartUtc(new Date("2026-10-17T20:00:00Z")).toISOString()).toBe("2026-10-17T18:30:00.000Z");
    expect(istDayStartUtc(new Date("2026-10-17T18:29:59Z")).toISOString()).toBe("2026-10-16T18:30:00.000Z");
    expect(istDayStartUtc(new Date("2026-10-17T03:00:00Z")).toISOString()).toBe("2026-10-16T18:30:00.000Z");
  });
});

// ── The shared schema ───────────────────────────────────────────────────────────────────────────

describe("bank-connect schema", () => {
  it("accepts a valid body and normalises it", () => {
    const r = creatorPayoutAccountSchema.safeParse(
      bodyOf({ pan: " abcpe1234f ", ifsc: "hdfc 0001234", accountNumber: "6098 7654-3210 12", fullName: "  Zorbaxia   Quillfeather ", phone: "+91 91234-56780", address: { ...bodyOf().address, state: " karnataka ", postalCode: "560 001" } }),
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toMatchObject({ pan: SECRET.pan, ifsc: SECRET.ifsc, accountNumber: SECRET.account, fullName: SECRET.name, phone: SECRET.phone, address: { state: "KARNATAKA", postalCode: "560001" } });
  });

  it("rejects what Razorpay would, and never quotes the value in the message", () => {
    const bad: Array<[string, any]> = [
      ["pan: not an individual PAN (4th letter)", bodyOf({ pan: "ABCDE1234F" })],
      ["pan: garbage", bodyOf({ pan: "QQQQQ9999Z-LEAK" })],
      ["ifsc: no zero", bodyOf({ ifsc: "HDFC1001234" })],
      ["account: too short", bodyOf({ accountNumber: "1234" })],
      ["account: too long", bodyOf({ accountNumber: "1".repeat(21) })],
      ["phone: letters", bodyOf({ phone: "LEAKYPHONEabc" })],
      ["phone: 7 digits", bodyOf({ phone: "1234567" })],
      ["state: unknown", bodyOf({ address: { ...bodyOf().address, state: "Zorbaxia Pradesh" } })],
      ["pin: leading zero", bodyOf({ address: { ...bodyOf().address, postalCode: "060001" } })],
      ["name: digits", bodyOf({ fullName: "Zorbax1a Quill" })],
      ["name: too short", bodyOf({ fullName: "Zo" })],
      ["street: empty", bodyOf({ address: { ...bodyOf().address, street1: "" } })],
      ["terms: not accepted", bodyOf({ acceptTerms: false })],
      ["terms: missing", { ...bodyOf(), acceptTerms: undefined }],
      ["version: missing", { ...bodyOf(), termsVersion: undefined }],
    ];
    for (const [label, body] of bad) {
      const r = creatorPayoutAccountSchema.safeParse(body);
      expect(r.success, label).toBe(false);
      if (r.success) continue;
      const text = JSON.stringify(r.error.errors);
      for (const leak of ["LEAK", "QQQQQ", "Zorbaxia Pradesh", "Zorbax1a", "HDFC1001234", "ABCDE1234F", "060001", "1111111111"]) {
        expect(text, label).not.toContain(leak);
      }
      for (const e of r.error.errors) expect(e.message, label).not.toMatch(/received|expected|invalid enum/i);
    }
  });

  it("splits a bank rejection into the references a retry can change and the ones it cannot", () => {
    expect(splitBankRejection("Invalid IFSC Code")).toEqual({ references: ["settlements.ifsc_code"], ignored: [] });
    expect(splitBankRejection("Invalid IFSC; the phone is also wrong")).toEqual({ references: ["settlements.ifsc_code"], ignored: ["phone"] });
    // naming only fields the bank call never sends falls back to the three bank fields, and says what was set aside
    const panOnly = splitBankRejection("The PAN does not match");
    expect(panOnly.references).toEqual(referencesForRejection("bank", ""));
    expect(panOnly.references).toHaveLength(3);
    expect(panOnly.ignored).toEqual(["kyc.pan"]);
    expect(splitBankRejection("The postal code and the city are wrong").ignored).toEqual(["address.postal_code", "address.city"]);
    // nothing recognised: the bank fields, nothing set aside
    expect(splitBankRejection("something unexpected")).toEqual({ references: referencesForRejection("bank", ""), ignored: [] });
    // a bare "name" is the beneficiary on the bank call
    expect(splitBankRejection("The name is wrong")).toEqual({ references: ["settlements.beneficiary_name"], ignored: [] });
  });

  it("exports Razorpay's state list for the form, and maps a reference to the field it is about", () => {
    expect(PAYOUT_STATES).toHaveLength(40);
    expect(PAYOUT_STATES).toContain("KARNATAKA");
    expect(PAYOUT_STATE_CHOICES.some((s) => s.includes(" & "))).toBe(false);
    expect(PAYOUT_STATE_CHOICES).toContain("JAMMU AND KASHMIR");
    const refs: Array<[string, string | null]> = [
      ["settlements.ifsc_code", "ifsc"],
      ["settlements.ifsc", "ifsc"],
      ["settlements.account_number", "accountNumber"],
      ["settlements.beneficiary_name", "fullName"],
      ["kyc.pan", "pan"],
      ["profile.addresses.registered.postal_code", "address.postalCode"],
      ["legal_business_name", "fullName"],
      ["email", null],
    ];
    for (const [ref, field] of refs) expect(formFieldForReference(ref), ref).toBe(field);
    expect(referencesForRejection("bank", "Invalid IFSC Code")).toEqual(["settlements.ifsc_code"]);
    expect(referencesForRejection("bank", "something unexpected")).toEqual(["settlements.account_number", "settlements.ifsc_code", "settlements.beneficiary_name"]);
    expect(referencesForRejection("stakeholder", "The PAN is invalid")).toEqual(["kyc.pan"]);
    expect(normalisePayoutPhone("+91 98100-00000")).toBe("9810000000");
    expect(normalisePayoutPhone("09810000000")).toBe("9810000000");
  });
});

// ── GET, availability and gates ─────────────────────────────────────────────────────────────────

describe("availability and gates", () => {
  it("is dark while CREATOR_ROUTE_ENABLED is off: GET says so, PUT and bank-change answer 503, Razorpay is never called", async () => {
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "0");
    const { auth } = await seedCreator();
    const g = await get(auth);
    expect(g.status).toBe(200);
    expect(g.body.data).toEqual({ termsVersion: creatorConfig.termsVersion(), routeEnabled: false, canSetUp: false, blockedReason: "route_disabled", account: null });
    const p = await put(auth, bodyOf());
    expect(p.status).toBe(503);
    expect(p.body.error.code).toBe("ROUTE_DISABLED");
    expect((await postChange(auth)).status).toBe(503);
    expect(fake.calls).toHaveLength(0);
    expect(await prisma.creatorPayoutAccount.count()).toBe(0);
  });

  it("is dark without the Razorpay keys, even with the switch on", async () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "");
    expect(routeAvailable()).toBe(false);
    const { auth } = await seedCreator();
    expect((await get(auth)).body.data.routeEnabled).toBe(false);
    const p = await put(auth, bodyOf());
    expect(p.status).toBe(503);
    expect(p.body.error.code).toBe("ROUTE_DISABLED");
    expect(fake.calls).toHaveLength(0);
  });

  it("stays closed on the pre-payout terms even with the switch and the keys on (terms_pending), and opens on later terms", async () => {
    vi.stubEnv("CREATOR_TERMS_VERSION", PRE_PAYOUT_TERMS_VERSION);
    expect(payoutUnavailableReason()).toBe("terms_pending");
    expect(routeAvailable()).toBe(false);
    const { auth } = await seedCreator();
    const g = await get(auth);
    expect(g.body.data).toEqual({ termsVersion: PRE_PAYOUT_TERMS_VERSION, routeEnabled: false, canSetUp: false, blockedReason: "terms_pending", account: null });
    const p = await put(auth, bodyOf());
    expect([p.status, p.body.error.code]).toEqual([503, "TERMS_PENDING"]);
    expect(fake.calls).toHaveLength(0);
    expect(await prisma.creatorPayoutAccount.count()).toBe(0);
    // nothing about payouts shows on the checklist either: the feature is invisible until the terms are ready
    const me = await request(app).get("/v1/creator/me").set("Authorization", auth);
    expect(me.body.data.checklist).not.toHaveProperty("payoutAccount");

    // an unset version IS the pre-payout default; a dark switch outranks the terms
    vi.stubEnv("CREATOR_TERMS_VERSION", "");
    expect(payoutUnavailableReason()).toBe("terms_pending");
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "0");
    expect(payoutUnavailableReason()).toBe("route_disabled");
    expect((await get(auth)).body.data.blockedReason).toBe("route_disabled");

    vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
    vi.stubEnv("CREATOR_TERMS_VERSION", PAYOUT_TERMS);
    expect(payoutUnavailableReason()).toBeNull();
    expect((await get(auth)).body.data).toMatchObject({ routeEnabled: true, canSetUp: true, blockedReason: null });
    expect((await put(auth, bodyOf())).status).toBe(200);
  });

  it("answers 503 CREATORS_DISABLED on every payout route while the master switch is off, even with the route switch, the keys and the terms all ready", async () => {
    const { auth } = await seedCreator();
    vi.stubEnv("CREATORS_ENABLED", "0");
    expect(routeAvailable()).toBe(true); // so only the master gate can be what answers
    for (const [label, r] of [
      ["GET", await get(auth)],
      ["PUT", await put(auth, bodyOf())],
      ["POST bank-change", await postChange(auth)],
    ] as const) {
      expect([label, r.status, r.body.error.code]).toEqual([label, 503, "CREATORS_DISABLED"]);
    }
    // the gate runs before authentication, so a visitor learns nothing either
    const anon = await request(app).get("/v1/creator/payout-account");
    expect([anon.status, anon.body.error.code]).toEqual([503, "CREATORS_DISABLED"]);
    expect(fake.calls).toHaveLength(0);
    expect(await prisma.creatorPayoutAccount.count()).toBe(0);
  });

  it("GET answers 200 for any signed-in creator (even suspended) and 401 without a session", async () => {
    expect((await request(app).get("/v1/creator/payout-account")).status).toBe(401);
    const draft = await seedCreator({ status: "draft" });
    let g = await get(draft.auth);
    expect(g.body.data).toEqual({ termsVersion: creatorConfig.termsVersion(), routeEnabled: true, canSetUp: false, blockedReason: "not_approved", account: null });
    const suspended = await seedCreator({ status: "suspended" });
    g = await get(suspended.auth);
    expect(g.status).toBe(200);
    expect(g.body.data.blockedReason).toBe("not_approved");
    const unverified = await seedCreator({ verified: false });
    expect((await get(unverified.auth)).body.data.blockedReason).toBe("email_not_verified");
    const ok = await seedCreator();
    const gOk = await get(ok.auth);
    expect(gOk.body.data).toEqual({ termsVersion: creatorConfig.termsVersion(), routeEnabled: true, canSetUp: true, blockedReason: null, account: null });
    expect(gOk.headers["cache-control"]).toBe("no-store");
    expect(fake.calls).toHaveLength(0);
    expect(await prisma.creatorPayoutAccount.count()).toBe(0); // reading never creates a row
  });

  it("refuses a draft, in-review, rejected, suspended or unverified creator, and a closed account, before any Razorpay call", async () => {
    for (const status of ["draft", "in_review", "rejected"]) {
      const { auth } = await seedCreator({ status });
      const r = await put(auth, bodyOf());
      expect([r.status, r.body.error.code], status).toEqual([403, "NOT_APPROVED"]);
    }
    const s = await seedCreator({ status: "suspended" });
    const rs = await put(s.auth, bodyOf());
    expect([rs.status, rs.body.error.code]).toEqual([403, "ACCOUNT_SUSPENDED"]);
    expect((await postChange(s.auth)).status).toBe(403);
    const u = await seedCreator({ verified: false });
    const ru = await put(u.auth, bodyOf());
    expect([ru.status, ru.body.error.code]).toEqual([409, "EMAIL_NOT_VERIFIED"]);
    const closed = await seedCreator({ status: "closed" });
    expect((await put(closed.auth, bodyOf())).status).toBe(401);
    expect(fake.calls).toHaveLength(0);
    expect(await prisma.creatorPayoutAccount.count()).toBe(0);
  });

  it("refuses an outdated terms version", async () => {
    const { auth } = await seedCreator();
    const r = await put(auth, bodyOf({ termsVersion: "1999-01-01" }));
    expect([r.status, r.body.error.code]).toEqual([409, "TERMS_CHANGED"]);
    expect(fake.calls).toHaveLength(0);
  });

  it("answers 400 for an invalid body without echoing it, and never reaches Razorpay", async () => {
    const { auth } = await seedCreator();
    spyConsole();
    const bad = bodyOf({ pan: "QQQQQ9999Z-LEAK", ifsc: "NOPE", accountNumber: "LEAKYNUMBER-1", address: { ...bodyOf().address, state: "Zorbaxia Pradesh" }, secretExtra: "EXTRA-LEAK" });
    const r = await put(auth, bad);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION_ERROR");
    const text = JSON.stringify(r.body);
    for (const leak of ["QQQQQ", "LEAK", "NOPE", "Zorbaxia", "secretExtra"]) expect(text).not.toContain(leak);
    expect(fake.calls).toHaveLength(0);
    expectNoSecretsAnywhere();
  });

  it("answers a body that is not JSON as a type and a length, and never logs the text", async () => {
    const { auth } = await seedCreator();
    spyConsole();
    const r = await request(app)
      .put("/v1/creator/payout-account")
      .set("Authorization", auth)
      .set("Content-Type", "application/json")
      .send(`{"pan":"${SECRET.pan}","accountNumber":"${SECRET.account}",`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_JSON");
    expectNoSecrets("the response", r.body);
    expectNoSecretsAnywhere();
    expect(fake.calls).toHaveLength(0);
  });

  it("limits changing requests to a ceiling per creator, never GET, and never another creator", async () => {
    vi.stubEnv("RATE_LIMIT_CREATOR_PAYOUT_MAX", "3");
    const a = await seedCreator();
    const b = await seedCreator();
    for (let i = 0; i < 3; i++) expect((await put(a.auth, { ...bodyOf(), acceptTerms: false })).status).toBe(400);
    const limited = await put(a.auth, bodyOf());
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMIT");
    expect((await postChange(a.auth)).status).toBe(429); // the same bucket
    expect((await get(a.auth)).status).toBe(200);
    expect((await put(b.auth, { ...bodyOf(), acceptTerms: false })).status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });
});

// ── The four calls ──────────────────────────────────────────────────────────────────────────────

describe("setting up", () => {
  it("makes the four calls in order with the right bodies, stores only ids, status and a masked hint, and emails no detail", async () => {
    const { c, auth } = await seedCreator();
    spyConsole();
    const res = await put(auth, bodyOf());
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      termsVersion: creatorConfig.termsVersion(),
      routeEnabled: true,
      canSetUp: false,
      blockedReason: null,
      account: { status: "under_review", setupStep: "done", requirements: [], destinationHint: "HDFC ••••1012", termsVersion: creatorConfig.termsVersion() },
    });

    expect(fake.calls.map((x) => `${x.method} ${x.path.replace(/acc_[A-Za-z0-9_]+/g, "acc_X")}`)).toEqual([
      "POST /accounts",
      "POST /accounts/acc_X/stakeholders",
      "POST /accounts/acc_X/products",
      "PATCH /accounts/acc_X/products/acc_X",
    ]);
    const [acct, stake, prod, bank] = fake.calls;
    expect(acct.body).toMatchObject({
      email: c.email,
      phone: SECRET.phone,
      type: "route",
      legal_business_name: SECRET.name,
      business_type: "individual",
      profile: { category: "media_and_entertainment", subcategory: "content_and_publishing", addresses: { registered: { street1: SECRET.street, street2: SECRET.street2, city: "Bengaluru", state: "KARNATAKA", postal_code: "560001", country: "IN" } } },
    });
    expect(acct.body).not.toHaveProperty("reference_id");
    expect(stake.body).toMatchObject({ name: SECRET.name, email: c.email, kyc: { pan: SECRET.pan }, phone: { primary: SECRET.phone } });
    expect(prod.body).toEqual({ product_name: "route", tnc_accepted: true });
    expect(bank.body).toEqual({ settlements: { account_number: SECRET.account, ifsc_code: SECRET.ifsc, beneficiary_name: SECRET.name }, tnc_accepted: true });

    const row = (await rowOf(c.id))!;
    expect(row).toMatchObject({
      setupStep: "done",
      activationStatus: "under_review",
      destinationHint: "HDFC ••••1012",
      termsVersion: creatorConfig.termsVersion(),
      lastError: null,
      setupLockedUntil: null,
    });
    expect(row.razorpayAccountId).toMatch(/^acc_FakeAcct/);
    expect(row.razorpayStakeholderId).toBe("sth_FakeStake01x");
    expect(row.razorpayProductId).toBe("acc_prd_FakeProd01x");
    expect(row.termsAcceptedAt).not.toBeNull();
    expect(row.razorpayTncAcceptedAt).not.toBeNull();
    expect(row.accountCreatedAt).not.toBeNull();

    expectNoSecrets("the response", res.body);
    expect(await scanDatabase()).toEqual([]);
    expectNoSecretsAnywhere();
    // the creator is told, with no detail in the mail
    await flushPayoutAlertsForTests();
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ to: c.email });
    expect(String((sendEmailMock.mock.calls[0][0] as any).html)).not.toMatch(/HDFC|1012/);
  });

  it("sends the beneficiary name Razorpay accepts (letters, digits, spaces) and our creator id as reference_id only when switched on", async () => {
    vi.stubEnv("CREATOR_ROUTE_REFERENCE_ID", "1");
    const { c, auth } = await seedCreator();
    expect((await put(auth, bodyOf({ fullName: "Anne-Marie O'Neil Jr." }))).status).toBe(200);
    expect(fake.calls[0].body.reference_id).toBe(c.id);
    expect(fake.calls[3].body.settlements.beneficiary_name).toBe("AnneMarie ONeil Jr");
    expect(fake.calls[0].body.legal_business_name).toBe("Anne-Marie O'Neil Jr.");
  });

  it("uses the configured category pair, and falls back to the default for a malformed value", async () => {
    vi.stubEnv("CREATOR_ROUTE_CATEGORY", "services");
    vi.stubEnv("CREATOR_ROUTE_SUBCATEGORY", "Ad And Marketing!");
    expect(creatorConfig.routeCategory()).toEqual({ category: "services", subcategory: "content_and_publishing" });
    vi.stubEnv("CREATOR_ROUTE_SUBCATEGORY", "ad_and_marketing");
    expect(creatorConfig.routeCategory()).toEqual({ category: "services", subcategory: "ad_and_marketing" });
  });

  it("a second PUT after success sends nothing and changes nothing", async () => {
    const { c, auth } = await seedCreator();
    expect((await put(auth, bodyOf())).status).toBe(200);
    const before = await rowOf(c.id);
    fake.calls = [];
    const again = await put(auth, bodyOf({ ifsc: "ICIC0000001", accountNumber: "11112222333344" }));
    expect(again.status).toBe(200);
    expect(again.body.data.account.status).toBe("under_review");
    expect(fake.calls).toHaveLength(0);
    expect(await rowOf(c.id)).toMatchObject({ destinationHint: before!.destinationHint, razorpayAccountId: before!.razorpayAccountId });
  });

  it("records a definite rejection at the stakeholder step (PAN), tells the creator which field, then RESUMES without a second account", async () => {
    const { c, auth } = await seedCreator();
    spyConsole();
    const bad = await put(auth, bodyOf({ pan: "BADPE1234F" }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("PAN_REJECTED");
    expect(bad.body.error.details).toEqual([{ field: "pan", message: "Razorpay did not accept this PAN" }]);
    expect(bad.body.error.message).not.toMatch(/BADPE|invalid/i); // our wording, not Razorpay's
    let row = (await rowOf(c.id))!;
    expect(row.setupStep).toBe("account");
    expect(row.razorpayAccountId).toMatch(/^acc_/);
    expect(row.lastError).toBe("PAN_REJECTED|kyc.pan");
    const failed = (await get(auth)).body.data.account;
    expect(failed).toMatchObject({ status: "failed", setupStep: "stakeholder", requirements: [{ field: "kyc.pan", reason: "rejected" }] });

    fake.calls = [];
    const ok = await put(auth, bodyOf());
    expect(ok.status).toBe(200);
    expect(fake.calls.map((x) => x.method + " " + x.path.split("/").slice(-1)[0])).toEqual(["POST stakeholders", "POST products", "PATCH acc_prd_FakeProd01x"]);
    expect(fake.accounts.size).toBe(1);
    row = (await rowOf(c.id))!;
    expect(row).toMatchObject({ setupStep: "done", lastError: null });
    expect(await scanDatabase([SECRET.pan, "BADPE1234F", SECRET.account, SECRET.ifsc, SECRET.name])).toEqual([]);
    expectNoSecretsAnywhere();
  });

  it("resumes after a definite bank rejection (bad IFSC) with only the bank call, and after an unknown bank outcome likewise", async () => {
    const { c, auth } = await seedCreator();
    const bad = await put(auth, bodyOf({ ifsc: "BADD0000001" }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("BANK_DETAILS_REJECTED");
    expect(bad.body.error.details).toEqual([{ field: "ifsc", message: "Razorpay did not accept this IFSC code" }]);
    expect(JSON.stringify(bad.body)).not.toContain("BADD0000001");
    expect(await rowOf(c.id)).toMatchObject({ setupStep: "product", lastError: "BANK_DETAILS_REJECTED|settlements.ifsc_code" });

    // the network drops during the retry: applied or not, it is unknown
    fake.intercept({ match: is.patchSettlement, mode: "lose" });
    fake.calls = [];
    const lost = await put(auth, bodyOf());
    expect(lost.status).toBe(503);
    expect(lost.body.error.code).toBe("RAZORPAY_UNAVAILABLE");
    expect(await rowOf(c.id)).toMatchObject({ setupStep: "product", lastError: "RAZORPAY_UNAVAILABLE" });
    expect((await get(auth)).body.data.account.status).toBe("setting_up");

    fake.calls = [];
    const ok = await put(auth, bodyOf());
    expect(ok.status).toBe(200);
    expect(fake.calls.map((x) => x.method)).toEqual(["PATCH"]);
    expect(fake.count(is.createAccount)).toBe(0);
    expect(fake.accounts.size).toBe(1);
    expect(await rowOf(c.id)).toMatchObject({ setupStep: "done", lastError: null });
  });

  it("resumes at the product step after an unreadable answer, and never repeats the account or the stakeholder", async () => {
    const { c, auth } = await seedCreator();
    fake.intercept({ match: is.createProduct, mode: "badgateway" });
    const r1 = await put(auth, bodyOf());
    expect([r1.status, r1.body.error.code]).toEqual([409, "SETUP_UNCERTAIN"]);
    expect(await rowOf(c.id)).toMatchObject({ setupStep: "stakeholder", lastError: "PRODUCT_UNKNOWN", razorpayProductId: null });
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(String(notifyMock.mock.calls[0][0])).toContain("outcome unknown");

    // The product WAS created at Razorpay. The retry's create is refused as a duplicate: a definite 400 for a call that
    // carries none of the creator's details, so it is a manual step for staff (we lack the product's id and there is no
    // lookup of a product by account), never "your details are wrong".
    fake.calls = [];
    const r2 = await put(auth, bodyOf());
    expect([r2.status, r2.body.error.code]).toEqual([409, "SETUP_UNCERTAIN"]);
    expect(r2.body.error.details).toBeUndefined();
    expect(fake.count(is.createAccount)).toBe(0);
    expect(fake.count(is.createStakeholder)).toBe(0);
    expect(fake.accounts.size).toBe(1);
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(String(notifyMock.mock.calls[1][0])).toContain("manual step");
    expect(await rowOf(c.id)).toMatchObject({ lastError: "PRODUCT_UNKNOWN", razorpayProductId: null });

    // staff set the product id by hand; the creator's next attempt finishes with ONLY the bank call
    await prisma.creatorPayoutAccount.update({ where: { creatorId: c.id }, data: { razorpayProductId: "acc_prd_FakeProd01x" } });
    fake.calls = [];
    const r3 = await put(auth, bodyOf());
    expect(r3.status).toBe(200);
    expect(fake.calls.map((x) => x.method)).toEqual(["PATCH"]);
    expect(await rowOf(c.id)).toMatchObject({ setupStep: "done", lastError: null });
  });

  it("a refusal of the product step is a STAFF step whenever it happens: Razorpay holds a product we never recorded, with no unknown-outcome marker stored (a restart or a failed save)", async () => {
    const { c, auth } = await seedCreator();
    // The state a crash between Razorpay's answer and our save leaves: account and stakeholder done, nothing stored
    // about the product, and last_error empty because no call ever reported an unknown outcome.
    const acc = fake.seedAccount({ id: "acc_Crash01x", email: c.email, productId: "acc_prd_Crash01x" });
    acc.stakeholder = { id: "sth_Crash01x", pan: "X" };
    await prisma.creatorPayoutAccount.create({ data: { creatorId: c.id, razorpayAccountId: "acc_Crash01x", setupStep: "stakeholder", accountCreatedAt: new Date() } });
    spyConsole();

    const r = await put(auth, bodyOf());
    expect([r.status, r.body.error.code]).toEqual([409, "SETUP_UNCERTAIN"]);
    expect(r.body.error.details).toBeUndefined();
    expect(fake.calls.map((x) => x.method + " " + x.path.split("/").slice(-1)[0])).toEqual(["POST products"]); // nothing else was repeated
    expect(await rowOf(c.id)).toMatchObject({ setupStep: "stakeholder", razorpayProductId: null, lastError: "PRODUCT_UNKNOWN" });
    // not "failed / correct your details": nothing marked, nothing to retype
    expect((await get(auth)).body.data.account).toMatchObject({ status: "setting_up", attention: null, requirements: [] });
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(String(notifyMock.mock.calls[0][0])).toContain("manual step");
    const alert = JSON.stringify(notifyMock.mock.calls[0][1]);
    expect(alert).toContain("acc_Crash01x");
    expect(alert).toContain("HTTP 400");
    expect(alert).not.toContain("already requested"); // Razorpay's words are not copied
    expectNoSecretsAnywhere();

    // staff set the product id they found in the dashboard; the creator's next attempt finishes with only the bank call
    await prisma.creatorPayoutAccount.update({ where: { creatorId: c.id }, data: { razorpayProductId: "acc_prd_Crash01x" } });
    fake.calls = [];
    expect((await put(auth, bodyOf())).status).toBe(200);
    expect(fake.calls.map((x) => x.method)).toEqual(["PATCH"]);
    expect(await rowOf(c.id)).toMatchObject({ setupStep: "done", lastError: null });
  });

  it("an ADOPTED account that already has a Route product ends as a staff step too, not as 'your details'", async () => {
    const { c, auth } = await seedCreator({ email: "Adopted.Product@creators.test" });
    const acc = fake.seedAccount({ id: "acc_AdoptProd01x", email: "adopted.product@creators.test", productId: "acc_prd_AdoptProd01x" });
    acc.stakeholder = { id: "sth_AdoptProd01x", pan: "X" };

    const r = await put(auth, bodyOf());
    expect([r.status, r.body.error.code]).toEqual([409, "SETUP_UNCERTAIN"]);
    expect(r.body.error.details).toBeUndefined();
    expect(await rowOf(c.id)).toMatchObject({ razorpayAccountId: "acc_AdoptProd01x", setupStep: "stakeholder", razorpayProductId: null, lastError: "PRODUCT_UNKNOWN" });
    expect((await get(auth)).body.data.account).toMatchObject({ status: "setting_up", attention: null });
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(String(notifyMock.mock.calls[0][0])).toContain("manual step");
    expect(fake.accounts.size).toBe(1);

    await prisma.creatorPayoutAccount.update({ where: { creatorId: c.id }, data: { razorpayProductId: "acc_prd_AdoptProd01x" } });
    fake.calls = [];
    expect((await put(auth, bodyOf())).status).toBe(200);
    expect(fake.calls.map((x) => x.method)).toEqual(["PATCH"]);
    expect(await rowOf(c.id)).toMatchObject({ setupStep: "done", lastError: null });
  });

  it("a definite refusal of the product call that talks about the PAN or the IFSC is still not 'your details': the call carries none of them", async () => {
    const { c, auth } = await seedCreator();
    fake.intercept({ match: is.createProduct, mode: "reject", status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: "Your PAN and IFSC and phone are not valid", reason: "input_validation_failed" } } });
    const r = await put(auth, bodyOf());
    expect([r.status, r.body.error.code]).toEqual([409, "SETUP_UNCERTAIN"]);
    expect(r.body.error.details).toBeUndefined();
    expect(await rowOf(c.id)).toMatchObject({ lastError: "PRODUCT_UNKNOWN" }); // a code and no field references
    expect((await get(auth)).body.data.account).toMatchObject({ status: "setting_up", attention: null, requirements: [] });
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("a refusal of the product step over OUR setup (keys, a feature not enabled) is still reported as ours: 503 and a different alert", async () => {
    const { c, auth } = await seedCreator();
    fake.intercept({ match: is.createProduct, mode: "reject", status: 403, body: { error: { code: "BAD_REQUEST_ERROR", description: "Not allowed" } } });
    const r = await put(auth, bodyOf());
    expect([r.status, r.body.error.code]).toEqual([503, "PAYOUT_UNAVAILABLE"]);
    expect(await rowOf(c.id)).toMatchObject({ lastError: "RAZORPAY_UNAVAILABLE", setupStep: "stakeholder" });
    await flushPayoutAlertsForTests();
    expect(String(notifyMock.mock.calls[0][0])).toContain("refused by Razorpay");
  });

  it("treats 'cannot be more than one stakeholder' as the stakeholder already being there", async () => {
    const { c, auth } = await seedCreator();
    fake.intercept({ match: is.createStakeholder, mode: "lose" }); // created, answer lost
    const lost = await put(auth, bodyOf());
    expect(lost.status).toBe(503);
    expect(await rowOf(c.id)).toMatchObject({ setupStep: "account", razorpayStakeholderId: null });
    fake.calls = [];
    const ok = await put(auth, bodyOf());
    expect(ok.status).toBe(200);
    expect(await rowOf(c.id)).toMatchObject({ setupStep: "done", razorpayStakeholderId: null });
    expect(fake.count(is.createAccount)).toBe(0);
    expect(fake.accounts.size).toBe(1);
  });

  describe("an account Razorpay already holds is never sent bank details again", () => {
    it("a lost answer to the bank call, then the account is activated: the status update settles setup to done, and a later PUT sends nothing", async () => {
      const { c, auth } = await seedCreator();
      fake.intercept({ match: is.patchSettlement, mode: "lose" }); // applied at Razorpay, the answer never arrives
      expect((await put(auth, bodyOf())).status).toBe(503);
      let row = (await rowOf(c.id))!;
      expect(row).toMatchObject({ setupStep: "product", lastError: "RAZORPAY_UNAVAILABLE" });

      // the poll or a webhook reports the activation: Razorpay cannot activate without settlement details, so setup IS done
      const applied = await applyProductStatus(row, { activationStatus: "activated", requirements: [], at: new Date() }, { touch: true });
      expect(applied).toMatchObject({ applied: true, status: "activated" });
      row = (await rowOf(c.id))!;
      expect(row).toMatchObject({ setupStep: "done", activationStatus: "activated", lastError: null });
      const hint = row.destinationHint;

      fake.calls = [];
      const again = await put(auth, bodyOf({ ifsc: "ICIC0000001", accountNumber: "11112222333344" }));
      expect(again.status).toBe(200);
      expect(again.body.data).toMatchObject({ canSetUp: false, account: { status: "activated", setupStep: "done" } });
      expect(fake.calls).toHaveLength(0);
      expect((await rowOf(c.id))!.destinationHint).toBe(hint);
      // and the change path the creator is pointed at works
      expect((await postChange(auth)).status).toBe(200);
      expect((await rowOf(c.id))!.bankChangeRequestedAt).not.toBeNull();
    });

    it("refuses bank details for an account that reads activated or suspended while our step is still 'product': 409, nothing sent, nothing stored", async () => {
      for (const status of ["activated", "suspended"]) {
        const { c, auth } = await seedCreator();
        await prisma.creatorPayoutAccount.create({
          data: {
            creatorId: c.id,
            razorpayAccountId: `acc_Held${status}x`,
            razorpayStakeholderId: "sth_Held01x",
            razorpayProductId: `acc_prd_Held${status}x`,
            setupStep: "product",
            activationStatus: status,
            destinationHint: "HDFC ••••1012",
            accountCreatedAt: new Date(),
          },
        });
        expect((await get(auth)).body.data.canSetUp, status).toBe(false);
        fake.calls = [];
        const r = await put(auth, bodyOf());
        expect([r.status, r.body.error.code], status).toEqual([409, "ALREADY_SET_UP"]);
        expectNoSecrets(status, r.body);
        expect(fake.calls, status).toHaveLength(0);
        // nothing was touched: not the step, not the hint, not the terms stamp, and no lease is left behind
        expect(await rowOf(c.id), status).toMatchObject({ setupStep: "product", destinationHint: "HDFC ••••1012", termsAcceptedAt: null, termsVersion: null, lastError: null, setupLockedUntil: null });
      }
    });

    it("looks again right before the bank call: an activation that lands while the request is running stops it", async () => {
      const { c, auth } = await seedCreator();
      // account and product exist; the request will run the stakeholder step first, and that call is held open
      const acc = fake.seedAccount({ id: "acc_Race01x", email: c.email, productId: "acc_prd_Race01x" });
      acc.stakeholder = null;
      await prisma.creatorPayoutAccount.create({ data: { creatorId: c.id, razorpayAccountId: "acc_Race01x", razorpayProductId: "acc_prd_Race01x", setupStep: "account", activationStatus: "needs_clarification", accountCreatedAt: new Date() } });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      fake.intercept({ match: is.createStakeholder, mode: "hold", gate });
      const first = put(auth, bodyOf()).then((r) => r);
      await waitFor(() => fake.count(is.createStakeholder) === 1);
      // Razorpay activates the account (a webhook) while this request is still between steps
      await prisma.creatorPayoutAccount.update({ where: { creatorId: c.id }, data: { activationStatus: "activated" } });
      release();
      const r = await first;
      expect([r.status, r.body.error.code]).toEqual([409, "ALREADY_SET_UP"]);
      expect(fake.count(is.patchSettlement)).toBe(0);
      expect((await rowOf(c.id))!.setupLockedUntil).toBeNull();
    });

    it("an honest retry after a lost answer still finishes with only the bank call while nothing has proved the account moved on (needs_clarification, or under_review)", async () => {
      for (const seen of ["needs_clarification", "under_review"]) {
        const { c, auth } = await seedCreator();
        fake.intercept({ match: is.patchSettlement, mode: "lose" });
        expect((await put(auth, bodyOf())).status, seen).toBe(503);
        // under_review shows the details were accepted, but only an ACTIVATION settles the step, so the retry is allowed
        await applyProductStatus((await rowOf(c.id))!, { activationStatus: seen, requirements: [], at: new Date() }, { touch: true });
        expect(await rowOf(c.id), seen).toMatchObject({ setupStep: "product", activationStatus: seen });
        fake.calls = [];
        const ok = await put(auth, bodyOf());
        expect(ok.status, seen).toBe(200);
        expect(fake.calls.map((x) => x.method), seen).toEqual(["PATCH"]);
        expect(await rowOf(c.id), seen).toMatchObject({ setupStep: "done", lastError: null });
      }
    });
  });

  it("a bank-step rejection that names only the PAN offers no PAN field to retype, points at the bank fields, and tells staff", async () => {
    const { c, auth } = await seedCreator();
    fake.intercept({ match: is.patchSettlement, mode: "reject", status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: "The PAN does not match the account holder", reason: "input_validation_failed" } } });
    const r = await put(auth, bodyOf());
    expect([r.status, r.body.error.code]).toEqual([400, "BANK_DETAILS_REJECTED"]);
    // the bank retry re-sends only these three: a PAN field here would be asked for and then ignored
    expect(r.body.error.details.map((d: { field: string }) => d.field).sort()).toEqual(["accountNumber", "fullName", "ifsc"]);
    expect(await rowOf(c.id)).toMatchObject({ lastError: "BANK_DETAILS_REJECTED|settlements.account_number,settlements.ifsc_code,settlements.beneficiary_name" });
    expect((await get(auth)).body.data.account).toMatchObject({ status: "failed", attention: "fix_details" });
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(String(notifyMock.mock.calls[0][0])).toContain("another detail");
    expect(JSON.stringify(notifyMock.mock.calls[0][1])).toContain("kyc.pan");
    expectNoSecretsAnywhere();

    // a correction of the bank fields, as the form can send it, then finishes
    fake.calls = [];
    expect((await put(auth, bodyOf())).status).toBe(200);
    expect(fake.calls.map((x) => x.method)).toEqual(["PATCH"]);
  });

  it("a bank-step rejection that names a bank field AND the phone offers only the bank field", async () => {
    const { auth } = await seedCreator();
    fake.intercept({ match: is.patchSettlement, mode: "reject", status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: "Invalid IFSC; the phone is also wrong" } } });
    const r = await put(auth, bodyOf());
    expect(r.body.error.details).toEqual([{ field: "ifsc", message: "Razorpay did not accept this IFSC code" }]);
    await flushPayoutAlertsForTests();
    expect(JSON.stringify(notifyMock.mock.calls[0][1])).toContain("phone");
  });

  it("never creates two accounts when two requests overlap: the second is refused while the first holds the lease", async () => {
    const { c, auth } = await seedCreator();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.intercept({ match: is.createAccount, mode: "hold", gate });
    const first = put(auth, bodyOf()).then((r) => r);
    await waitFor(() => fake.count(is.createAccount) === 1);
    expect((await rowOf(c.id))!.setupLockedUntil).not.toBeNull();
    expect((await get(auth)).body.data.account.status).toBe("setting_up");

    const second = await put(auth, bodyOf());
    expect([second.status, second.body.error.code]).toEqual([409, "SETUP_IN_PROGRESS"]);
    release();
    const done = await first;
    expect(done.status).toBe(200);
    expect(fake.count(is.createAccount)).toBe(1);
    expect(fake.accounts.size).toBe(1);
    expect((await rowOf(c.id))!.setupLockedUntil).toBeNull();
  });

  it("two simultaneous submissions end with one account whichever request runs first", async () => {
    const { auth } = await seedCreator();
    const results = await Promise.all([put(auth, bodyOf()), put(auth, bodyOf())]);
    expect(results.map((r) => r.status).sort()).toSatisfy((s: number[]) => s[0] === 200 && (s[1] === 200 || s[1] === 409));
    expect(fake.count(is.createAccount)).toBe(1);
    expect(fake.accounts.size).toBe(1);
  });

  it("an expired lease (a crashed request) lets the next request in", async () => {
    const { c, auth } = await seedCreator();
    await prisma.creatorPayoutAccount.create({ data: { creatorId: c.id, setupLockedUntil: new Date(Date.now() - 1000) } });
    expect((await put(auth, bodyOf())).status).toBe(200);
    await prisma.creatorPayoutAccount.update({ where: { creatorId: c.id }, data: { setupStep: "none", setupLockedUntil: new Date(Date.now() + 60_000), razorpayAccountId: null } });
    const blocked = await put(auth, bodyOf());
    expect([blocked.status, blocked.body.error.code]).toEqual([409, "SETUP_IN_PROGRESS"]);
  });

  it("an unknown answer to the account create is neither success nor failure: staff are told, nothing is stored, and the retry ADOPTS the account Razorpay already made", async () => {
    const { c, auth } = await seedCreator();
    fake.intercept({ match: is.createAccount, mode: "garbage" }); // created at Razorpay, answer unreadable
    const r1 = await put(auth, bodyOf());
    expect([r1.status, r1.body.error.code]).toEqual([409, "SETUP_UNCERTAIN"]);
    expect(fake.accounts.size).toBe(1);
    let row = (await rowOf(c.id))!;
    expect(row).toMatchObject({ razorpayAccountId: null, setupStep: "none", lastError: "ACCOUNT_UNKNOWN" });
    expect(row.accountCreatedAt).not.toBeNull(); // the slot stays reserved: it may exist
    expect((await get(auth)).body.data.account.status).toBe("setting_up");
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expectNoSecrets("the staff alert", notifyMock.mock.calls);

    const r2 = await put(auth, bodyOf());
    expect(r2.status).toBe(200);
    expect(fake.count(is.createAccount)).toBe(2); // the retry asked again...
    expect(fake.accounts.size).toBe(1); // ...and Razorpay's duplicate check kept it at one
    row = (await rowOf(c.id))!;
    expect(row.razorpayAccountId).toBe([...fake.accounts.keys()][0]);
    expect(row).toMatchObject({ setupStep: "done", lastError: null });
  });

  it("treats a dropped connection and a 502 on the account create the same way", async () => {
    for (const mode of ["lose", "badgateway"] as const) {
      fake.accounts.clear();
      fake.calls = [];
      const { c, auth } = await seedCreator();
      fake.intercept({ match: is.createAccount, mode });
      const r1 = await put(auth, bodyOf());
      expect([r1.status, r1.body.error.code], mode).toEqual([409, "SETUP_UNCERTAIN"]);
      expect((await put(auth, bodyOf())).status, mode).toBe(200);
      expect(fake.accounts.size, mode).toBe(1);
      expect((await rowOf(c.id))!.razorpayAccountId, mode).toBe([...fake.accounts.keys()][0]);
    }
  });

  it("a definite refusal of the account (bad phone) releases the daily slot and asks the creator to fix the field", async () => {
    const { c, auth } = await seedCreator();
    fake.intercept({ match: is.createAccount, mode: "reject", status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: "Invalid phone number", reason: "input_validation_failed" } } });
    const r = await put(auth, bodyOf());
    expect([r.status, r.body.error.code]).toEqual([400, "DETAILS_REJECTED"]);
    expect(r.body.error.details).toEqual([{ field: "phone", message: "Razorpay did not accept this phone number" }]);
    const row = (await rowOf(c.id))!;
    expect(row).toMatchObject({ razorpayAccountId: null, accountCreatedAt: null, lastError: "DETAILS_REJECTED|phone" });
    expect((await get(auth)).body.data.account).toMatchObject({ status: "failed", attention: "fix_details", requirements: [{ field: "phone", reason: "rejected" }] });
  });

  it("tells staff, not the creator, when Razorpay refuses OUR setup (keys or a feature not enabled)", async () => {
    const { c, auth } = await seedCreator();
    fake.intercept({ match: is.createAccount, mode: "reject", status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: "The requested URL was not found on the server." } } });
    const r = await put(auth, bodyOf());
    expect([r.status, r.body.error.code]).toEqual([503, "PAYOUT_UNAVAILABLE"]);
    expect(r.body.error.details).toBeUndefined();
    expect(await rowOf(c.id)).toMatchObject({ accountCreatedAt: null, lastError: "RAZORPAY_UNAVAILABLE" });
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect((await get(auth)).body.data.account.status).toBe("setting_up");
  });

  it("holds the daily creation cap, counting only NEW creations in the current IST day", async () => {
    vi.stubEnv("CREATOR_PAYOUT_ACCOUNT_DAILY_CAP", "2");
    const a = await seedCreator();
    const b = await seedCreator();
    const c3 = await seedCreator();
    // one account created in the previous IST day does not count; one reserved right now does
    await prisma.creatorPayoutAccount.create({ data: { creatorId: randomUUID(), razorpayAccountId: "acc_OldOne01x", accountCreatedAt: new Date(istDayStartUtc().getTime() - 60_000) } });
    await prisma.creatorPayoutAccount.create({ data: { creatorId: randomUUID(), razorpayAccountId: "acc_NewOne01x", accountCreatedAt: new Date() } });

    expect((await put(a.auth, bodyOf())).status).toBe(200); // the 2nd today
    const busy = await put(b.auth, bodyOf());
    expect([busy.status, busy.body.error.code]).toEqual([503, "PAYOUT_BUSY"]);
    expect(await rowOf(b.c.id)).toMatchObject({ accountCreatedAt: null, razorpayAccountId: null });
    expect(fake.count(is.createAccount)).toBe(1);

    // a creator who already holds a slot (their account, or a creation in doubt) is RESUMING, not new
    expect((await put(a.auth, bodyOf())).status).toBe(200);
    await prisma.creatorPayoutAccount.create({ data: { creatorId: c3.c.id, accountCreatedAt: new Date(), lastError: "ACCOUNT_UNKNOWN" } });
    expect((await put(c3.auth, bodyOf())).status).toBe(200);
    expect(fake.count(is.createAccount)).toBe(2);
  });

  it("the cap check is serialised: simultaneous creators at the limit cannot all pass", async () => {
    vi.stubEnv("CREATOR_PAYOUT_ACCOUNT_DAILY_CAP", "1");
    const cs = [await seedCreator(), await seedCreator(), await seedCreator()];
    const rs = await Promise.all(cs.map((x) => put(x.auth, bodyOf())));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 503 && r.body.error.code === "PAYOUT_BUSY")).toHaveLength(2);
    expect(fake.accounts.size).toBe(1);
  });

  // The pool in this suite is ONE connection, which makes every transaction serial anyway, so the simultaneous
  // test above cannot show whether the lock exists. This one holds the advisory lock on a SECOND connection and
  // proves that a creation parks behind it and goes through once it is released.
  it("a new creation waits on the cap's advisory lock while another holds it", async () => {
    vi.stubEnv("CREATOR_PAYOUT_ACCOUNT_DAILY_CAP", "1");
    const { auth } = await seedCreator();
    const second = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL!.replace(/connection_limit=\d+/, "connection_limit=3") } } });
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const held = new Promise<void>((r) => (locked = r));
      const holder = second.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS l FROM (SELECT pg_advisory_xact_lock(${Prisma.raw(String(PAYOUT_CAP_LOCK_KEY))})) AS x`;
          locked();
          await gate;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
      await held;
      const inFlight = put(auth, bodyOf()).then((r) => r);
      // a waiter on an advisory lock appears (read through the second connection: the main pool's only one is the waiter's)
      const end = Date.now() + 5000;
      let waiting = 0;
      while (waiting === 0 && Date.now() < end) {
        const rows = await second.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
        waiting = rows[0].n;
        if (waiting === 0) await new Promise((r) => setTimeout(r, 20));
      }
      expect(waiting).toBeGreaterThan(0);
      expect(fake.count(is.createAccount)).toBe(0);
      release();
      await holder;
      const res = await inFlight;
      expect(res.status).toBe(200);
      expect(fake.count(is.createAccount)).toBe(1);
    } finally {
      await second.$disconnect();
    }
  });

  it("never lets one creator read another's account", async () => {
    const a = await seedCreator();
    const b = await seedCreator();
    expect((await put(b.auth, bodyOf())).status).toBe(200);
    const ga = (await get(a.auth)).body.data;
    expect(ga.account).toBeNull();
    expect(ga.canSetUp).toBe(true);
    const gb = (await get(b.auth)).body.data;
    expect(gb.account.status).toBe("under_review");
    expect(gb.account.destinationHint).toBe("HDFC ••••1012");
    // a bank change for A is refused: A has no account, whatever B has
    expect((await postChange(a.auth)).status).toBe(409);
    expect(JSON.stringify(ga)).not.toContain("1012");
  });
});

// ── A returning creator ─────────────────────────────────────────────────────────────────────────

describe("adopting an account Razorpay already has", () => {
  it("adopts it when its email is OUR verified email (any case) and no other creator holds it, then carries on", async () => {
    const { c, auth } = await seedCreator({ email: "Returning.Creator@creators.test" });
    // stored lowercase by the app; the fake holds it in mixed case, as a dashboard-made account might
    const acc = fake.seedAccount({ id: "acc_OldAcct01x", email: "Returning.Creator@Creators.test" });
    acc.stakeholder = { id: "sth_Old01x", pan: "X" };
    const stored = await prisma.creator.findUniqueOrThrow({ where: { id: c.id } });
    expect(stored.email).toBe("Returning.Creator@creators.test"); // the seed keeps what it is given
    const r = await put(auth, bodyOf());
    expect(r.status).toBe(200);
    expect(fake.accounts.size).toBe(1);
    expect(fake.count(is.createAccount)).toBe(1); // the refused create
    expect(await rowOf(c.id)).toMatchObject({ razorpayAccountId: "acc_OldAcct01x", setupStep: "done" });
    expect(fake.count(is.fetchAccount)).toBe(1);
  });

  it("refuses it when its email is not ours, and tells staff", async () => {
    const { c, auth } = await seedCreator();
    fake.seedAccount({ id: "acc_StrangerAcct01x", email: "someone.else@elsewhere.test" });
    fake.intercept({ match: is.createAccount, mode: "reject", status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: "Merchant email already exists for account - StrangerAcct01x." } } });
    const r = await put(auth, bodyOf());
    expect([r.status, r.body.error.code]).toEqual([409, "ACCOUNT_CONFLICT"]);
    const row = (await rowOf(c.id))!;
    expect(row).toMatchObject({ razorpayAccountId: null, accountCreatedAt: null, lastError: "ACCOUNT_CONFLICT" });
    // "failed", but nothing for the creator to retype: the screen is told to say so (contact us), not "correct the marked details"
    expect((await get(auth)).body.data.account).toMatchObject({ status: "failed", attention: "contact_us", requirements: [] });
    expect(fake.count(is.createStakeholder)).toBe(0);
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(notifyMock.mock.calls)).toContain("acc_StrangerAcct01x");
  });

  it("refuses it when another creator is already mapped to it", async () => {
    const a = await seedCreator();
    const b = await seedCreator();
    fake.seedAccount({ id: "acc_HeldAcct01x", email: a.c.email });
    await prisma.creatorPayoutAccount.create({ data: { creatorId: b.c.id, razorpayAccountId: "acc_HeldAcct01x", setupStep: "account" } });
    const r = await put(a.auth, bodyOf());
    expect([r.status, r.body.error.code]).toEqual([409, "ACCOUNT_CONFLICT"]);
    expect(await rowOf(a.c.id)).toMatchObject({ razorpayAccountId: null, accountCreatedAt: null, lastError: "ACCOUNT_CONFLICT" });
    expect(await rowOf(b.c.id)).toMatchObject({ razorpayAccountId: "acc_HeldAcct01x", setupStep: "account" });
    expect(fake.count(is.createStakeholder)).toBe(0);
    // refused by the rule itself (not only by the unique index behind it): staff are told why
    await flushPayoutAlertsForTests();
    expect(JSON.stringify(notifyMock.mock.calls)).toContain("Another creator is already mapped");
  });
});

// ── Privacy ─────────────────────────────────────────────────────────────────────────────────────

describe("what is kept (privacy)", () => {
  it("after rejections, a lost answer and a full setup, NO column of ANY table holds a submitted value, and nothing was logged or sent", async () => {
    const { c, auth } = await seedCreator();
    spyConsole();
    // a refused PAN, a refused bank, a lost bank answer, then success: every error path runs with the real values in flight
    expect((await put(auth, bodyOf({ pan: "BADPE1234F" }))).status).toBe(400);
    expect((await put(auth, bodyOf({ ifsc: "BADD0000001" }))).status).toBe(400);
    fake.intercept({ match: is.patchSettlement, mode: "lose" });
    expect((await put(auth, bodyOf())).status).toBe(503);
    expect((await put(auth, bodyOf())).status).toBe(200);
    expect(await postChange(auth)).toMatchObject({ status: 200 });
    await flushPayoutAlertsForTests();

    const hits = await scanDatabase([...NEEDLES, "BADPE1234F", "BADD0000001", "ECHOEDPAN1", "Echoed Legal Name"]);
    expect(hits).toEqual([]);
    expectNoSecretsAnywhere();
    expectNoSecrets("the stored row", await rowOf(c.id));
    for (const r of [await get(auth)]) expectNoSecrets("a GET response", r.body);
  });

  it("Razorpay's own error text, which can quote what we sent, is read for keywords and never stored, returned or logged", async () => {
    const { c, auth } = await seedCreator();
    spyConsole();
    // a refusal whose description repeats the creator's name, street, PAN, IFSC and account number
    const quote = `Invalid IFSC for ${SECRET.name} living at ${SECRET.street}: PAN ${SECRET.pan}, ${SECRET.ifsc}, account ${SECRET.account}`;
    fake.intercept({ match: is.patchSettlement, mode: "reject", status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: quote, reason: `bad ${SECRET.name}`, field: SECRET.street } } });
    const r = await put(auth, bodyOf());
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BANK_DETAILS_REJECTED");
    expectNoSecrets("the response", r.body);
    // only the references its keywords point at, never the text. The text names the IFSC and the PAN; the bank
    // retry re-sends only bank fields, so only the IFSC is kept and the PAN is a note to staff instead.
    expect(await rowOf(c.id)).toMatchObject({ lastError: "BANK_DETAILS_REJECTED|settlements.ifsc_code" });
    // an unknown outcome and a staff alert that carry Razorpay's words likewise
    fake.intercept({ match: is.patchSettlement, mode: "badgateway" });
    expect((await put(auth, bodyOf())).status).toBe(503);
    await flushPayoutAlertsForTests();
    expect(await scanDatabase()).toEqual([]);
    expectNoSecretsAnywhere();
  });

  it("the stakeholder, account and product answers echo the PAN, number and name, and none of it survives", async () => {
    const { c, auth } = await seedCreator();
    const res = await put(auth, bodyOf());
    expect(res.status).toBe(200);
    // the fake echoed the PAN on the stakeholder and on the account's legal info, and the number on the product
    const acc = [...fake.accounts.values()][0];
    expect(acc.stakeholder!.pan).toBe(SECRET.pan);
    expect(acc.product!.settlements!.account_number).toBe(SECRET.account);
    expect(JSON.stringify(await rowOf(c.id))).not.toMatch(/ECHOEDPAN1|60987654321012|ABCPE1234F/);
    expect(await scanDatabase()).toEqual([]);
  });
});

// ── Bank change ─────────────────────────────────────────────────────────────────────────────────

describe("changing the bank account", () => {
  it("needs an account that finished setup", async () => {
    const { auth } = await seedCreator();
    const r = await postChange(auth);
    expect([r.status, r.body.error.code]).toEqual([409, "NO_PAYOUT_ACCOUNT"]);
  });

  it("records ONE request (idempotent, even when double-clicked), tells staff and the creator, and calls Razorpay not at all", async () => {
    const { c, auth } = await seedCreator();
    expect((await put(auth, bodyOf())).status).toBe(200);
    await flushPayoutAlertsForTests();
    fake.calls = [];
    sendEmailMock.mockClear();
    notifyMock.mockClear();

    const rs = await Promise.all([postChange(auth), postChange(auth)]);
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    await flushPayoutAlertsForTests();
    const row = (await rowOf(c.id))!;
    expect(row.bankChangeRequestedAt).not.toBeNull();
    expect(row.bankChangeClearedAt).toBeNull();
    expect(rs[0].body.data.account.bankChange.requestedAt).toBe(row.bankChangeRequestedAt!.toISOString());
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(fake.calls).toHaveLength(0);

    // a third request later changes nothing
    const again = await postChange(auth);
    expect(again.body.data.account.bankChange.requestedAt).toBe(row.bankChangeRequestedAt!.toISOString());
    await flushPayoutAlertsForTests();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(bankChangeBlocksRelease(await rowOf(c.id))).toBe(true);
  });

  // Staff clear a request through the real route (creator-admin.service.ts markBankChangeProcessed: compare-and-swap,
  // audit row, email), the ONLY clearing path. This keeps the one assertion no admin test makes: a request made AFTER a
  // clearing goes through requestBankChange's own SQL and is pending again.
  it("staff marking it processed starts the 72-hour pause, and a new request after that is pending again", async () => {
    const { c, auth } = await seedCreator();
    expect((await put(auth, bodyOf())).status).toBe(200);
    const staff = await createTestUser({ name: "Review Staff" });
    const admin = `Bearer ${generateToken(staff.id, staff.email, ["Admin"])}`;
    const clear = () => request(app).post(`/v1/admin/creators/${c.id}/payout-account/bank-change/cleared`).set("Authorization", admin);

    expect((await clear()).status).toBe(409); // nothing pending
    expect((await postChange(auth)).status).toBe(200);
    expect((await clear()).status).toBe(200);
    expect((await clear()).status).toBe(409); // already cleared
    let row = (await rowOf(c.id))!;
    const cleared = row.bankChangeClearedAt!;
    expect(bankChangePending(row)).toBe(false);
    expect(bankChangeBlocksRelease(row, new Date(cleared.getTime() + 71 * 3_600_000))).toBe(true);
    expect(bankChangeBlocksRelease(row, new Date(cleared.getTime() + 72 * 3_600_000))).toBe(false);

    await new Promise((r) => setTimeout(r, 15));
    const second = await requestBankChange(c.id);
    expect(second.account!.bankChange.clearedAt).not.toBeNull();
    row = (await rowOf(c.id))!;
    expect(row.bankChangeRequestedAt!.getTime()).toBeGreaterThan(row.bankChangeClearedAt!.getTime());
    expect(bankChangePending(row)).toBe(true);
  });
});

// ── Razorpay product facts → our columns ────────────────────────────────────────────────────────

describe("applyProductStatus (the one mapping)", () => {
  // Three hours back, whole seconds: the webhook reads event times at second precision and refuses future ones.
  const T0 = new Date(Math.floor((Date.now() - 3 * 3_600_000) / 1000) * 1000);
  const at = (min: number) => new Date(T0.getTime() + min * 60_000);
  const R = [{ field_reference: "settlements.ifsc_code", reason_code: "field_missing", status: "required" }];

  async function seedRow(over: Record<string, unknown> = {}) {
    return prisma.creatorPayoutAccount.create({
      data: { creatorId: randomUUID(), razorpayAccountId: `acc_Map${++n}x`, razorpayProductId: "acc_prd_Map01x", setupStep: "done", activationStatus: "under_review", ...over },
    });
  }

  it("activated: stores the status, activated_at and bookable_after = +24h, clears last_error, and keeps both on a re-activation", async () => {
    const row = await seedRow({ lastError: "alerted:needs_clarification" });
    const r1 = await applyProductStatus(row, { activationStatus: "activated", requirements: [], at: at(0) });
    expect(r1).toMatchObject({ applied: true, note: "applied", previous: "under_review", status: "activated" });
    let now = (await prisma.creatorPayoutAccount.findUnique({ where: { id: row.id } }))!;
    expect(now).toMatchObject({ activationStatus: "activated", lastError: null });
    expect(now.activatedAt!.toISOString()).toBe(at(0).toISOString());
    expect(now.bookableAfter!.toISOString()).toBe(new Date(at(0).getTime() + 86_400_000).toISOString());
    expect(now.lastCheckedAt!.toISOString()).toBe(at(0).toISOString());

    await applyProductStatus(now, { activationStatus: "needs_clarification", requirements: R, at: at(60) });
    now = (await prisma.creatorPayoutAccount.findUnique({ where: { id: row.id } }))!;
    expect(now.activationStatus).toBe("needs_clarification");
    expect(now.requirements).toEqual([{ field_reference: "settlements.ifsc_code", reason_code: "field_missing", status: "required" }]);
    expect(now.activatedAt!.toISOString()).toBe(at(0).toISOString());

    await applyProductStatus(now, { activationStatus: "activated", requirements: [], at: at(120) });
    now = (await prisma.creatorPayoutAccount.findUnique({ where: { id: row.id } }))!;
    expect(now.activationStatus).toBe("activated");
    expect(now.activatedAt!.toISOString()).toBe(at(0).toISOString()); // kept
    expect(now.bookableAfter!.toISOString()).toBe(new Date(at(0).getTime() + 86_400_000).toISOString()); // kept
  });

  it("maps every status Razorpay documents, ignores one it does not, and never writes an unknown value", async () => {
    for (const s of ["requested", "under_review", "needs_clarification", "activated", "suspended"]) {
      const row = await seedRow({ activationStatus: s === "requested" ? "suspended" : "requested" });
      const r = await applyProductStatus(row, { activationStatus: s.toUpperCase(), requirements: [], at: at(1) });
      expect(r.status, s).toBe(s);
      expect((await prisma.creatorPayoutAccount.findUnique({ where: { id: row.id } }))!.activationStatus, s).toBe(s);
    }
    const row = await seedRow();
    const r = await applyProductStatus(row, { activationStatus: "created", requirements: [], at: at(1) });
    expect(r).toMatchObject({ applied: false, note: "unknown_status" });
    expect(mapProductFacts(row, { activationStatus: "", requirements: [], at: at(1) })).toBeNull();
    expect((await prisma.creatorPayoutAccount.findUnique({ where: { id: row.id } }))!.activationStatus).toBe("under_review");
  });

  it("an event older than what we last saw changes nothing; a replay changes nothing twice", async () => {
    const row = await seedRow();
    await applyProductStatus(row, { activationStatus: "needs_clarification", requirements: R, at: at(30) });
    const fresh = (await prisma.creatorPayoutAccount.findUnique({ where: { id: row.id } }))!;
    const old = await applyProductStatus(fresh, { activationStatus: "under_review", requirements: [], at: at(10) });
    expect(old).toMatchObject({ applied: false, note: "stale" });
    const replay = await applyProductStatus(fresh, { activationStatus: "needs_clarification", requirements: R, at: at(30) });
    expect(replay).toMatchObject({ applied: false, note: "unchanged" });
    expect((await prisma.creatorPayoutAccount.findUnique({ where: { id: row.id } }))!.activationStatus).toBe("needs_clarification");
  });

  it("an activation settles a setup still waiting at the bank call to done, and nothing else does", async () => {
    // [our setup_step, what Razorpay says, the step afterwards]: only an ACTIVATION proves the bank details were applied
    const cases: Array<[string, string, string]> = [
      ["product", "activated", "done"],
      ["product", "under_review", "product"],
      ["product", "needs_clarification", "product"],
      ["product", "suspended", "product"],
      ["stakeholder", "activated", "stakeholder"],
      ["done", "activated", "done"],
    ];
    for (const [step, status, expected] of cases) {
      const row = await seedRow({ setupStep: step, activationStatus: "requested" });
      const r = await applyProductStatus(row, { activationStatus: status, requirements: [], at: at(1) });
      expect(r.applied, `${step} + ${status}`).toBe(true);
      expect((await prisma.creatorPayoutAccount.findUnique({ where: { id: row.id } }))!.setupStep, `${step} + ${status}`).toBe(expected);
    }
    // an already-activated row that still reads "product" is NOT 'unchanged': the settling write must happen
    const stuck = await seedRow({ setupStep: "product", activationStatus: "activated", activatedAt: at(0), bookableAfter: at(1440) });
    expect(mapProductFacts(stuck, { activationStatus: "activated", requirements: [], at: at(2) })!.unchanged).toBe(false);
    const done = await seedRow({ setupStep: "done", activationStatus: "activated", requirements: [], activatedAt: at(0), bookableAfter: at(1440) });
    expect(mapProductFacts(done, { activationStatus: "activated", requirements: [], at: at(2) })!.unchanged).toBe(true);
  });

  it("an unchanged status stamps last_checked_at only when asked to (the poll), never for a webhook event", async () => {
    const row = await seedRow({ lastCheckedAt: at(0), requirements: [] });
    await applyProductStatus(row, { activationStatus: "under_review", requirements: [], at: at(5) });
    expect((await prisma.creatorPayoutAccount.findUnique({ where: { id: row.id } }))!.lastCheckedAt!.toISOString()).toBe(at(0).toISOString());
    await applyProductStatus(row, { activationStatus: "under_review", requirements: [], at: at(5) }, { touch: true });
    expect((await prisma.creatorPayoutAccount.findUnique({ where: { id: row.id } }))!.lastCheckedAt!.toISOString()).toBe(at(5).toISOString());
  });

  it("stores requirement references and codes only, scrubbed, and a poll's masked hint", async () => {
    const row = await seedRow();
    await applyProductStatus(
      row,
      {
        activationStatus: "needs_clarification",
        requirements: [
          { field_reference: "settlements.ifsc_code", reason_code: "kyc_failed", status: "required" },
          { field_reference: SECRET.pan, reason_code: `Account ${SECRET.account} is wrong`, status: null },
        ],
        at: at(1),
        settlementHint: "HDFC ••••1012",
      },
      { touch: true },
    );
    const stored = (await prisma.creatorPayoutAccount.findUnique({ where: { id: row.id } }))!;
    expect(stored.destinationHint).toBe("HDFC ••••1012");
    expect(JSON.stringify(stored.requirements)).not.toContain(SECRET.pan);
    expect(JSON.stringify(stored.requirements)).not.toContain(SECRET.account);
    expect(await scanDatabase([SECRET.pan, SECRET.account])).toEqual([]);
  });

  it("the product.route webhook goes through it: same stored result for the same facts", async () => {
    const { handleRouteEvent } = await import("../src/services/campaign/route-webhooks");
    const row = await seedRow({ razorpayAccountId: "acc_HookAcct01x" });
    const event = (name: string, status: string, created: number) => ({
      account_id: "acc_Platform01x",
      created_at: Math.floor(at(created).getTime() / 1000),
      payload: { merchant_product: { entity: { id: "acc_prd_Map01x", merchant_id: "acc_HookAcct01x", activation_status: status }, data: { requirements: R } } },
    });
    const r1 = await handleRouteEvent("product.route.needs_clarification", event("x", "needs_clarification", 1));
    expect(r1).toEqual({ handled: true, note: "account needs_clarification" });
    const r2 = await handleRouteEvent("product.route.needs_clarification", event("x", "needs_clarification", 1));
    expect(r2).toEqual({ handled: true, note: "unchanged" });
    const r3 = await handleRouteEvent("product.route.activated", event("x", "activated", 0)); // older than the first
    expect(r3).toEqual({ handled: true, note: "stale" });
    const r4 = await handleRouteEvent("product.route.activated", event("x", "activated", 2));
    expect(r4).toEqual({ handled: true, note: "account activated" });
    const stored = (await prisma.creatorPayoutAccount.findUnique({ where: { id: row.id } }))!;
    expect(stored.activationStatus).toBe("activated");
    expect(stored.bookableAfter!.toISOString()).toBe(new Date(at(2).getTime() + 86_400_000).toISOString());
  });
});

// ── The checklist and closing the account ───────────────────────────────────────────────────────

describe("the creator checklist and closing the account", () => {
  it("adds a payout item to the checklist only while bank connect is available", async () => {
    const { auth } = await seedCreator();
    let me = await request(app).get("/v1/creator/me").set("Authorization", auth);
    expect(me.body.data.checklist.payoutAccount).toEqual({ status: "not_started", done: false });
    expect(await put(auth, bodyOf())).toMatchObject({ status: 200 });
    me = await request(app).get("/v1/creator/me").set("Authorization", auth);
    expect(me.body.data.checklist.payoutAccount).toEqual({ status: "under_review", done: true });

    vi.stubEnv("CREATOR_ROUTE_ENABLED", "0");
    me = await request(app).get("/v1/creator/me").set("Authorization", auth);
    expect(me.body.data.checklist).toEqual({ emailVerified: true, connected: false, publishablePages: 0, submitted: true }); // exactly the old shape
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    me = await request(app).get("/v1/creator/me").set("Authorization", auth);
    expect(me.body.data.checklist).not.toHaveProperty("payoutAccount");
  });

  it("an account that is not done reads not done", async () => {
    const { auth } = await seedCreator();
    fake.intercept({ match: is.createProduct, mode: "badgateway" });
    await put(auth, bodyOf());
    const me = await request(app).get("/v1/creator/me").set("Authorization", auth);
    expect(me.body.data.checklist.payoutAccount).toEqual({ status: "setting_up", done: false });
  });

  it("will not close an account while an offer is open (offered or accepted), and closes once it is not", async () => {
    const { c, auth } = await seedCreator();
    const offer = (status: string) =>
      prisma.creatorOffer.create({
        data: {
          bookingId: randomUUID(),
          bookingItemId: randomUUID(),
          creatorId: c.id,
          creatorAssetId: randomUUID(),
          pageName: "Page",
          platform: "instagram",
          format: "reel",
          payoutPaise: 100_000,
          status,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    for (const open of ["offered", "accepted"]) {
      const o = await offer(open);
      const r = await request(app).delete("/v1/creator/me").set("Authorization", auth);
      expect([r.status, r.body.error.code], open).toEqual([409, "OPEN_OFFERS"]);
      expect((await prisma.creator.findUniqueOrThrow({ where: { id: c.id } })).status, open).toBe("approved");
      await prisma.creatorOffer.delete({ where: { id: o.id } });
    }
    for (const closed of ["declined", "expired", "withdrawn", "completed"]) await offer(closed);
    const ok = await request(app).delete("/v1/creator/me").set("Authorization", auth);
    expect(ok.status).toBe(200);
    expect((await prisma.creator.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("closed");
  });

  it("another creator's open offer does not block this creator", async () => {
    const a = await seedCreator();
    const b = await seedCreator();
    await prisma.creatorOffer.create({
      data: { bookingId: randomUUID(), bookingItemId: randomUUID(), creatorId: b.c.id, creatorAssetId: randomUUID(), pageName: "P", platform: "facebook", format: "post", payoutPaise: 5000, status: "offered", expiresAt: new Date(Date.now() + 86_400_000) },
    });
    expect((await request(app).delete("/v1/creator/me").set("Authorization", a.auth)).status).toBe(200);
  });
});
