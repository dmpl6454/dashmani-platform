/**
 * The staff side of the creator payouts (routes in campaign-admin.routes.ts, logic in services/creator/payout-staff.service.ts): who
 * may call it, what a row may contain, the queue's views and paging, every action (idempotent, and a plain 409 when it is not legal),
 * the CSV, and the runtime release switch. Real routes, real engine, the stateful fake of Razorpay behind them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import app from "../src/app";
import { notifyAdminByEmail } from "../src/services/email.service";
import { clearPayoutAlertMarkersForTests, flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { settlePayoutKicksForTests } from "../src/services/campaign/payment.service";
import { settleCreatorRefundsForTests } from "../src/services/creator/creator-refund.service";
import { onCreatorLinkVerified } from "../src/services/creator/payout-ledger";
import { PAYOUT_CSV_HEADERS, PAYOUT_FILTERS } from "../src/services/creator/payout-staff.service";
import { RELEASE_SWITCH_KEY, confirmHold, resolveUnknownTransfer } from "../src/services/creator/payout.service";
import { REVERSE_PAUSE_REASON } from "../src/services/creator/payout-pause";
import { payoutHint, pausedChip } from "@dashmani/shared/src/payouts/staff-ui";
import { resetCreatorPayoutsCronForTests, runCreatorPayoutsTick } from "../src/cron/creator-payouts.cron";
import { FakeRazorpay, is } from "./fake-razorpay-route";
import { generateClientToken, generateCreatorToken, generateHrToken, generateToken } from "./helpers";
import { DAY, HOUR, MIN, callLog, capture, countOf, ensureStaffUser, mkStaff, mkWorld, openOffer, payoutOf, stubPayoutEnv, verifiedOffer, type StaffWorld, type World } from "./payout-fixtures";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const fake = new FakeRazorpay();
let staff: StaffWorld;

beforeEach(async () => {
  // system_settings is not truncated between tests: the release switch must start every test absent (= on).
  await prisma.systemSetting.deleteMany({ where: { key: "creatorPayouts.release" } });
  await clearPayoutAlertMarkersForTests();
  stubPayoutEnv();
  fake.reset();
  fake.install();
  resetPayoutAlertsForTests();
  resetCreatorPayoutsCronForTests();
  staff = await mkStaff();
});
afterEach(async () => {
  await prisma.systemSetting.deleteMany({ where: { key: "creatorPayouts.release" } }); // leave nothing behind for the next file
  await settlePayoutKicksForTests();
  await settleCreatorRefundsForTests();
  await flushPayoutAlertsForTests();
  fake.restore();
  vi.unstubAllEnvs();
});

const BASE = "/v1/admin/creator-payouts";
const get = (path: string, token: string | null = staff.admin) => {
  const r = request(app).get(`${BASE}${path}`);
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};
const post = (path: string, body: object = {}, token: string | null = staff.admin) => {
  const r = request(app).post(`${BASE}${path}`).send(body);
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};
const put = (path: string, body: object = {}, token: string | null = staff.admin) => {
  const r = request(app).put(`${BASE}${path}`).send(body);
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};

const paid = async (spec: Parameters<typeof mkWorld>[1]): Promise<World> => {
  const w = await mkWorld(fake, spec);
  expect((await capture(fake, w)).status).toBe(200);
  return w;
};
const setPayout = (itemId: string, data: Record<string, unknown>) => prisma.creatorPayout.update({ where: { bookingItemId: itemId }, data });
const idOf = async (itemId: string) => (await payoutOf(itemId)).id;
const events = (payoutId: string) => prisma.creatorPayoutEvent.findMany({ where: { payoutId }, orderBy: { createdAt: "asc" } });

/** A minimal RFC 4180 reader: quoted cells, doubled quotes, CRLF rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && src[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ── Who may call it ─────────────────────────────────────────────────────────────────

describe("the gate: internal Admin / Super Admin only, for every route", () => {
  const ROUTES: Array<["get" | "post" | "put", string, object?]> = [
    ["get", ""],
    ["get", ".csv"],
    ["get", "/release-switch"],
    ["put", "/release-switch", { mode: "off" }],
    ["get", "/some-payout-id"],
    ["post", "/some-payout-id/pause", {}],
    ["post", "/some-payout-id/resume", {}],
    ["post", "/some-payout-id/retry-transfer", {}],
    ["post", "/some-payout-id/reverse", {}],
    ["post", "/some-payout-id/release-now", {}],
    ["post", "/some-payout-id/require-manual", { reason: "x" }],
    ["post", "/some-payout-id/mark-manual-paid", { reference: "UTR12345" }],
    ["post", "/some-payout-id/attest-no-transfer", { note: "looked in the dashboard" }],
    ["post", "/some-payout-id/adopt-transfer", { transferId: "trf_SOMETRANSFER1" }],
  ];
  const call = (m: "get" | "post" | "put", path: string, body: object | undefined, token: string | null) => (m === "get" ? get(path, token) : m === "post" ? post(path, body, token) : put(path, body, token));

  it("answers 401 with no token, and refuses a creator, a client, an HR user and a non-admin employee on every route", async () => {
    const w = await paid({ pages: [{}] });
    const employee = await prisma.user.create({ data: { name: "Plain Employee", email: "plain@p4a.test", passwordHash: "x", status: "ACTIVE" } });
    const tokens: Array<[string, string | null, number[]]> = [
      ["no token", null, [401]],
      ["creator", generateCreatorToken(w.creators[0].creatorId!, "c@x.test"), [401, 403]],
      ["client", generateClientToken(w.clientId, "client@x.test"), [403]],
      ["hr", generateHrToken(employee.id, employee.email), [403]],
      ["employee (not an admin)", generateToken(employee.id, employee.email, ["Employee"]), [403]],
    ];
    const before = fake.calls.length;
    for (const [who, token, ok] of tokens) {
      for (const [m, path, body] of ROUTES) {
        const res = await call(m, path, body, token);
        expect(ok, `${who} ${m.toUpperCase()} ${BASE}${path} -> ${res.status}`).toContain(res.status);
      }
    }
    // Refused means untouched: nothing was written at Razorpay and the switch was not flipped.
    expect(fake.calls.length).toBe(before);
    expect((await get("/release-switch")).body.data.release).toBe("on");
    expect((await payoutOf(w.creators[0].id)).status).toBe("held");
  });

  it("a Super Admin is accepted", async () => {
    const su = await prisma.user.create({ data: { name: "Super", email: "super@p4a.test", passwordHash: "x", status: "ACTIVE" } });
    expect((await get("", generateToken(su.id, su.email, ["Super Admin"]))).status).toBe(200);
  });
});

// ── What a row may contain ──────────────────────────────────────────────────────────

describe("rows are an allow-list: ids, names, amounts in paise, statuses, times and the destination HINT; never bank data or a Razorpay body", () => {
  const ROW_KEYS = [
    "amountPaise", "amountReversedPaise", "attempts", "bookingId", "bookingItemId", "bookingName", "createdAt", "creatorId", "creatorName", "destinationHint", "errorCode",
    "format", "grossPaise", "hasTransfer", "heldAt", "id", "itemPricePaise", "itemStatus", "lastEvent", "linkVerifiedAt", "manualPaidAt", "manualReference", "pageName", "pausedAt",
    "pausedReason", "platform", "releaseAfter", "releasedAt", "reversedAt", "settledAt", "settlementUtr", "status", "tdsPaise", "updatedAt",
  ];

  it("a queue row has exactly the allow-listed keys, and a canary in every column that must not leave the server never appears", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    await setPayout(c.id, { lastError: "CANARY_RAZORPAY_BODY {\"error\":{\"description\":\"x\"}}", errorCode: "needs_look", manualNote: "CANARY_NOTE", manualReference: "CANARY_REF1234", destinationHint: "HDFC ••••1234" });
    const res = await get("");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    const row = res.body.data.rows[0];
    expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    // Whether a transfer is recorded, never which one: the id stays in the detail.
    expect(row.hasTransfer).toBe(true);
    expect(row.destinationHint).toBe("HDFC ••••1234");
    // The staff-recorded bank-transfer REFERENCE is the one thing of that group a finished payout's row now carries on purpose ("was creator X paid, and
    // under which reference?"): it is a reference, never an account detail (a PAN- or IFSC-shaped one is refused when it is recorded). Its note stays out.
    expect(row.manualReference).toBe("CANARY_REF1234");
    const text = JSON.stringify(res.body);
    for (const secret of ["CANARY_RAZORPAY_BODY", "CANARY_NOTE", "acc_P4I", "trf_", "pay_P4I", "razorpayAccountId", "razorpayTransferId", "razorpayPaymentId", "account_number", "ifsc", "beneficiary"]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(Object.keys(res.body.data).sort()).toEqual(["counts", "filter", "nextCursor", "rows", "switches"]);
    expect(res.body.data.switches).toEqual({ release: true, newTransfers: true, worker: true, razorpay: true });
  });

  it("the queue says whether Razorpay's keys are set: without them nothing moves, whatever the other switches say", async () => {
    await paid({ pages: [{}] });
    expect((await get("")).body.data.switches.razorpay).toBe(true);
    // Either key missing (an operator removed one) reads as not configured. The worker and every engine step are idle/refused in that state, and the
    // staff page draws a bar for it (a CREATOR_ROUTE_ENABLED bar would name the wrong cause).
    for (const k of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"]) {
      vi.stubEnv(k, "");
      const res = await get("");
      expect(res.status, k).toBe(200);
      expect(res.body.data.switches, k).toEqual({ release: true, newTransfers: true, worker: true, razorpay: false });
      vi.stubEnv(k, k === "RAZORPAY_KEY_ID" ? "rzp_test_key" : "rzp_test_secret");
    }
    expect((await get("")).body.data.switches.razorpay).toBe(true);
  });

  it("the detail adds the history and references (the linked account's id is what staff look up), but still never bank details", async () => {
    const w = await paid({ pages: [{}] });
    const res = await get(`/${await idOf(w.creators[0].id)}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(Object.keys(d).sort()).toEqual(["account", "disputes", "events", "item", "offer", "payout"]);
    expect(d.payout.razorpayTransferId).toMatch(/^trf_/);
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["planned", "transfer"]));
    for (const e of d.events) expect(Object.keys(e).sort()).toEqual(["actorType", "amountPaise", "createdAt", "fromStatus", "id", "kind", "note", "toStatus"]);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/account_number|ifsc_code|beneficiary_name|\bPAN\b|"pan"/i);
    expect(d.account).toEqual({ activationStatus: "activated", bankChangePending: false });
    expect((await get("/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });
});

// ── The queue's views ───────────────────────────────────────────────────────────────

describe("the queue: views, counts and keyset paging", () => {
  async function mixed() {
    const w = await paid({ pages: Array.from({ length: 7 }, () => ({})) });
    const [awaiting, scheduled, attention, manual, failed, paused, finished] = w.creators;
    await verifiedOffer(w, scheduled.id);
    await onCreatorLinkVerified(scheduled.id, { type: "staff", id: staff.staffId });
    await setPayout(attention.id, { status: "needs_attention", errorCode: "processed_not_held" });
    await setPayout(manual.id, { status: "manual_required" });
    await setPayout(failed.id, { status: "failed", errorCode: "bad_request" });
    await setPayout(paused.id, { pausedAt: new Date(), pausedReason: "staff" });
    await setPayout(finished.id, { status: "settled" });
    return { w, awaiting, scheduled, attention, manual, failed, paused, finished };
  }
  const ids = async (filter: string) => (await get(`?filter=${filter}`)).body.data.rows.map((r: { bookingItemId: string }) => r.bookingItemId);

  it("every view lists the right payouts, `open` is everything not finished, and the counts match the views", async () => {
    const m = await mixed();
    expect((await ids("held_awaiting_verify")).sort()).toEqual([m.awaiting.id, m.paused.id].sort());
    expect(await ids("releasing")).toEqual([m.scheduled.id]);
    expect(await ids("needs_attention")).toEqual([m.attention.id]);
    expect(await ids("manual_required")).toEqual([m.manual.id]);
    expect(await ids("failed")).toEqual([m.failed.id]);
    expect(await ids("paused")).toEqual([m.paused.id]);
    expect(await ids("settlement_pending")).toEqual([]);
    const open = await ids("open");
    expect(open).toHaveLength(6);
    expect(open).not.toContain(m.finished.id);
    const res = await get("");
    expect(res.body.data.counts).toEqual({ open: 6, needs_attention: 1, manual_required: 1, paused: 1, held_awaiting_verify: 2, releasing: 1, settlement_pending: 0, failed: 1, owed_after_reversal: 0, finished: 1, all: 7 });
    for (const f of PAYOUT_FILTERS) expect(Object.keys(res.body.data.counts)).toContain(f);
    // An unknown view is the default view, never an error and never "everything including finished".
    expect((await get("?filter=everything")).body.data.filter).toBe("open");
    expect((await get("?filter=everything")).body.data.rows).toHaveLength(6);
  });

  it("filters by campaign and by creator; keyset paging walks the queue oldest first, once each", async () => {
    const m = await mixed();
    const other = await paid({ pages: [{}] });
    expect((await get(`?bookingId=${m.w.booking.id}`)).body.data.rows).toHaveLength(6);
    expect((await get(`?bookingId=${other.booking.id}`)).body.data.rows).toHaveLength(1);
    expect((await get(`?creatorId=${m.awaiting.creatorId}`)).body.data.rows).toHaveLength(1);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res: request.Response = await get(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.data.rows.map((r: { id: string }) => r.id));
      cursor = res.body.data.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(7); // 6 open here + 1 in the other campaign
    expect(new Set(seen).size).toBe(7);
    const created = await prisma.creatorPayout.findMany({ where: { id: { in: seen } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } });
    expect(seen).toEqual(created.map((c) => c.id));
  });

  it("limit is clamped (0, negative, junk and huge all answer a sane page)", async () => {
    await paid({ pages: [{}, {}] });
    for (const q of ["?limit=0", "?limit=-5", "?limit=abc", "?limit=100000"]) {
      const res = await get(q);
      expect(res.status, q).toBe(200);
      expect(res.body.data.rows.length, q).toBeGreaterThan(0);
      expect(res.body.data.rows.length, q).toBeLessThanOrEqual(200);
    }
    expect((await get("?limit=1")).body.data.rows).toHaveLength(1);
  });
});

// ── The actions ─────────────────────────────────────────────────────────────────────

describe("actions: one engine step run as the staff member, safe to repeat, a plain 409 when not legal, and each leaves an audit row", () => {
  it("pause and resume: idempotent, audited with the staff id, and a finished payout cannot be paused", async () => {
    const w = await paid({ pages: [{}, {}] });
    const [a, done] = w.creators;
    const id = await idOf(a.id);
    const paused = await post(`/${id}/pause`, { reason: "Checking with the creator" });
    expect(paused.status).toBe(200);
    expect(paused.body.data.payout.pausedAt).not.toBeNull();
    expect((await post(`/${id}/pause`, {})).status).toBe(200); // already paused: nothing more
    const resumed = await post(`/${id}/resume`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.data.payout.pausedAt).toBeNull();
    const again = await post(`/${id}/resume`); // not paused any more: already what was asked for
    expect(again.status).toBe(200);
    expect(again.body.data.result.outcome).toBe("not_paused");
    const trail = (await events(id)).filter((e) => e.actorType === "staff");
    expect(trail.length).toBeGreaterThanOrEqual(2);
    expect(trail.every((e) => e.actorId === staff.staffId)).toBe(true);

    await setPayout(done.id, { status: "settled" });
    const refused = await post(`/${await idOf(done.id)}/pause`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("PAYOUT_ACTION_REFUSED");
    expect(refused.body.error.message).toMatch(/Nothing was changed/);
  });

  it("⚠️ resume is refused while a dispute is still open on the payment", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    const id = await idOf(c.id);
    await post(`/${id}/pause`, {});
    const pay = await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: w.booking.id } });
    await prisma.campaignDispute.create({ data: { razorpayDisputeId: `disp_${randomUUID().slice(0, 8)}`, razorpayPaymentId: pay.razorpayPaymentId!, status: "open", amountPaise: 1000, openedAt: new Date() } });
    const res = await post(`/${id}/resume`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/dispute/i);
    expect((await payoutOf(c.id)).pausedAt).not.toBeNull();
  });

  it("retry-transfer: a failed payout gets ONE fresh transfer; a held one is refused; and once a refund exists it is refused [R4]", async () => {
    // Razorpay refuses the first transfer outright (nothing changed): the payout fails.
    const w = await mkWorld(fake, { pages: [{}, {}] });
    fake.intercept({ match: is.createTransfer, mode: "reject", status: 400, times: 2 });
    await capture(fake, w);
    const [a, b] = w.creators;
    expect((await payoutOf(a.id)).status).toBe("failed");
    expect((await payoutOf(b.id)).status).toBe("failed");

    // Staff retry A: a fresh transfer, now held; B stays failed.
    const ok = await post(`/${await idOf(a.id)}/retry-transfer`);
    expect(ok.status).toBe(200);
    expect((await payoutOf(a.id)).status).toBe("held");
    expect(countOf(callLog(fake), "transfer.create")).toBe(3);
    // Retrying a payout that is already held is refused, and creates nothing.
    const held = await post(`/${await idOf(a.id)}/retry-transfer`);
    expect(held.status).toBe(409);
    expect(held.body.error.message).toMatch(/only a failed or a planned payout/i);
    expect(countOf(callLog(fake), "transfer.create")).toBe(3);

    // A refund now exists on the payment: Razorpay can no longer transfer from it.
    const pay = await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: w.booking.id } });
    await prisma.campaignRefund.create({ data: { razorpayRefundId: `rfnd_${randomUUID().slice(0, 10)}`, paymentId: pay.id, razorpayPaymentId: pay.razorpayPaymentId!, bookingId: w.booking.id, amountPaise: 1000, status: "processed" } });
    const refused = await post(`/${await idOf(b.id)}/retry-transfer`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/refund already exists|pay the creator by bank transfer/i);
    expect((await payoutOf(b.id)).status).toBe("failed");
    expect(countOf(callLog(fake), "transfer.create")).toBe(3);
    // The audit trail names the staff member.
    expect((await events(await idOf(a.id))).some((e) => e.actorType === "staff" && e.actorId === staff.staffId)).toBe(true);
  });

  it("reverse: takes a held share back (one explicit reversal), and doing it again is a plain 'already done' with no second reversal", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    const id = await idOf(c.id);
    const res = await post(`/${id}/reverse`, { reason: "Creator withdrew" });
    expect(res.status).toBe(200);
    expect(res.body.data.payout.status).toBe("reversed");
    expect(countOf(callLog(fake), "reversal.create")).toBe(1);
    const again = await post(`/${id}/reverse`, {});
    expect(again.status).toBe(200);
    expect(countOf(callLog(fake), "reversal.create")).toBe(1);
    const t = [...fake.transfers.values()][0];
    expect(t.amountReversed).toBe(t.amount);
    const ev = (await events(id)).filter((e) => e.actorType === "staff");
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev.every((e) => e.actorId === staff.staffId)).toBe(true);
  });

  it("a reversal Razorpay has not confirmed is not an error: 200 with a note, the payout is reversal_requested, and the worker finishes it", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    fake.intercept({ match: is.createReversal, mode: "lose", times: 1 });
    const res = await post(`/${await idOf(c.id)}/reverse`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.result.note).toMatch(/not been confirmed/i);
    expect((await payoutOf(c.id)).status).toBe("reversal_requested");
    await runCreatorPayoutsTick({ now: new Date(Date.now() + 30 * MIN) });
    expect((await payoutOf(c.id)).status).toBe("reversed");
    expect(countOf(callLog(fake), "reversal.create")).toBe(1);
  });

  it("require-manual then mark-manual-paid: the reference is recorded once, a PAN or an IFSC is refused as a reference, and a payout that still has a live transfer cannot be marked paid", async () => {
    const w = await mkWorld(fake, { pages: [{}, {}] });
    fake.intercept({ match: is.createTransfer, mode: "reject", status: 400, times: 1 });
    await capture(fake, w);
    const [failed, held] = w.creators;
    const failedPayout = (await payoutOf(failed.id)).status === "failed" ? failed : held;
    const heldPayout = failedPayout === failed ? held : failed;
    expect((await payoutOf(failedPayout.id)).status).toBe("failed");
    expect((await payoutOf(heldPayout.id)).status).toBe("held");

    // A held payout has a live transfer that could still release: it can be neither marked manual nor paid.
    expect((await post(`/${await idOf(heldPayout.id)}/require-manual`, { reason: "bank transfer" })).status).toBe(409);
    expect((await post(`/${await idOf(heldPayout.id)}/mark-manual-paid`, { reference: "UTR20260101" })).status).toBe(409);
    expect((await payoutOf(heldPayout.id)).status).toBe("held");

    const id = await idOf(failedPayout.id);
    // ⚠️ r2 #R5: a failed payout's post never went live (an offer needs a held payout), so nothing is owed: a person cannot switch it to a bank transfer.
    const notLive = await post(`/${id}/require-manual`, { reason: "Route cannot pay this creator" });
    expect(notLive.status).toBe(409);
    expect(notLive.body.error.message).toMatch(/\[post_not_live\]/);
    expect((await payoutOf(failedPayout.id)).status).toBe("failed");
    // A post that IS live and verified (made so here by hand) is owed, and then it can be.
    await verifiedOffer(w, failedPayout.id);
    const required = await post(`/${id}/require-manual`, { reason: "Route cannot pay this creator" });
    expect(required.status).toBe(200);
    expect(required.body.data.payout.status).toBe("manual_required");
    // Not a payment reference: a PAN and an IFSC are the shapes the engine will never store.
    for (const bad of ["ABCDE1234F", "HDFC0001234"]) {
      const res = await post(`/${id}/mark-manual-paid`, { reference: bad });
      expect(res.status, bad).toBe(409);
      expect(res.body.error.message).toMatch(/reference is not valid/i);
    }
    expect((await post(`/${id}/mark-manual-paid`, { reference: "abc" })).status).toBe(400); // too short for the schema
    expect((await payoutOf(failedPayout.id)).status).toBe("manual_required");
    const paidRes = await post(`/${id}/mark-manual-paid`, { reference: "UTR20260102XYZ", note: "Paid from the HDFC current account" });
    expect(paidRes.status).toBe(200);
    expect(paidRes.body.data.payout.status).toBe("paid_manual");
    expect(paidRes.body.data.payout.manualReference).toBe("UTR20260102XYZ");
    // Recording the same payment again is "already done" and changes nothing.
    const again = await post(`/${id}/mark-manual-paid`, { reference: "UTR20260102XYZ" });
    expect(again.status).toBe(200);
    expect(await prisma.creatorPayoutEvent.count({ where: { payoutId: id, kind: "manual_paid" } })).toBeLessThanOrEqual(1);
    const trail = (await events(id)).filter((e) => e.actorType === "staff");
    expect(trail.every((e) => e.actorId === staff.staffId)).toBe(true);
  });

  describe("release-now is the SAME gate as the worker: it cannot bypass anything", () => {
    const writes = () => fake.calls.filter(is.v1Write).length;

    it("a verified, due payout is released; doing it again is refused (it is no longer held) and lifts nothing twice", async () => {
      const w = await paid({ pages: [{}] });
      const c = w.creators[0];
      await verifiedOffer(w, c.id);
      await onCreatorLinkVerified(c.id, { type: "staff", id: staff.staffId });
      const id = await idOf(c.id);
      const res = await post(`/${id}/release-now`);
      expect(res.status).toBe(200);
      expect(res.body.data.payout.status).toBe("released");
      expect(fake.count((x) => is.setHold(x, false))).toBe(1);
      const again = await post(`/${id}/release-now`);
      expect(again.status).toBe(409);
      expect(again.body.error.message).toMatch(/not held/i);
      expect(fake.count((x) => is.setHold(x, false))).toBe(1);
    });

    it.each([
      ["a post nobody has posted or verified", /the post is not live/i],
    ])("refuses %s, with the reason in plain words and no Razorpay write", async (_what, message) => {
      const w = await paid({ pages: [{}] });
      await openOffer(w, w.creators[0].id, { status: "accepted" }); // the campaign is approved and the creator accepted, but nothing was posted or verified
      const before = writes();
      const res = await post(`/${await idOf(w.creators[0].id)}/release-now`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("PAYOUT_ACTION_REFUSED");
      expect(res.body.error.message).toMatch(message);
      expect(res.body.error.message).toMatch(/Nothing was changed/);
      expect(writes()).toBe(before);
    });

    it("refuses while the hold has not run out (release_after in the future), while the runtime switch is off, with a dispute, with a pending bank change and while paused", async () => {
      vi.stubEnv("CREATOR_PAYOUT_HOLD_DAYS", "3");
      const w = await paid({ pages: [{}] });
      const c = w.creators[0];
      await verifiedOffer(w, c.id);
      await onCreatorLinkVerified(c.id, { type: "staff", id: staff.staffId });
      const id = await idOf(c.id);
      const before = writes();
      const expectRefused = async (re: RegExp) => {
        const res = await post(`/${id}/release-now`);
        expect(res.status).toBe(409);
        expect(res.body.error.message).toMatch(re);
        expect((await payoutOf(c.id)).status).toBe("held");
        expect(writes()).toBe(before);
      };
      await expectRefused(/scheduled for later|hold has not run out/i);

      // The hold has run out ...
      await setPayout(c.id, { releaseAfter: new Date(Date.now() - MIN) });
      // ... but releases are paused at runtime ...
      expect((await put("/release-switch", { mode: "off" })).status).toBe(200);
      await expectRefused(/paused \(the runtime switch is off\)/i);
      expect((await put("/release-switch", { mode: "on" })).status).toBe(200);
      // ... or the creator's bank change is pending ...
      const account = await prisma.creatorPayoutAccount.findFirstOrThrow({ where: { creatorId: c.creatorId! } });
      await prisma.creatorPayoutAccount.update({ where: { id: account.id }, data: { bankChangeRequestedAt: new Date() } });
      await expectRefused(/bank change/i);
      await prisma.creatorPayoutAccount.update({ where: { id: account.id }, data: { bankChangeRequestedAt: null } });
      // ... or the payout is paused ...
      await setPayout(c.id, { pausedAt: new Date(), pausedReason: "staff" });
      await expectRefused(/paused/i);
      await setPayout(c.id, { pausedAt: null, pausedReason: null });
      // ... or a dispute is recorded.
      const pay = await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: w.booking.id } });
      await prisma.campaignDispute.create({ data: { razorpayDisputeId: `disp_${randomUUID().slice(0, 8)}`, razorpayPaymentId: pay.razorpayPaymentId!, status: "open", amountPaise: 1000, openedAt: new Date() } });
      await expectRefused(/dispute/i);
      await prisma.campaignDispute.deleteMany({});
      // Nothing left in the way: now it goes.
      const ok = await post(`/${id}/release-now`);
      expect(ok.status).toBe(200);
      expect((await payoutOf(c.id)).status).toBe("released");
    });

    it("a verified post whose release was never scheduled is scheduled first (Release now works); an unverified one is refused and nothing is scheduled for it", async () => {
      const w = await paid({ pages: [{}, {}] });
      const [verified, unverified] = w.creators;
      await verifiedOffer(w, verified.id, { verifiedAt: new Date(Date.now() - 2 * HOUR) }); // the follow-up after the verification never ran
      await openOffer(w, unverified.id, { status: "accepted" });
      expect((await payoutOf(verified.id)).releaseAfter).toBeNull();
      const ok = await post(`/${await idOf(verified.id)}/release-now`);
      expect(ok.status).toBe(200);
      expect((await payoutOf(verified.id)).status).toBe("released");
      expect(await prisma.creatorPayoutEvent.count({ where: { payoutId: (await payoutOf(verified.id)).id, kind: "schedule" } })).toBe(1);
      const no = await post(`/${await idOf(unverified.id)}/release-now`);
      expect(no.status).toBe(409); // the post is not even live: the gate says so, and nothing was scheduled or changed
      expect((await payoutOf(unverified.id)).status).toBe("held");
      expect((await payoutOf(unverified.id)).releaseAfter).toBeNull();
    });

    it("an unknown payout is a 404 on every action", async () => {
      const missing = "00000000-0000-0000-0000-000000000000";
      for (const [path, body] of [["pause", {}], ["resume", {}], ["retry-transfer", {}], ["reverse", {}], ["release-now", {}], ["require-manual", { reason: "x" }], ["mark-manual-paid", { reference: "UTR12345" }]] as const) {
        expect((await post(`/${missing}/${path}`, body)).status, path).toBe(404);
      }
    });
  });
});

// ── The CSV ─────────────────────────────────────────────────────────────────────────

describe("the CSV of the queue", () => {
  it("has the documented header (with a BOM so Excel reads UTF-8), a dated filename, no caching, and one line per payout of the view", async () => {
    const w = await paid({ pages: [{}, {}] });
    for (const c of w.creators) await setPayout(c.id, { destinationHint: "HDFC ••••1234" });
    const res = await get(".csv?filter=open").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (d: Buffer) => chunks.push(d));
      r.on("end", () => cb(null, Buffer.concat(chunks).toString("utf8")));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="creator-payouts-open-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    const text = res.body as unknown as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(text);
    expect(rows[0]).toEqual([...PAYOUT_CSV_HEADERS]);
    expect(rows).toHaveLength(3);
    for (const r of rows.slice(1)) expect(r).toHaveLength(PAYOUT_CSV_HEADERS.length);
    expect(rows.slice(1).map((r) => r[3]).sort()).toEqual(w.creators.map((c) => c.id).sort());
    expect(rows[1][6]).toBe("held");
    expect(rows[1][9]).toBe("2500.00");
    expect(rows[1][14]).toBe("HDFC ••••1234");
    expect(text).not.toMatch(/acc_P4I|trf_|pay_P4I|account_number|ifsc/i);
  });

  it("⚠️ every cell is formula-guarded: a creator or a page named like a formula is text, never a formula", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    await prisma.creator.update({ where: { id: c.creatorId! }, data: { name: '=HYPERLINK("http://evil.example","click")' } });
    await prisma.campaignBookingItem.update({ where: { id: c.id }, data: { accountName: "@SUM(1+1)" } });
    await prisma.campaignBooking.update({ where: { id: w.booking.id }, data: { name: "+cmd|' /C calc'!A0" } });
    const res = await get(".csv").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (d: Buffer) => chunks.push(d));
      r.on("end", () => cb(null, Buffer.concat(chunks).toString("utf8")));
    });
    const row = parseCsv(res.body as unknown as string)[1];
    const [creator, page, campaign] = [row[4], row[5], row[2]];
    for (const cell of [creator, page, campaign]) expect(/^[=+\-@]/.test(cell), cell).toBe(false);
    expect(creator.startsWith("'=HYPERLINK")).toBe(true);
    expect(page).toBe("'@SUM(1+1)");
    // The quotes inside survived as data (the RFC 4180 doubling), not as a broken row.
    expect(creator).toContain('"http://evil.example"');
    expect(row).toHaveLength(PAYOUT_CSV_HEADERS.length);
  });

  it("streams a queue of more than one batch (500 rows) without loss: every payout appears exactly once, oldest first", async () => {
    const w = await paid({ pages: [{}] });
    const template = await payoutOf(w.creators[0].id);
    const N = 1_130;
    const base = Date.now() - 2 * DAY;
    const rows = Array.from({ length: N }, (_, i) => ({
      id: randomUUID(),
      bookingId: template.bookingId,
      bookingItemId: randomUUID(),
      creatorId: template.creatorId,
      payoutAccountId: template.payoutAccountId,
      razorpayAccountId: template.razorpayAccountId,
      razorpayPaymentId: template.razorpayPaymentId,
      status: "held",
      itemPricePaise: 250_000,
      shareBps: 4000,
      grossPaise: 100_000,
      amountPaise: 100_000,
      createdAt: new Date(base + i * 1000),
    }));
    await prisma.creatorPayout.createMany({ data: rows });
    const res = await get(".csv").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (d: Buffer) => chunks.push(d));
      r.on("end", () => cb(null, Buffer.concat(chunks).toString("utf8")));
    });
    expect(res.status).toBe(200);
    const parsed = parseCsv(res.body as unknown as string);
    expect(parsed).toHaveLength(N + 2); // header + the seeded N + the captured one
    const ids = parsed.slice(1).map((r) => r[0]);
    expect(new Set(ids).size).toBe(N + 1);
    for (const r of parsed.slice(1)) expect(r).toHaveLength(PAYOUT_CSV_HEADERS.length);
    // Oldest first: the seeded rows (older) come in creation order, the freshly captured one last.
    expect(ids.slice(0, N)).toEqual(rows.map((r) => r.id));
    expect(ids[N]).toBe(template.id);
  });

  it("a view with nothing in it is just the header; an unknown filter is the open view", async () => {
    await paid({ pages: [{}] });
    const csv = async (q: string) =>
      parseCsv(
        (
          await get(`.csv${q}`).buffer(true).parse((r, cb) => {
            const chunks: Buffer[] = [];
            r.on("data", (d: Buffer) => chunks.push(d));
            r.on("end", () => cb(null, Buffer.concat(chunks).toString("utf8")));
          })
        ).body as unknown as string,
      );
    expect(await csv("?filter=failed")).toHaveLength(1);
    expect(await csv("?filter=nonsense")).toHaveLength(2);
  });
});

// ── The runtime switch ──────────────────────────────────────────────────────────────

describe("the release switch", () => {
  it("is on when absent; PUT off pauses every release at once; PUT on (or deleting the row) resumes; junk is a 400 and changes nothing", async () => {
    expect((await get("/release-switch")).body.data).toEqual({ key: RELEASE_SWITCH_KEY, release: "on", updatedAt: null, lastChange: null });
    const off = await put("/release-switch", { mode: "off" });
    expect(off.status).toBe(200);
    expect(off.body.data.release).toBe("off");
    expect((await get("/release-switch")).body.data.release).toBe("off");
    expect((await get("")).body.data.switches.release).toBe(false);
    expect((await put("/release-switch", { mode: "maybe" })).status).toBe(400);
    expect((await put("/release-switch", {})).status).toBe(400);
    expect((await get("/release-switch")).body.data.release).toBe("off");
    const on = await put("/release-switch", { mode: "on" });
    expect(on.body.data.release).toBe("on");
    await prisma.systemSetting.update({ where: { key: RELEASE_SWITCH_KEY }, data: { value: "off" } });
    await prisma.systemSetting.delete({ where: { key: RELEASE_SWITCH_KEY } });
    expect((await get("/release-switch")).body.data.release).toBe("on");
  });

  it("⚠️ it stops releases and nothing else: while it is off the worker releases nothing, yet still makes transfers and takes a share back", async () => {
    await put("/release-switch", { mode: "off" });
    const w = await mkWorld(fake, { pages: [{}, {}] });
    expect((await capture(fake, w)).status).toBe(200);
    const [released, reversed] = w.creators;
    expect((await payoutOf(released.id)).status).toBe("held"); // transfers are still made
    await verifiedOffer(w, released.id);
    await onCreatorLinkVerified(released.id, { type: "staff", id: staff.staffId });
    await runCreatorPayoutsTick({ now: new Date(Date.now() + 2 * DAY) });
    expect(fake.count((x) => is.setHold(x, false))).toBe(0);
    expect((await payoutOf(released.id)).status).toBe("held");
    // A reversal is not a release: staff can still take a share back.
    expect((await post(`/${await idOf(reversed.id)}/reverse`, {})).status).toBe(200);
    expect((await payoutOf(reversed.id)).status).toBe("reversed");
    // Back on: the due release goes.
    await put("/release-switch", { mode: "on" });
    await runCreatorPayoutsTick({ now: new Date(Date.now() + 3 * DAY) });
    expect((await payoutOf(released.id)).status).toBe("released");
  });

  it("⚠️ who flipped it is ON RECORD: an audit row (staff, time, before, after) that the GET returns; a call that changes nothing writes none; the console line stays", async () => {
    await ensureStaffUser(staff);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await put("/release-switch", { mode: "off" });
      expect(warn.mock.calls.some((c) => String(c[0]).includes(`releases switched off by staff ${staff.staffId}`))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    const auditRows = () => prisma.auditLog.findMany({ where: { action: "creator_payouts.release_switch" }, orderBy: { createdAt: "asc" } });
    let log = await auditRows();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ userId: staff.staffId, resource: "system_settings", resourceId: RELEASE_SWITCH_KEY, before: { release: "on" }, after: { release: "off" } });
    // A double click (nothing changes) adds no row.
    expect((await put("/release-switch", { mode: "off" })).status).toBe(200);
    expect(await auditRows()).toHaveLength(1);
    // The GET says who, when and from what, and a response never carries more than that.
    const g = (await get("/release-switch")).body.data;
    expect(g.release).toBe("off");
    expect(g.updatedAt).toEqual(expect.any(String));
    expect(g.lastChange).toMatchObject({ byId: staff.staffId, from: "on", to: "off" });
    expect(Object.keys(g.lastChange).sort()).toEqual(["at", "byId", "byName", "from", "to"]);
    // Resuming is on record too, and the GET follows the newest change.
    await put("/release-switch", { mode: "on" });
    log = await auditRows();
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ before: { release: "off" }, after: { release: "on" } });
    expect((await get("/release-switch")).body.data.lastChange).toMatchObject({ from: "off", to: "on" });
  });

  it("⚠️ an audit table that cannot be written never blocks the emergency 'off': the switch is set, the answer is 200", async () => {
    await ensureStaffUser(staff);
    await prisma.$executeRawUnsafe("ALTER TABLE audit_logs RENAME TO audit_logs_gone");
    try {
      const r = await put("/release-switch", { mode: "off" });
      expect(r.status).toBe(200);
      expect(r.body.data.release).toBe("off");
      expect(r.body.data.lastChange).toBeNull();
    } finally {
      await prisma.$executeRawUnsafe("ALTER TABLE audit_logs_gone RENAME TO audit_logs");
    }
    expect((await prisma.systemSetting.findUnique({ where: { key: RELEASE_SWITCH_KEY } }))?.value).toBe("off");
    expect(await prisma.auditLog.count({ where: { action: "creator_payouts.release_switch" } })).toBe(0);
  });
});

// ── Finished payouts stay reachable ──────────────────────────────────────────────────

describe("finished payouts are visible: the `finished` and `all` views, a summary on the campaign page, and the CSV carries who was paid and under which reference", () => {
  async function history() {
    const w = await paid({ pages: [{}, {}, {}, {}] });
    const [settled, byHand, reversed, open] = w.creators;
    await setPayout(settled.id, { status: "settled", settledAt: new Date(Date.now() - 2 * DAY), settlementUtr: "UTR0000123456", releasedAt: new Date(Date.now() - 3 * DAY) });
    await setPayout(byHand.id, { status: "paid_manual", manualReference: "NEFT-98765", manualPaidAt: new Date(Date.now() - DAY) });
    await setPayout(reversed.id, { status: "reversed", reversedAt: new Date(Date.now() - DAY), amountReversedPaise: reversed.payout });
    return { w, settled, byHand, reversed, open };
  }
  const itemIds = async (q: string) => (await get(q)).body.data.rows.map((r: { bookingItemId: string }) => r.bookingItemId);

  it("`open` hides them; `finished` lists exactly the four finished states, newest first, with the UTR and the transfer reference; `all` lists everything of the campaign", async () => {
    const h = await history();
    expect(await itemIds("?filter=open")).toEqual([h.open.id]);
    const fin = (await get("?filter=finished")).body.data;
    expect(fin.filter).toBe("finished");
    expect(fin.rows.map((r: { bookingItemId: string }) => r.bookingItemId).sort()).toEqual([h.settled.id, h.byHand.id, h.reversed.id].sort());
    // Newest first: creation order reversed.
    const created = await prisma.creatorPayout.findMany({ where: { id: { in: fin.rows.map((r: { id: string }) => r.id) } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    expect(fin.rows.map((r: { id: string }) => r.id)).toEqual(created.map((c) => c.id));
    const byItem = new Map<string, { settlementUtr: string | null; manualReference: string | null; manualPaidAt: string | null; status: string }>(fin.rows.map((r: { bookingItemId: string }) => [r.bookingItemId, r]));
    expect(byItem.get(h.settled.id)).toMatchObject({ status: "settled", settlementUtr: "UTR0000123456", manualReference: null });
    expect(byItem.get(h.byHand.id)).toMatchObject({ status: "paid_manual", manualReference: "NEFT-98765", settlementUtr: null });
    expect(byItem.get(h.byHand.id)!.manualPaidAt).toEqual(expect.any(String));
    expect((await itemIds(`?filter=all&bookingId=${h.w.booking.id}`)).sort()).toEqual([h.settled.id, h.byHand.id, h.reversed.id, h.open.id].sort());
    expect((await get("")).body.data.counts).toMatchObject({ open: 1, finished: 3, all: 4 });
  });

  it("the history views page newest first without a repeat or a gap", async () => {
    await history();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const res: request.Response = await get(`?filter=all&limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...res.body.data.rows.map((r: { id: string }) => r.id));
      cursor = res.body.data.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    const all = await prisma.creatorPayout.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    expect(seen).toEqual(all.map((a) => a.id));
  });

  it("the campaign page's offers carry a compact summary of their post's payout, finished ones too, from an allow-list: a UTR and a reference, never a Razorpay id or a bank detail", async () => {
    const h = await history();
    await verifiedOffer(h.w, h.settled.id);
    await verifiedOffer(h.w, h.byHand.id);
    const res = await request(app).get(`/v1/admin/campaigns/${h.w.booking.id}`).set("Authorization", `Bearer ${staff.admin}`);
    expect(res.status).toBe(200);
    const offers: Array<{ itemId: string; payout: Record<string, unknown> | null }> = res.body.data.creatorOffers;
    const of = (id: string) => offers.find((o) => o.itemId === id)!;
    expect(of(h.settled.id).payout).toMatchObject({ status: "settled", settlementUtr: "UTR0000123456", manualReference: null });
    expect(of(h.byHand.id).payout).toMatchObject({ status: "paid_manual", manualReference: "NEFT-98765" });
    expect(Object.keys(of(h.settled.id).payout!).sort()).toEqual([
      "amountPaise", "amountReversedPaise", "errorCode", "id", "manualPaidAt", "manualReference", "pausedAt", "pausedReason", "releaseAfter", "releasedAt", "reversedAt", "settledAt", "settlementUtr", "status",
    ]);
    const text = JSON.stringify(offers);
    for (const secret of ["acc_P4I", "trf_", "pay_P4I", "razorpayAccountId", "razorpayTransferId", "razorpayPaymentId", "account_number", "ifsc", "beneficiary", "destinationHint"]) expect(text, secret).not.toContain(secret);
  });

  it("the CSV of the finished view has the UTR, the bank transfer reference and when it was recorded (appended: the older columns keep their place)", async () => {
    const h = await history();
    const res = await get(".csv?filter=finished").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (d: Buffer) => chunks.push(d));
      r.on("end", () => cb(null, Buffer.concat(chunks).toString("utf8")));
    });
    expect(res.status).toBe(200);
    const rows = parseCsv(res.body as unknown as string);
    expect(rows[0]).toEqual([...PAYOUT_CSV_HEADERS]);
    expect(rows[0].slice(0, 5)).toEqual(["Payout", "Campaign", "Campaign name", "Post", "Creator"]);
    expect(rows).toHaveLength(4);
    const col = (name: string) => PAYOUT_CSV_HEADERS.indexOf(name as never);
    const row = (itemId: string) => rows.find((r) => r[3] === itemId)!;
    expect(row(h.settled.id)[col("Paid: settlement UTR")]).toBe("UTR0000123456");
    expect(row(h.byHand.id)[col("Paid: bank transfer reference")]).toBe("NEFT-98765");
    expect(row(h.byHand.id)[col("Bank transfer recorded at (UTC)")]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row(h.reversed.id)[col("Status")]).toBe("reversed");
    expect(rows.slice(1).map((r) => r[col("Status")]).sort()).toEqual(["paid_manual", "reversed", "settled"]);
  });
});

describe("⚠️ reverse first, then pay by hand: a reversed payout of a LIVE post stays reachable and can be paid by hand; one of a post that will not be paid cannot", () => {
  async function reversedLive() {
    const w = await paid({ pages: [{}, {}] });
    const [a, b] = w.creators;
    await verifiedOffer(w, a.id);
    await onCreatorLinkVerified(a.id, { type: "staff", id: staff.staffId });
    const pid = await idOf(a.id);
    expect((await post(`/${pid}/reverse`, {})).status).toBe(200);
    expect((await payoutOf(a.id)).status).toBe("reversed");
    return { w, a, b, pid };
  }

  it("the reversed payout of a live post is in `owed_after_reversal` (and on the badge); require-manual, then mark-manual-paid, ends it with its reference on record", async () => {
    const { w, a, b, pid } = await reversedLive();
    expect(await itemIds2("?filter=owed_after_reversal")).toEqual([a.id]);
    expect((await get("")).body.data.counts.owed_after_reversal).toBe(1);
    // The other post is still held, live-less: not in the view.
    expect(await itemIds2("?filter=owed_after_reversal")).not.toContain(b.id);
    const req = await post(`/${pid}/require-manual`, { reason: "account_suspended" });
    expect(req.status).toBe(200);
    expect((await payoutOf(a.id)).status).toBe("manual_required");
    expect(await itemIds2("?filter=owed_after_reversal")).toEqual([]);
    expect(await itemIds2("?filter=manual_required")).toEqual([a.id]);
    const paidRes = await post(`/${pid}/mark-manual-paid`, { reference: "NEFT-20261018-77" });
    expect(paidRes.status).toBe(200);
    expect(await payoutOf(a.id)).toMatchObject({ status: "paid_manual", manualReference: "NEFT-20261018-77" });
    expect(await itemIds2("?filter=finished")).toContain(a.id);
    void w;
  });

  it("a reversed payout whose post was refunded or withdrawn is NOT offered for a bank transfer: the client was repaid for it", async () => {
    const { a, pid } = await reversedLive();
    await prisma.campaignBookingItem.update({ where: { id: a.id }, data: { status: "refunded" } });
    expect(await itemIds2("?filter=owed_after_reversal")).toEqual([]);
    const refused = await post(`/${pid}/require-manual`, { reason: "account_suspended" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/\[post_not_live\]/);
    expect((await payoutOf(a.id)).status).toBe("reversed");
  });

  it("a live post the client has ALSO been refunded for (a refund of it is on the ledger) is refused too", async () => {
    const { w, a, pid } = await reversedLive();
    const pay = await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: w.booking.id } });
    await prisma.campaignRefund.create({ data: { idempotencyKey: `rf-item-${a.id}`, paymentId: pay.id, razorpayPaymentId: pay.razorpayPaymentId!, bookingId: w.booking.id, bookingItemId: a.id, amountPaise: a.price, status: "processed", origin: "ours", reason: "item_refunded" } });
    const refused = await post(`/${pid}/require-manual`, { reason: "account_suspended" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/\[post_not_live\]/);
    expect((await payoutOf(a.id)).status).toBe("reversed");
  });

  async function itemIds2(q: string): Promise<string[]> {
    return (await get(q)).body.data.rows.map((r: { bookingItemId: string }) => r.bookingItemId);
  }
});

describe("Reverse on a payout that has no transfer is refused up front: nothing is claimed, nothing is overwritten, nobody is emailed", () => {
  it("a parked payout with no transfer id keeps its real reason, its events and its status", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    const pid = await idOf(c.id);
    await setPayout(c.id, { status: "needs_attention", errorCode: "transfer_unknown_after_retry", razorpayTransferId: null, lastError: "no transfer ever showed up" });
    const before = { events: (await events(pid)).length, calls: fake.calls.length };
    const mails = vi.mocked(notifyAdminByEmail).mock.calls.length;
    const r = await post(`/${pid}/reverse`, {});
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/\[no_transfer\]/);
    const p = await payoutOf(c.id);
    expect(p).toMatchObject({ status: "needs_attention", errorCode: "transfer_unknown_after_retry", lastError: "no transfer ever showed up" });
    expect((await events(pid)).length).toBe(before.events);
    expect(fake.calls.length).toBe(before.calls);
    await flushPayoutAlertsForTests();
    expect(vi.mocked(notifyAdminByEmail).mock.calls.length).toBe(mails);
  });
});

// ── The CSV is a worklist: a failure must never look like a complete file ─────────────────────

describe("⚠️ the CSV never looks complete when it is not", () => {
  const read = (path: string) =>
    get(path).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (d: Buffer) => chunks.push(d));
      r.on("end", () => cb(null, Buffer.concat(chunks).toString("utf8")));
      r.on("aborted", () => cb(new Error("aborted"), ""));
      r.on("error", (e) => cb(e, ""));
    });

  it("a failure in the FIRST batch's names and pages (the decorating queries), after the rows were read, is a clean 500 with nothing of a file in it, not a header-only 200", async () => {
    const w = await paid({ pages: [{}] });
    await setPayout(w.creators[0].id, { status: "manual_required" });
    await prisma.$executeRawUnsafe("ALTER TABLE creators RENAME TO creators_gone");
    let res: request.Response;
    try {
      res = await get(".csv?filter=manual_required");
    } finally {
      await prisma.$executeRawUnsafe("ALTER TABLE creators_gone RENAME TO creators");
    }
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).not.toMatch(/text\/csv/);
    expect(res.text).not.toContain("Payout,Campaign");
  });

  it("a failure AFTER the first bytes went out aborts the connection: the download fails instead of ending as a normal, shorter file", async () => {
    await paid({ pages: [{}] });
    const staffService = await import("../src/services/creator/payout-staff.service");
    const spy = vi.spyOn(staffService, "streamPayoutsCsv").mockImplementation(async (_q, write) => {
      write("\uFEFFPayout,Campaign\r\n");
      write("p1,c1\r\n");
      throw new Error("pool timeout on batch 2");
    });
    try {
      await expect(read(".csv?filter=manual_required")).rejects.toBeTruthy();
    } finally {
      spy.mockRestore();
    }
    // The route is healthy again afterwards.
    expect((await get(".csv?filter=open")).status).toBe(200);
  });
});

// ── After looking in the Razorpay dashboard: the human exits of a transfer nobody can see (re-review round 2, #R1) ──

describe("r2 #R1: attest-no-transfer and adopt-transfer, the two things staff can say after looking in the Razorpay dashboard", () => {
  /** A captured payout whose transfer the kick made, put back into a park with no transfer id recorded and the transfer list unreadable. */
  async function parkedNoId(o: { attempts?: number; errorCode?: string; requestedAgoMin?: number; pages?: number } = {}) {
    const w = await paid({ pages: Array.from({ length: o.pages ?? 1 }, () => ({})) });
    const c = w.creators[0];
    const pid = await idOf(c.id);
    const transferId = (await payoutOf(c.id)).razorpayTransferId!;
    await setPayout(c.id, {
      status: "needs_attention",
      errorCode: o.errorCode ?? "listing_unreadable",
      lastError: "parked",
      razorpayTransferId: null,
      attempts: o.attempts ?? 1,
      transferRequestedAt: new Date(Date.now() - (o.requestedAgoMin ?? 40) * MIN),
      nextAttemptAt: null,
    });
    fake.intercept({ match: is.listTransfers, mode: "reject", status: 500, times: 1000 });
    return { w, c, pid, transferId };
  }

  it("no transfer exists: refused until a person says so; then the attestation (with the staff id) lets the payout be paid by bank transfer and recorded", async () => {
    const { w, c, pid, transferId } = await parkedNoId();
    await verifiedOffer(w, c.id); // a live, verified post: the creator is owed (r2 #R5: only such a post is ever paid by hand)
    fake.transfers.delete(transferId); // there really is none
    const before = await post(`/${pid}/require-manual`, { reason: "Razorpay list unreadable" });
    expect(before.status).toBe(409);
    expect(before.body.error.message).toMatch(/\[listing_unchecked\]/);

    const a = await post(`/${pid}/attest-no-transfer`, { note: "Checked the payment in the dashboard at 10:40: no transfer for this payout" });
    expect(a.status).toBe(200);
    expect(a.body.data.result).toMatchObject({ ok: true, outcome: "attested" });
    expect(a.body.data.result.note).toMatch(/^Recorded: no transfer exists/);
    expect(a.body.data.payout.status).toBe("needs_attention"); // recording a person's word moves nothing
    const att = (await events(pid)).filter((e) => e.kind === "attest_no_transfer");
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({ actorType: "staff", actorId: staff.staffId });

    const required = await post(`/${pid}/require-manual`, { reason: "Razorpay list unreadable" });
    expect(required.status).toBe(200);
    expect(required.body.data.payout.status).toBe("manual_required");
    const paidRes = await post(`/${pid}/mark-manual-paid`, { reference: "UTR778899100" });
    expect(paidRes.status).toBe(200);
    expect(paidRes.body.data.payout.status).toBe("paid_manual");
    expect(fake.calls.filter(is.v1Write)).toHaveLength(1); // only the kick's create: nothing was moved at Razorpay by any of this
  });

  it("⚠️ r2 #R5: the same park on a post that never went live: the payout can be STOPPED (after the attestation), but never recorded as paid by hand", async () => {
    const { c, pid, transferId } = await parkedNoId();
    fake.transfers.delete(transferId);
    expect((await post(`/${pid}/attest-no-transfer`, { note: "Checked the payment in the dashboard: no transfer for this payout" })).status).toBe(200);
    const stopped = await post(`/${pid}/require-manual`, { reason: "no transfer at Razorpay" });
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.payout.status).toBe("manual_required");
    const paidRes = await post(`/${pid}/mark-manual-paid`, { reference: "UTR778899101" });
    expect(paidRes.status).toBe(409);
    expect(paidRes.body.error.message).toMatch(/nothing to pay the creator for.*\[post_not_live\]$/);
    expect(await payoutOf(c.id)).toMatchObject({ status: "manual_required", manualReference: null, manualPaidAt: null });
  });

  it("attest-no-transfer is refused in plain words, recording nothing: a payout that records a transfer, one whose last request was minutes ago, an empty note, no such payout", async () => {
    const w = await paid({ pages: [{}] });
    const heldId = await idOf(w.creators[0].id);
    const held = await post(`/${heldId}/attest-no-transfer`, { note: "x" });
    expect(held.status).toBe(409);
    expect(held.body.error.message).toMatch(/already records a transfer/);
    expect(held.body.error.message).toMatch(/Nothing was changed\. \[transfer_recorded\]$/);

    const { pid } = await parkedNoId({ requestedAgoMin: 2 });
    const soon = await post(`/${pid}/attest-no-transfer`, { note: "x" });
    expect(soon.status).toBe(409);
    expect(soon.body.error.message).toMatch(/less than 10 minutes ago.*\[attest_too_soon\]/);
    expect((await post(`/${pid}/attest-no-transfer`, { note: "" })).status).toBe(400);
    expect((await post(`/${randomUUID()}/attest-no-transfer`, { note: "x" })).status).toBe(404);
    expect(await prisma.creatorPayoutEvent.count({ where: { kind: { startsWith: "attest" } } })).toBe(0);
  });

  it("adopt-transfer: this payout's transfer is read and recorded (held); another payout's, an unknown id, or a malformed one is refused and changes nothing; a repeat is the same answer", async () => {
    const { w, pid, transferId } = await parkedNoId({ pages: 2 });
    const theirs = (await payoutOf(w.creators[1].id)).razorpayTransferId!;
    const calls = fake.calls.length;
    const malformed = await post(`/${pid}/adopt-transfer`, { transferId: "pay_NOTATRANSFER" });
    expect(malformed.status).toBe(400);
    expect(fake.calls.length).toBe(calls); // a 400 asks Razorpay nothing

    const wrong = await post(`/${pid}/adopt-transfer`, { transferId: theirs });
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.message).toMatch(/is not this payout's.*Nothing was changed\. \[transfer_not_ours\]$/);
    const missing = await post(`/${pid}/adopt-transfer`, { transferId: "trf_DOESNOTEXIST1" });
    expect(missing.status).toBe(409);
    expect(missing.body.error.message).toMatch(/\[transfer_not_found\]$/);
    expect(await payoutOf(w.creators[0].id)).toMatchObject({ status: "needs_attention", errorCode: "listing_unreadable", razorpayTransferId: null });

    const ok = await post(`/${pid}/adopt-transfer`, { transferId: ` ${transferId} ` });
    expect(ok.status).toBe(200);
    expect(ok.body.data.result).toMatchObject({ ok: true, outcome: "held" });
    expect(ok.body.data.result.note).toMatch(/confirmed held/);
    expect(ok.body.data.payout.status).toBe("held");
    expect(await payoutOf(w.creators[0].id)).toMatchObject({ status: "held", razorpayTransferId: transferId });
    expect((await events(pid)).some((e) => e.actorType === "staff" && e.actorId === staff.staffId && /Staff found this payout's transfer/.test(e.note ?? ""))).toBe(true);

    const again = await post(`/${pid}/adopt-transfer`, { transferId });
    expect(again.status).toBe(200);
    expect(again.body.data.result).toMatchObject({ ok: true, outcome: "already_adopted" });
  });

  it("a request sent twice: the adopted transfer waits for the check for a second one; while the list stays unreadable a person's 'no other transfer' finishes it as held", async () => {
    const { w, pid, transferId } = await parkedNoId({ attempts: 2, errorCode: "transfer_unknown_after_retry" });
    const adopt = await post(`/${pid}/adopt-transfer`, { transferId });
    expect(adopt.status).toBe(200);
    expect(adopt.body.data.result).toMatchObject({ ok: true, outcome: "audit_pending" });
    expect(adopt.body.data.result.note).toMatch(/sent twice/);
    expect(adopt.body.data.payout.status).toBe("transfer_requested");

    // The worker cannot finish it on its own while the list is unreadable.
    await runCreatorPayoutsTick({ now: new Date(Date.now() + 20 * MIN) });
    expect((await payoutOf(w.creators[0].id)).status).toBe("transfer_requested");

    const att = await post(`/${pid}/attest-no-transfer`, { note: "Only this one transfer carries the payout in the dashboard" });
    expect(att.status).toBe(200);
    expect(att.body.data.result).toMatchObject({ ok: true, outcome: "attested_no_other" });
    expect(att.body.data.result.note).toMatch(/The transfer is confirmed held\.$/);
    expect(att.body.data.payout.status).toBe("held");
    const ev = (await events(pid)).filter((e) => e.kind === "attest_no_other_transfer");
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actorType: "staff", actorId: staff.staffId });
  });
});

