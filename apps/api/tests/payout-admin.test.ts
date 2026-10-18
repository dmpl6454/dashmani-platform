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
import { flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { settlePayoutKicksForTests } from "../src/services/campaign/payment.service";
import { settleCreatorRefundsForTests } from "../src/services/creator/creator-refund.service";
import { onCreatorLinkVerified } from "../src/services/creator/payout-ledger";
import { PAYOUT_CSV_HEADERS, PAYOUT_FILTERS } from "../src/services/creator/payout-staff.service";
import { RELEASE_SWITCH_KEY } from "../src/services/creator/payout.service";
import { resetCreatorPayoutsCronForTests, runCreatorPayoutsTick } from "../src/cron/creator-payouts.cron";
import { FakeRazorpay, is } from "./fake-razorpay-route";
import { generateClientToken, generateCreatorToken, generateHrToken, generateToken } from "./helpers";
import { DAY, MIN, callLog, capture, countOf, mkStaff, mkWorld, openOffer, payoutOf, stubPayoutEnv, verifiedOffer, type StaffWorld, type World } from "./payout-fixtures";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const fake = new FakeRazorpay();
let staff: StaffWorld;

beforeEach(async () => {
  // system_settings is not truncated between tests: the release switch must start every test absent (= on).
  await prisma.systemSetting.deleteMany({ where: { key: "creatorPayouts.release" } });
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
    "format", "grossPaise", "heldAt", "id", "itemPricePaise", "lastEvent", "pageName", "pausedAt", "pausedReason", "platform", "releaseAfter", "releasedAt", "reversedAt",
    "settledAt", "status", "tdsPaise", "updatedAt",
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
    expect(row.destinationHint).toBe("HDFC ••••1234");
    const text = JSON.stringify(res.body);
    for (const secret of ["CANARY_RAZORPAY_BODY", "CANARY_NOTE", "CANARY_REF1234", "acc_P4I", "trf_", "pay_P4I", "razorpayAccountId", "razorpayTransferId", "razorpayPaymentId", "account_number", "ifsc", "beneficiary"]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(Object.keys(res.body.data).sort()).toEqual(["counts", "filter", "nextCursor", "rows", "switches"]);
    expect(res.body.data.switches).toEqual({ release: true, newTransfers: true, worker: true });
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
    expect(res.body.data.counts).toEqual({ open: 6, needs_attention: 1, manual_required: 1, paused: 1, held_awaiting_verify: 2, releasing: 1, settlement_pending: 0, failed: 1 });
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
    expect((await get("/release-switch")).body.data).toEqual({ key: RELEASE_SWITCH_KEY, release: "on" });
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

  it("the change is written once per call and the audit of who did it is in the server log (never in a response)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await put("/release-switch", { mode: "off" });
      expect(warn.mock.calls.some((c) => String(c[0]).includes(`releases switched off by staff ${staff.staffId}`))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