describe("r3 #1: adopt-transfer refuses a transfer that an EARLIER request made and that failed: the payout stays parked and the current request's transfer is still the one to adopt", () => {
  it("failed R1, Retry, R2's answer lost, the list unreadable for half an hour: R1's id is refused with plain words and nothing changes; R2's id is adopted", async () => {
    fake.createStatus = "pending"; // R1 is accepted, then fails at Razorpay
    const w = await paid({ pages: [{}] });
    fake.createStatus = "processed";
    const c = w.creators[0];
    const pid = await idOf(c.id);
    const r1 = (await payoutOf(c.id)).razorpayTransferId!;
    expect((await payoutOf(c.id)).status).toBe("transfer_requested");
    fake.failTransfer(r1);
    expect(await confirmHold(pid)).toMatchObject({ status: "failed" });
    expect(await payoutOf(c.id)).toMatchObject({ status: "failed", razorpayTransferId: r1 });

    // A request is named to the second (requestKeyOf): a Retry never comes in the same second as the request whose failure it answers.
    await new Promise((r) => setTimeout(r, 1_100));
    fake.intercept({ match: is.createTransfer, mode: "lose" }); // R2 lands, its answer is lost
    const retry = await post(`/${pid}/retry-transfer`);
    expect(retry.status).toBe(200);
    expect(await payoutOf(c.id)).toMatchObject({ status: "transfer_requested", razorpayTransferId: null, attempts: 1 });
    const r2 = [...fake.transfers.keys()].find((id) => id !== r1)!;
    fake.intercept({ match: is.listTransfers, mode: "reject", status: 500, times: 1000 });
    await resolveUnknownTransfer(pid, { now: new Date(Date.now() + 3 * MIN) });
    expect(await resolveUnknownTransfer(pid, { now: new Date(Date.now() + 35 * MIN) })).toMatchObject({ outcome: "parked", reason: "listing_unreadable" });
    const evBefore = (await events(pid)).length;

    const refused = await post(`/${pid}/adopt-transfer`, { transferId: r1 });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/^Not done: adopt this transfer\. That transfer was made by an earlier request for this payout and has failed or been taken back/);
    expect(refused.body.error.message).toMatch(/Nothing was changed\. \[transfer_from_earlier_request\]$/);
    expect(await payoutOf(c.id)).toMatchObject({ status: "needs_attention", errorCode: "listing_unreadable", razorpayTransferId: null, attempts: 1 });
    expect((await events(pid)).length).toBe(evBefore);

    const ok = await post(`/${pid}/adopt-transfer`, { transferId: r2 });
    expect(ok.status).toBe(200);
    expect(ok.body.data.payout.status).toBe("held");
    expect(await payoutOf(c.id)).toMatchObject({ status: "held", razorpayTransferId: r2 });
  });
});

describe("r2 #R4: a reversal reason is scrubbed BEFORE it is cut to 40 characters", () => {
  it("an account number at the cut never leaves its front digits in the audit trail", async () => {
    const w = await paid({ pages: [{}] });
    const pid = await idOf(w.creators[0].id);
    const r = await post(`/${pid}/reverse`, { reason: `${"x".repeat(34)} 5010.0123.4567.8901` });
    expect(r.status).toBe(200);
    expect(r.body.data.payout.status).toBe("reversed");
    for (const e of await events(pid)) expect(e.note ?? "").not.toMatch(/5010|0123|4567|8901/);
  });
});

describe("⚠️ r2 #R11: a refusal never says 'Nothing was changed' when the step changed the payout: it says what the payout is now", () => {
  async function releasable(pages = 1) {
    const w = await paid({ pages: Array.from({ length: pages }, () => ({})) });
    const c = w.creators[0];
    await verifiedOffer(w, c.id);
    await onCreatorLinkVerified(c.id, { type: "staff", id: staff.staffId });
    return { w, c, id: await idOf(c.id) };
  }

  it("Release now on a refund Razorpay lists and our books lack: 409, and it says every payout of the payment is now paused", async () => {
    const { w, c, id } = await releasable(2);
    const pay = (await payoutOf(c.id)).razorpayPaymentId;
    fake.payments.get(pay)!.refunds.push({ id: "rfnd_P4R11EXTERNAL", amount: 1_000, status: "processed" });
    const res = await post(`/${id}/release-now`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/It is now paused, with every other payout of the same client payment that was still in flight/);
    expect(res.body.error.message).not.toMatch(/Nothing was changed/);
    expect(res.body.error.message).toMatch(/\[refund_at_razorpay\]$/);
    expect(await payoutOf(c.id)).toMatchObject({ status: "held", pausedReason: "external_refund" });
    expect((await payoutOf(w.creators[1].id)).pausedAt).not.toBeNull(); // the sibling of the same payment is paused too, as the sentence says
    expect(fake.count((x) => is.setHold(x, false))).toBe(0);
  });

  it("Reverse that Razorpay refuses after the release: 409 naming the new status (Needs attention), never 'Nothing was changed'", async () => {
    const { c, id } = await releasable();
    expect((await post(`/${id}/release-now`)).status).toBe(200);
    const released = await payoutOf(c.id);
    expect(released.status).toBe("released");
    fake.settleTransfer(released.razorpayTransferId!); // the money reached the bank: Razorpay has nothing to reverse against
    const res = await post(`/${id}/reverse`, { reason: "creator suspended" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Razorpay refused to take the transfer back \(if it had been released, the money may already have settled/);
    expect(res.body.error.message).toMatch(/Its status is now Needs attention: see its history\. \[reversal_refused_after_release\]$/);
    expect(res.body.error.message).not.toMatch(/Nothing was changed|not possible in its current state/);
    expect((await payoutOf(c.id)).status).toBe("needs_attention");
  });

  it("Reverse that Razorpay refuses on a held payout: it is held again AND paused (r3 #6), and the refusal says so (not 'Nothing was changed')", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    const id = await idOf(c.id);
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400 });
    const res = await post(`/${id}/reverse`, { reason: "withdrawn" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Razorpay refused to take the transfer back, so the money is still on hold/);
    expect(res.body.error.message).toMatch(
      /No money moved; it is held again and paused, so it will not be released\. To take it back, press Reverse again once Razorpay allows it; resume it only if the creator should be paid after all \(it is then released when due\): see its history\. \[reversal_refused\]$/,
    );
    expect(res.body.error.message).not.toMatch(/Nothing was changed|held again as it was|settled/);
    expect(await payoutOf(c.id)).toMatchObject({ status: "held", errorCode: "reversal_refused", pausedReason: REVERSE_PAUSE_REASON });
    expect((await payoutOf(c.id)).pausedAt).not.toBeNull();
    expect((await events(id)).some((e) => e.actorType === "staff" && /held again and paused, so it will not be released/.test(e.note ?? ""))).toBe(true);
  });

  it("⚠️ r3 #6: a refused Reverse on a held payout whose release is DUE does not let the release go ahead: it is paused, and the worker releases nothing", async () => {
    const { c, id } = await releasable();
    const due = await payoutOf(c.id);
    expect(due).toMatchObject({ status: "held", pausedAt: null });
    expect(due.releaseAfter!.getTime()).toBeLessThanOrEqual(Date.now()); // the post is verified and its release is due now
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400 });
    const res = await post(`/${id}/reverse`, { reason: "duplicate booking" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/it is held again and paused, so it will not be released.*\[reversal_refused\]$/);
    expect(await payoutOf(c.id)).toMatchObject({ status: "held", pausedReason: REVERSE_PAUSE_REASON });

    // Past the refusal's 5-minute backoff, and again an hour on: the worker's release pass does not release it.
    await runCreatorPayoutsTick({ now: new Date(Date.now() + 10 * MIN) });
    await runCreatorPayoutsTick({ now: new Date(Date.now() + HOUR) });
    expect(await payoutOf(c.id)).toMatchObject({ status: "held", pausedReason: REVERSE_PAUSE_REASON });
    expect(fake.count((x) => is.setHold(x, false))).toBe(0);
    // The queue row says whose pause this is and what Resume does (r4 #2), and offers Reverse again.
    const q = await get("?filter=paused");
    const row = q.body.data.rows.find((x: { id: string }) => x.id === id);
    expect(row).toMatchObject({ status: "held", pausedReason: REVERSE_PAUSE_REASON });
    expect(payoutHint(row)).toMatch(/A person pressed Reverse to take it back and Razorpay refused, so it is paused and won't be released: press Reverse again to take it back, or resume it only if the creator should be paid after all/);
    expect(pausedChip(row)).toMatchObject({ label: "Paused", holds: true, title: expect.stringMatching(/A person pressed Reverse .* Resume releases it when due/) });
    // Resuming is the person's call, and the copy's warning is true: the release then goes through the whole gate again, and passes.
    expect((await post(`/${id}/resume`)).status).toBe(200);
    expect((await payoutOf(c.id)).pausedAt).toBeNull();
    await runCreatorPayoutsTick({ now: new Date(Date.now() + 2 * HOUR) });
    expect(["release_requested", "released"]).toContain((await payoutOf(c.id)).status);
    expect(fake.count((x) => is.setHold(x, false))).toBe(1);
  });

  it("⚠️ r4 #1: a Reverse whose first read fails (5xx) is finished by the WORKER; Razorpay then refuses, and the payout is held AND paused, so no release follows", async () => {
    const { c, id } = await releasable();
    fake.intercept({ match: is.fetchTransfer, mode: "reject", status: 500 });
    const res = await post(`/${id}/reverse`, { reason: "duplicate booking" });
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ ok: false, outcome: "unknown" });
    expect(res.body.data.result.note).toMatch(/finished automatically\. If Razorpay refuses it, the payout goes back to held and stays paused, so it is not released\./);
    // The person's intent is on the row already.
    expect(await payoutOf(c.id)).toMatchObject({ status: "reversal_requested", pausedReason: REVERSE_PAUSE_REASON });
    // The worker reads it back (no actor) and Razorpay refuses the reversal outright.
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400 });
    await runCreatorPayoutsTick({ now: new Date(Date.now() + 3 * MIN) });
    expect(await payoutOf(c.id)).toMatchObject({ status: "held", errorCode: "reversal_refused", pausedReason: REVERSE_PAUSE_REASON });
    expect((await events(id)).some((e) => e.actorType === "system" && e.toStatus === "held" && /held again and paused, so it will not be released/.test(e.note ?? ""))).toBe(true);
    // Past the backoff, and an hour on: nothing is released.
    await runCreatorPayoutsTick({ now: new Date(Date.now() + 10 * MIN) });
    await runCreatorPayoutsTick({ now: new Date(Date.now() + HOUR) });
    expect(await payoutOf(c.id)).toMatchObject({ status: "held", pausedReason: REVERSE_PAUSE_REASON });
    expect(fake.count((x) => is.setHold(x, false))).toBe(0);
  });

  it("⚠️ r5 #1/#3: the same unconfirmed Reverse on a RELEASED payout is not told 'held and stays paused': the note says Needs attention, and the worker's refusal parks it UNPAUSED", async () => {
    const { c, id } = await releasable();
    expect((await post(`/${id}/release-now`)).status).toBe(200);
    expect(await payoutOf(c.id)).toMatchObject({ status: "released", pausedAt: null });
    fake.intercept({ match: is.fetchTransfer, mode: "reject", status: 500 });
    const res = await post(`/${id}/reverse`, { reason: "dispute opened" });
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ ok: false, outcome: "unknown" });
    // The claim pauses a HELD prior only, so nothing paused this one: the note must not promise a pause or a return to held, and must say where
    // a refusal really leaves it and that the released money may still settle.
    expect(res.body.data.result.note).toMatch(
      /finished automatically\. If Razorpay refuses it, the payout is parked as Needs attention for a person and staff are alerted; money already released may still settle to the creator's bank: press Reverse again or check Razorpay\.$/,
    );
    expect(res.body.data.result.note).not.toMatch(/goes back to held|stays paused|so it is not released/);
    expect(await payoutOf(c.id)).toMatchObject({ status: "reversal_requested", pausedAt: null, pausedReason: null });
    // Pressed again while it is in flight (the in-flight branch, prior released): still no pause on the row, so still the same honest note.
    fake.intercept({ match: is.fetchTransfer, mode: "reject", status: 500 });
    const again = await post(`/${id}/reverse`, { reason: "dispute opened" });
    expect(again.status).toBe(200);
    expect(again.body.data.result.note).toMatch(/parked as Needs attention for a person/);
    expect(again.body.data.result.note).not.toMatch(/goes back to held|stays paused/);
    expect(await payoutOf(c.id)).toMatchObject({ status: "reversal_requested", pausedAt: null });
    // The worker finishes it (no actor) and Razorpay refuses: parked for a person, unpaused, exactly as the note said, and staff are emailed.
    vi.mocked(notifyAdminByEmail).mockClear();
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400 });
    await runCreatorPayoutsTick({ now: new Date(Date.now() + 3 * MIN) });
    expect(await payoutOf(c.id)).toMatchObject({ status: "needs_attention", errorCode: "reversal_refused_after_release", pausedAt: null, pausedReason: null });
    expect((await events(id)).some((e) => e.kind === "pause")).toBe(false);
    expect(fake.count((x) => is.setHold(x, true))).toBe(0); // nothing re-held the released transfer: it may still settle, as the note says
    await flushPayoutAlertsForTests();
    expect(vi.mocked(notifyAdminByEmail).mock.calls.map((m) => String(m[0]))).toContain("Creator payout reversal FAILED");
  });

  it("r5 #1: a PARKED payout that still carries the person's pause from an earlier refusal is not told 'back to held' either: a refusal re-parks it", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    const id = await idOf(c.id);
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400 });
    expect((await post(`/${id}/reverse`, { reason: "withdrawn" })).status).toBe(409); // held again, paused by the person's Reverse
    expect(await payoutOf(c.id)).toMatchObject({ status: "held", pausedReason: REVERSE_PAUSE_REASON });
    // A later mismatch parks it (parkMismatch leaves the pause on): the row is needs_attention AND carries the person's pause.
    await setPayout(c.id, { status: "needs_attention", errorCode: "transfer_mismatch", lastError: "parked" });
    fake.intercept({ match: is.fetchTransfer, mode: "reject", status: 500 });
    const res = await post(`/${id}/reverse`, { reason: "withdrawn" });
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ ok: false, outcome: "unknown" });
    expect(await payoutOf(c.id)).toMatchObject({ status: "reversal_requested", pausedReason: REVERSE_PAUSE_REASON });
    // The pause IS on the row, but the prior was not held: a refusal parks it again, so the note must not say it goes back to held.
    expect(res.body.data.result.note).toMatch(/parked as Needs attention for a person/);
    expect(res.body.data.result.note).not.toMatch(/goes back to held/);
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400 });
    await runCreatorPayoutsTick({ now: new Date(Date.now() + 3 * MIN) });
    expect(await payoutOf(c.id)).toMatchObject({ status: "needs_attention", errorCode: "reversal_refused_after_release" });
  });

  it("r3 #6 / r4 #2: a payout paused already keeps its pause's TIME when a Reverse is refused, but the reason becomes the person's, and the refusal says so", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    const id = await idOf(c.id);
    expect((await post(`/${id}/pause`, { reason: "checking" })).status).toBe(200);
    const pausedAt = (await payoutOf(c.id)).pausedAt;
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400 });
    const res = await post(`/${id}/reverse`, { reason: "withdrawn" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(
      /It stays paused, now because a person's Reverse was refused \(it was paused: paused by staff\): press Reverse again to take it back, or resume it only if the creator should be paid after all \(it is then released when due\): see its history\. \[reversal_refused\]$/,
    );
    expect(res.body.error.message).not.toMatch(/Nothing was changed|settled/);
    expect(await payoutOf(c.id)).toMatchObject({ status: "held", pausedReason: REVERSE_PAUSE_REASON, pausedAt });
    // Refused a second time: the pause is already the person's, so nothing about it changed, and the ending says it stays paused.
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400 });
    const again = await post(`/${id}/reverse`, { reason: "withdrawn" });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/the payout stays held and paused, so it will not be released: press Reverse again to take it back, or resume it only if the creator should be paid after all\. \[reversal_refused\]$/);
    expect(await payoutOf(c.id)).toMatchObject({ status: "held", pausedReason: REVERSE_PAUSE_REASON, pausedAt });
  });

  it("⚠️ r3 #5: Reverse on a parked payout (hold put back) that Razorpay refuses: it stays parked under the refusal, and the 409 says so and that staff were alerted, never 'Nothing was changed'", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    const id = await idOf(c.id);
    await setPayout(c.id, { status: "needs_attention", errorCode: "processed_not_held", lastError: "parked" }); // its transfer is still on hold
    vi.mocked(notifyAdminByEmail).mockClear();
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400 });
    const res = await post(`/${id}/reverse`, { reason: "creator suspended" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Razorpay refused to take the transfer back \(if it had been released/);
    expect(res.body.error.message).toMatch(/Its recorded problem is now this refusal, in place of the one it was parked for, and staff are alerted by email: see its history\. \[reversal_refused_after_release\]$/);
    expect(res.body.error.message).not.toMatch(/Nothing was changed|money that was already released/);
    expect(await payoutOf(c.id)).toMatchObject({ status: "needs_attention", errorCode: "reversal_refused_after_release", pausedAt: null });
    await flushPayoutAlertsForTests();
    expect(vi.mocked(notifyAdminByEmail).mock.calls.map((m) => String(m[0]))).toContain("Creator payout reversal FAILED");
  });

  it("Release now that schedules the release first and is then refused (the hold has not run out) says the release is now scheduled", async () => {
    vi.stubEnv("CREATOR_PAYOUT_HOLD_DAYS", "3");
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    await verifiedOffer(w, c.id); // verified, but the follow-up that schedules the release never ran
    expect((await payoutOf(c.id)).releaseAfter).toBeNull();
    const res = await post(`/${await idOf(c.id)}/release-now`);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Its release is now scheduled: see its history\. \[release_not_due\]$/);
    expect((await payoutOf(c.id)).releaseAfter).not.toBeNull();
  });

  it("a refusal that changed nothing still says so", async () => {
    const w = await paid({ pages: [{}] });
    const id = await idOf(w.creators[0].id);
    const before = await prisma.creatorPayout.findUniqueOrThrow({ where: { id }, select: { status: true, pausedAt: true, releaseAfter: true } });
    const res = await post(`/${id}/release-now`); // the campaign is not approved and nothing was posted: refused before anything is written
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Nothing was changed\. \[booking_not_releasable\]$/);
    expect(await prisma.creatorPayout.findUniqueOrThrow({ where: { id }, select: { status: true, pausedAt: true, releaseAfter: true } })).toEqual(before);
  });
});

describe("r2 #R15: the CSV keeps an all-digit bank reference as text, so a spreadsheet cannot turn it into 4.23612E+11", () => {
  it("a 12-digit IMPS/UPI reference is written as =\"…\"; a reference with letters, and every other cell, is unchanged", async () => {
    const w = await paid({ pages: [{}, {}] });
    const [digits, letters] = w.creators;
    await setPayout(digits.id, { status: "paid_manual", manualReference: "423611987654", manualPaidAt: new Date() });
    await setPayout(letters.id, { status: "settled", settledAt: new Date(), settlementUtr: "UTR0000123456" });
    const res = await get(".csv?filter=finished").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (d: Buffer) => chunks.push(d));
      r.on("end", () => cb(null, Buffer.concat(chunks).toString("utf8")));
    });
    expect(res.status).toBe(200);
    const text = res.body as unknown as string;
    expect(text).toContain('"=""423611987654"""');
    const rows = parseCsv(text);
    const col = (name: string) => PAYOUT_CSV_HEADERS.indexOf(name as never);
    const row = (itemId: string) => rows.find((r) => r[3] === itemId)!;
    expect(row(digits.id)[col("Paid: bank transfer reference")]).toBe('="423611987654"');
    expect(row(letters.id)[col("Paid: settlement UTR")]).toBe("UTR0000123456");
    for (const r of rows.slice(1)) expect(r).toHaveLength(PAYOUT_CSV_HEADERS.length);
  });
});
