import { prisma, Prisma } from "@dashmani/db";
import type { CampaignDispute, CreatorPayout } from "@dashmani/db";
import { scrubPayoutObject, scrubPayoutSecrets } from "../../utils/payout-scrub";
import { parseRazorpaySettlement } from "./razorpay";
import { PAYOUT_STATUSES, PAUSABLE_STATUSES, mapTransferEvent, type PayoutStatus, type TransferFacts, type TransferMove } from "../creator/payout-states";
import { alertStaffOncePerHour } from "../creator/payout-alert";

// Razorpay Route webhooks: transfers, settlements, linked-account (product) status, and
// payment disputes. Phase 1 of docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md.
//
// ⚠️ THE CONTRACT WITH THE WEBHOOK ENDPOINT (payment.service.ts handleWebhook):
//  • handleRouteEvent NEVER THROWS, and the endpoint answers 2xx whatever happens here: Razorpay
//    disables a webhook that keeps failing for 24 hours [R28], and the same URL marks brand
//    payments paid. An event we cannot read or apply is alerted and, for transfers, settlements
//    and linked-account status, left to the reconciliation job, which reads the real state from
//    Razorpay.
//  • THE ONE EXCEPTION, expressed through the result and not through a throw: a payment.dispute.*
//    event that fails on an INFRASTRUCTURE error (a lost or exhausted database connection, a pool
//    or transaction timeout, a deadlock or lock timeout: isInfraError) returns
//    { handled: false, note: "temporary", retry: true }. The endpoint must then leave the event
//    unprocessed and answer 5xx so Razorpay redelivers it. That is safe because applying a
//    dispute is idempotent (a replay changes nothing twice), and it is necessary because the
//    reconciliation job has no dispute poll: an event consumed during an outage is never
//    repaired. A brief outage is nowhere near Razorpay's 24-hour disable window. Every other
//    failure, and every unreadable payload, stays 2xx: retrying cannot fix those.
//  • `handled` is true when the event was recognised and either applied or deliberately ignored
//    (a duplicate, a stale or out-of-order event: `note` says which), false when it was unreadable,
//    unknown to us, or failed. A replay of an applied event is a no-op, never a second change.
//
// ⚠️ HOW A STATUS CHANGES. Only through one conditional updateMany whose WHERE names the row's
// CURRENT transfer id and every status the move is legal from (payout-states.ts decides both). A
// replayed event, an out-of-order one, an event for a transfer the row no longer points at, and
// two events racing each other therefore all match nothing and change nothing. The status change
// and its creator_payout_events row are written in one transaction, so the audit never disagrees
// with the row.
//
// ⚠️ PAYLOAD SHAPES ARE PARTLY UNVERIFIED (plan question g): Razorpay's Route webhook page shows
// transfer.processed and transfer.failed only as include placeholders, and the dispute event
// names beyond created and lost are unverified [R32]. So every field is read defensively and
// money logic never defaults a missing field: an unreported on_hold is not "false", a missing
// amount is not 0. A payload we cannot rely on is "unreadable": alerted once an hour per event
// name, nothing changed.
//
// ⚠️ NOTHING FROM RAZORPAY IS STORED AS FREE TEXT. Requirement `description`s, dispute reason
// descriptions and the like can echo a PAN or a bank detail back, so they are dropped; the fields
// we keep (requirement references, reason codes, error codes) are bounded and scrubbed. Nothing
// here ever logs a payload.

/** `retry` is set ONLY for a payment.dispute.* event lost to an infrastructure error: see the contract above. */
type Result = { handled: boolean; note?: string; retry?: boolean };

// ── Small readers (every one returns null rather than guessing) ─────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const ID_RE = /^[A-Za-z0-9_]{1,64}$/;
const idOf = (v: unknown): string | null => (typeof v === "string" && ID_RE.test(v) ? v : null);
/** Our own ids (notes.payout_id) are UUIDs, which Razorpay's pay_/trf_/acc_ shape above does not allow. */
const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const noteIdOf = (v: unknown): string | null => (typeof v === "string" && NOTE_ID_RE.test(v) ? v : null);
/** A non-negative whole number (paise, a unix time). Anything else is "not reported". */
const intOf = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const boolOf = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
/** A short code or label: trimmed, scrubbed, bounded. Never free text of unbounded length. */
const wordOf = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? scrubPayoutSecrets(v.trim()).slice(0, max) : null);
/** A bank reference (UTR). Whitelisted by shape, not scrubbed: scrubbing would mask its digits. */
const utrOf = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9_/-]{4,64}$/.test(v.trim()) ? v.trim() : null);

/** JSON with sorted keys: jsonb does not keep key order, so two equal values must compare equal. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

const safeName = (name: string): string => (/^[a-z0-9_.]{1,64}$/.test(name) ? name : "(unrecognised event)");
const inr = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

/** The event's own time (unix seconds), or now when it is missing or implausible. */
function eventTime(evt: unknown): Date {
  const now = new Date();
  const s = isObj(evt) ? evt.created_at : null;
  if (typeof s === "number" && Number.isFinite(s)) {
    const d = new Date(s * 1000);
    if (d.getTime() >= Date.UTC(2020, 0, 1) && d.getTime() <= now.getTime() + 5 * 60 * 1000) return d;
  }
  return now;
}

/** Razorpay's older docs spell it `transfers.failed`; the sample page says `transfer.failed`. */
function normalizeEvent(event: string): string {
  const e = typeof event === "string" ? event.trim().toLowerCase() : "";
  return e.startsWith("transfers.") ? `transfer.${e.slice("transfers.".length)}` : e;
}

const ROUTE_PREFIXES = ["transfer.", "transfers.", "settlement.", "product.route.", "payment.dispute."];

/** Whether an event belongs to this module: transfer.*, settlement.*, product.route.*, payment.dispute.*. */
export function isRouteEvent(event: string): boolean {
  if (typeof event !== "string") return false;
  const e = event.toLowerCase();
  return ROUTE_PREFIXES.some((p) => e.startsWith(p));
}

// ── Infrastructure errors (the only thing that makes a dispute event retry) ────

// P2024 pool timeout, P2028 transaction API error (timeout, closed), P2034 write conflict or deadlock, P2037 too many connections.
const INFRA_PRISMA_CODES: ReadonlySet<string> = new Set(["P2024", "P2028", "P2034", "P2037"]);
// 40001/40P01 serialization failure and deadlock, 55P03 lock timeout, 57014 statement timeout or
// cancel, 57P01-57P03 the server shutting down or not accepting connections, 53300 too many connections.
const INFRA_PG_CODES: ReadonlySet<string> = new Set(["40001", "40P01", "55P03", "57014", "57P01", "57P02", "57P03", "53300"]);

function isInfraCode(code: unknown): boolean {
  if (typeof code !== "string") return false;
  const c = code.trim().toUpperCase();
  // P1xxx: Prisma could not reach, authenticate to or stay connected to the database. 08xxx: a Postgres connection exception.
  return /^P1\d{3}$/.test(c) || /^08[0-9A-Z]{3}$/.test(c) || INFRA_PRISMA_CODES.has(c) || INFRA_PG_CODES.has(c);
}

/**
 * True when an error says the DATABASE (or its pool) was the problem, so the same event would
 * succeed if applied again a moment later: Prisma P1xxx, P2024 (pool timeout), P2028 (transaction
 * timeout or closed), P2034 (write conflict, deadlock), and Postgres 40P01, 55P03, 57014 and
 * their kin. Looks at `code`, at `meta.code` (where Prisma puts the SQLSTATE of a failed raw
 * query, P2010) and down the `cause` chain. Anything else, a constraint violation or a plain
 * bug, would fail the same way every time, so it is NOT infrastructure and is never retried.
 */
function isInfraError(err: unknown, depth = 0): boolean {
  if (!isObj(err)) return false;
  if (isInfraCode(err.code) || isInfraCode(err.errorCode)) return true;
  if (isObj(err.meta) && isInfraCode(err.meta.code)) return true;
  if (err.name === "PrismaClientInitializationError" || err.name === "PrismaClientRustPanicError") return true;
  return depth < 3 && err.cause !== undefined && isInfraError(err.cause, depth + 1);
}

const isDisputeEvent = (name: string): boolean => name.startsWith("payment.dispute.");

/**
 * What staff are told when a dispute event could not be applied. There is NO job that reads
 * disputes back from Razorpay, so nothing repairs a lost one: staff look in the Razorpay dashboard.
 * A pause exists only if it was recorded, and nothing from a failed event is (it is one
 * transaction), so until staff have checked, no release on that payment should be trusted.
 */
function disputeNotAppliedDetails(redelivered: boolean): Array<{ label: string; value: string }> {
  return [
    {
      label: "What happens",
      value: redelivered
        ? "The dispute was NOT recorded and this event paused no payout. Razorpay will deliver it again and the second delivery applies it. If it keeps failing, nothing else will ever repair it."
        : "The dispute was NOT recorded and this event paused no payout. Razorpay will NOT send it again, and nothing else will ever repair it.",
    },
    {
      label: "Do this",
      value: "Open the dispute in the Razorpay dashboard and check it there. A creator payout on that payment is paused only if its pause was recorded, so release none on it until you have.",
    },
  ];
}

/**
 * Applies one Route event. Never throws. `eventId` is the x-razorpay-event-id header, kept on the
 * audit row when the caller passes it (idempotency does not depend on it). `retry: true` (see the
 * contract above) is the one case where the caller must NOT mark the event processed.
 */
export async function handleRouteEvent(event: string, evt: any, eventId?: string): Promise<{ handled: boolean; note?: string; retry?: boolean }> {
  const name = normalizeEvent(event);
  try {
    if (name.startsWith("transfer.")) return await onTransferEvent(name, evt, eventId);
    if (name.startsWith("settlement.")) return await onSettlementEvent(name, evt, eventId);
    if (name.startsWith("product.route.")) return await onProductEvent(name, evt);
    if (isDisputeEvent(name)) return await onDisputeEvent(name, evt, eventId);
    return { handled: false, note: "not a route event" };
  } catch (err) {
    const dispute = isDisputeEvent(name);
    const retry = dispute && isInfraError(err);
    // Scrubbed: a Prisma error can quote the row it failed on. No payload is ever logged.
    const why = scrubPayoutSecrets(String((err as Error)?.message ?? err)).slice(0, 200);
    console.error(`[route-webhook] ${safeName(name)} failed${retry ? " (will be redelivered)" : ""}: ${why}`);
    alertStaffOncePerHour(`error:${safeName(name)}`, `Razorpay Route event failed: ${safeName(name)}`, [
      { label: "Event", value: safeName(name) },
      ...(dispute
        ? disputeNotAppliedDetails(retry)
        : [{ label: "What happens", value: "The event may not have been applied. The reconciliation job reads the real state from Razorpay." }]),
      { label: "Check", value: "The API log has the (scrubbed) error." },
    ]);
    return retry ? { handled: false, note: "temporary", retry: true } : { handled: false, note: "error" };
  }
}

function unreadable(name: string, problem: string): Result {
  alertStaffOncePerHour(`unreadable:${safeName(name)}`, `Razorpay Route event could not be read: ${safeName(name)}`, [
    { label: "Event", value: safeName(name) },
    { label: "Problem", value: problem },
    ...(isDisputeEvent(name) ? disputeNotAppliedDetails(false) : [{ label: "What happens", value: "Nothing was changed. The reconciliation job reads the real state from Razorpay." }]),
  ]);
  return { handled: false, note: "unreadable" };
}

// ── Shared: one status change + its audit row ───────────────────────────────────

type PayoutRow = Pick<CreatorPayout, "id" | "bookingId" | "status" | "amountPaise" | "razorpayAccountId" | "razorpayPaymentId">;

const REASON_TEXT: Record<string, string> = {
  processed_not_held: "Razorpay shows the transfer processed but NOT on hold. Check it in Razorpay before anything is released.",
  processed_hold_expires: "Razorpay shows an automatic release date on the transfer. It must stay held until we release it.",
  reversed_outside_flow: "The transfer was reversed outside our release flow. Check Razorpay before refunding or paying.",
  partially_reversed: "The transfer was partly reversed. Check Razorpay before anything else happens to it.",
  transfer_mismatch: "Razorpay's transfer does not match this payout. Check it in Razorpay.",
};

/**
 * `to` is applied only to a row still in one of `from` (and still matching `where`); the audit
 * row is written in the same transaction. Returns false when the row had already moved: a
 * duplicate, a stale event, or a lost race, all of which are correct no-ops.
 */
async function applyMove(a: {
  row: PayoutRow;
  to: PayoutStatus;
  from: readonly PayoutStatus[];
  where: Prisma.CreatorPayoutWhereInput;
  data: Prisma.CreatorPayoutUpdateManyMutationInput;
  kind: "transfer" | "settlement";
  note: string;
  eventId?: string;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const r = await tx.creatorPayout.updateMany({
      where: { ...a.where, id: a.row.id, status: { in: [...a.from] } },
      data: { ...a.data, status: a.to },
    });
    if (r.count !== 1) return false;
    await tx.creatorPayoutEvent.create({
      data: {
        payoutId: a.row.id,
        bookingId: a.row.bookingId,
        kind: a.kind,
        fromStatus: a.row.status,
        toStatus: a.to,
        amountPaise: a.row.amountPaise,
        actorType: "razorpay",
        razorpayEventId: a.eventId ? a.eventId.slice(0, 100) : null,
        note: scrubPayoutSecrets(a.note).slice(0, 500),
      },
    });
    return true;
  });
}

const ALERT_STATUSES: ReadonlySet<string> = new Set(["failed", "settlement_failed", "needs_attention"]);

/**
 * Tells staff about a payout that just landed somewhere that needs a human. One email per event
 * name and resulting status per hour (a Razorpay balance that runs dry fails every transfer at
 * once). The row is stamped alerted_status / alerted_at ONLY after the mailer reports the email
 * went out (`onSent`): not when it was held back by the hourly limit, and not when SMTP is
 * unconfigured or the send failed (sendEmail swallows both and resolves null). So the
 * reconciliation job's digest still covers every payout whose email did not actually go out. The
 * stamp is written after this returns (the webhook does not wait for SMTP), and a lost one only
 * means the digest mentions the row again.
 */
function alertPayout(row: PayoutRow, to: PayoutStatus, reason: string, eventName: string, extra: Array<{ label: string; value: string }> = []): void {
  const subject =
    to === "failed"
      ? "Creator payout transfer FAILED"
      : to === "settlement_failed"
        ? "Creator payout settlement FAILED (the bank rejected it)"
        : `Creator payout needs attention: ${reason}`;
  alertStaffOncePerHour(
    `payout:${safeName(eventName)}:${to}`,
    subject,
    [
      { label: "Status", value: to },
      { label: "Reason", value: reason },
      { label: "Amount", value: inr(row.amountPaise) },
      { label: "Payout", value: row.id },
      { label: "Booking", value: row.bookingId },
      { label: "Razorpay event", value: safeName(eventName) },
      ...extra,
    ],
    `/campaigns/${row.bookingId}`,
    {
      onSent: async () => {
        await prisma.creatorPayout.updateMany({ where: { id: row.id, status: to }, data: { alertedStatus: to, alertedAt: new Date() } });
      },
    },
  );
}

// ── transfer.* ──────────────────────────────────────────────────────────────────

interface TransferRead {
  id: string;
  recipient: string | null;
  source: string | null;
  /** notes.payout_id: ours, written at creation, read back to recognise our own transfers. */
  payoutNote: string | null;
  facts: TransferFacts;
  fees: number | null;
  tax: number | null;
  error: { code: string | null; reason: string | null; description: string | null } | null;
}

/**
 * Reads the transfer entity of a transfer.processed / transfer.failed event. Null when it is
 * missing, has no usable id, or contradicts the event it arrived in (a transfer.failed event
 * whose entity says processed is not something to act on).
 */
function readTransfer(entity: unknown, name: string): TransferRead | null {
  if (!isObj(entity)) return null;
  const id = idOf(entity.id);
  if (!id) return null;
  const implied = name === "transfer.processed" ? "processed" : "failed";
  const own = (wordOf(entity.status, 24) ?? wordOf(entity.transfer_status, 24))?.toLowerCase() ?? null;
  if (own !== null && own !== implied) return null;
  let error: TransferRead["error"] = null;
  if (isObj(entity.error)) {
    const code = wordOf(entity.error.code, 80);
    const reason = wordOf(entity.error.reason, 80);
    const description = wordOf(entity.error.description, 300);
    if (code || reason || description) error = { code, reason, description };
  }
  return {
    id,
    recipient: idOf(entity.recipient),
    source: idOf(entity.source),
    payoutNote: isObj(entity.notes) ? noteIdOf(entity.notes.payout_id) : null,
    facts: {
      status: implied,
      onHold: boolOf(entity.on_hold),
      onHoldUntil: intOf(entity.on_hold_until),
      amount: intOf(entity.amount),
      amountReversed: intOf(entity.amount_reversed),
      settlementStatus: wordOf(entity.settlement_status, 24),
      recipientSettlementStatus: null, // a transfer event never drives a settlement move
    },
    fees: intOf(entity.fees),
    tax: intOf(entity.tax),
    error,
  };
}

/** What differs between the event's transfer and the payout it points at, if anything. */
function mismatchOf(row: PayoutRow, read: TransferRead): string | null {
  if (read.recipient && read.recipient !== row.razorpayAccountId) return "recipient";
  if (read.source && read.source !== row.razorpayPaymentId) return "payment";
  if (read.payoutNote && read.payoutNote !== row.id) return "payout note";
  if (read.facts.amount !== null && read.facts.amount !== row.amountPaise) return "amount";
  return null;
}

function transferData(move: TransferMove, read: TransferRead): Prisma.CreatorPayoutUpdateManyMutationInput {
  const f = read.facts;
  const data: Prisma.CreatorPayoutUpdateManyMutationInput = {};
  if (f.status) data.transferStatus = f.status;
  if (f.settlementStatus) data.settlementStatus = f.settlementStatus;
  if (move.to === "held") {
    // The event is Razorpay reporting, not a FRESH fetch, so on_hold_verified_at stays untouched:
    // release does its own fresh fetch, and the daily re-read of held rows stamps it.
    data.heldAt = new Date();
    data.errorCode = null;
    data.lastError = null;
    if (read.fees !== null) data.transferFeesPaise = read.fees;
    if (read.tax !== null) data.transferTaxPaise = read.tax;
  } else if (move.to === "failed") {
    // Razorpay's error text is scrubbed (it can quote a value we sent); the code is what staff filter on.
    data.errorCode = read.error?.reason ?? read.error?.code ?? "transfer_failed";
    data.lastError = (read.error?.description ?? "Razorpay reported the transfer failed.").slice(0, 500);
  } else {
    data.errorCode = move.reason;
    data.lastError = REASON_TEXT[move.reason] ?? "Razorpay's facts need a human look.";
  }
  return data;
}

async function onTransferEvent(name: string, evt: any, eventId?: string): Promise<Result> {
  if (name !== "transfer.processed" && name !== "transfer.failed") return { handled: false, note: `unhandled ${safeName(name)}` };
  const read = readTransfer(evt?.payload?.transfer?.entity, name);
  if (!read) return unreadable(name, "the transfer in the event is missing, has no id, or contradicts the event name");
  // "Held" is only ever claimed from a reported on_hold:true, so an event without it cannot be used.
  if (name === "transfer.processed" && read.facts.onHold === null) return unreadable(name, "the event does not say whether the transfer is on hold");

  // The row is found by the event's transfer id, i.e. only a payout whose CURRENT transfer id this
  // is. A transfer we do not know (another product on the merchant account, or one we have already
  // replaced and reversed) matches nothing, and that is silent by design.
  const row = await prisma.creatorPayout.findUnique({
    where: { razorpayTransferId: read.id },
    select: { id: true, bookingId: true, status: true, amountPaise: true, razorpayAccountId: true, razorpayPaymentId: true },
  });
  if (!row) return { handled: false, note: "no payout for this transfer" };

  // A transfer id that matches but whose recipient, payment, note or amount does not is not
  // something to confirm. Park a payout that is still waiting on it; otherwise just tell staff.
  const bad = mismatchOf(row, read);
  if (bad) {
    const move: TransferMove = { to: "needs_attention", reason: "transfer_mismatch", alert: true };
    const applied =
      row.status === "transfer_requested" &&
      (await applyMove({
        row,
        to: "needs_attention",
        from: ["transfer_requested"],
        where: { razorpayTransferId: read.id },
        data: transferData(move, read),
        kind: "transfer",
        note: `${name}: transfer_mismatch (${bad})`,
        eventId,
      }));
    alertPayout(row, "needs_attention", "transfer_mismatch", name, [{ label: "Differs", value: bad }]);
    return { handled: applied, note: "transfer_mismatch" };
  }

  const move = mapTransferEvent(row.status, read.facts);
  if (!move.to) return { handled: true, note: move.reason };
  // "Legal from" is every status the SAME facts would move to the SAME target, so the WHERE of
  // the update and the decision above can never disagree, even if the row moved after the read.
  const from = PAYOUT_STATUSES.filter((s) => mapTransferEvent(s, read.facts).to === move.to);
  const applied = await applyMove({
    row,
    to: move.to,
    from,
    where: { razorpayTransferId: read.id },
    data: transferData(move, read),
    kind: "transfer",
    note: `${name}: ${move.reason}`,
    eventId,
  });
  if (!applied) return { handled: true, note: "stale" };
  if (move.alert || ALERT_STATUSES.has(move.to)) {
    alertPayout(row, move.to, move.reason, name, read.error?.code ? [{ label: "Razorpay code", value: read.error.code }] : []);
  }
  return { handled: true, note: move.reason };
}

// ── settlement.processed ────────────────────────────────────────────────────────

/**
 * A settlement carries NO transfer id in its payload [R22], and this event also fires for the
 * merchant's own ordinary payment settlements, which have nothing to do with creators. So a
 * settlement is matched ONLY to payouts that already carry its id (recipient_settlement_id,
 * which the reconciliation job writes as soon as Razorpay shows it on the transfer); anything
 * else is silently not ours. A settlement the job has not linked yet is not lost: the job reads
 * the settlement from the transfer itself.
 */
async function onSettlementEvent(name: string, evt: any, eventId?: string): Promise<Result> {
  if (name !== "settlement.processed") return { handled: false, note: `unhandled ${safeName(name)}` };
  const s = parseRazorpaySettlement(evt?.payload?.settlement?.entity);
  if (!s || !idOf(s.id)) return unreadable(name, "the settlement in the event is missing or has no id");
  if (s.status !== null && s.status.toLowerCase() !== "processed") return { handled: true, note: "settlement_not_processed" };

  const rows = await prisma.creatorPayout.findMany({
    where: { recipientSettlementId: s.id },
    select: { id: true, bookingId: true, status: true, amountPaise: true, razorpayAccountId: true, razorpayPaymentId: true },
  });
  if (rows.length === 0) return { handled: false, note: "settlement not linked to a payout" };

  // "Paid" is shown only with the bank's UTR [R21]; without one there is nothing to record yet.
  const utr = utrOf(s.utr);
  if (!utr) return unreadable(name, "the settlement has no usable bank reference (UTR)");

  const facts: TransferFacts = {
    status: null,
    onHold: null,
    onHoldUntil: null,
    amount: null,
    amountReversed: null,
    settlementStatus: null,
    recipientSettlementStatus: "processed",
  };
  const settledAt = eventTime(evt);
  let settled = 0;
  let lastReason = "unchanged";
  for (const row of rows) {
    const move = mapTransferEvent(row.status, facts);
    if (!move.to) {
      lastReason = move.reason;
      continue;
    }
    const from = PAYOUT_STATUSES.filter((st) => mapTransferEvent(st, facts).to === move.to);
    const applied = await applyMove({
      row,
      to: move.to,
      from,
      where: { recipientSettlementId: s.id },
      // The UTR, the settlement id and the time, and nothing else: s.amount is the whole bank
      // settlement, which can batch several transfers, so it is not this payout's amount. The
      // two error fields are cleared because a retried settlement leaves them describing a failure
      // that no longer applies.
      data: { recipientSettlementStatus: "processed", recipientSettlementId: s.id, settlementUtr: utr, settledAt, errorCode: null, lastError: null },
      kind: "settlement",
      note: `${name}: ${move.reason}`,
      eventId,
    });
    if (applied) settled++;
    else lastReason = "stale";
  }
  return { handled: true, note: settled > 0 ? `settled ${settled}` : lastReason };
}

// ── product.route.* (the linked account's status) ───────────────────────────────

const PRODUCT_TARGET: Record<string, string> = {
  "product.route.under_review": "under_review",
  "product.route.needs_clarification": "needs_clarification",
  "product.route.activated": "activated",
};
const DAY_MS = 24 * 60 * 60 * 1000;

/** requirements[] reduced to references and reason codes. `description` and `resolution_url` are dropped. */
function readRequirements(data: unknown): Array<{ field_reference: string; reason_code: string | null; status: string | null }> {
  const list = Array.isArray(data) ? data : isObj(data) && Array.isArray(data.requirements) ? data.requirements : [];
  const out: Array<{ field_reference: string; reason_code: string | null; status: string | null }> = [];
  for (const r of list) {
    if (!isObj(r)) continue;
    const field = wordOf(r.field_reference, 120);
    if (!field) continue;
    out.push({ field_reference: field, reason_code: wordOf(r.reason_code, 60), status: wordOf(r.status, 24) });
    if (out.length >= 30) break;
  }
  return out;
}

async function onProductEvent(name: string, evt: any): Promise<Result> {
  const target = PRODUCT_TARGET[name];
  if (!target) return { handled: false, note: `unhandled ${safeName(name)}` };
  const mp = evt?.payload?.merchant_product;
  const entity = isObj(mp) ? mp.entity : null;
  if (!isObj(entity)) return unreadable(name, "the product in the event is missing");
  // The linked account is the product's merchant_id (the sample's top-level account_id is the same).
  const accountId = idOf(entity.merchant_id) ?? idOf(evt?.account_id);
  if (!accountId) return unreadable(name, "the event names no linked account");
  const own = wordOf(entity.activation_status, 24)?.toLowerCase() ?? null;
  if (own !== null && own !== target) return unreadable(name, "the product status contradicts the event name");

  const row = await prisma.creatorPayoutAccount.findUnique({ where: { razorpayAccountId: accountId } });
  if (!row) return { handled: false, note: "unknown linked account" };
  const productId = idOf(entity.id);
  if (row.razorpayProductId && productId && row.razorpayProductId !== productId) return { handled: false, note: "foreign product" };

  // References and reason codes only, scrubbed as an object as well, so even a hostile or
  // surprising value cannot put a PAN- or account-number-shaped string into this column.
  const requirements = scrubPayoutObject(readRequirements(isObj(mp) ? mp.data : null)) as Prisma.InputJsonValue;
  const at = eventTime(evt);
  const activatedAt = target === "activated" ? (row.activatedAt ?? at) : undefined;
  const bookableAfter = target === "activated" ? (row.bookableAfter ?? new Date((row.activatedAt ?? at).getTime() + DAY_MS)) : undefined;

  const unchanged =
    row.activationStatus === target &&
    stableJson(row.requirements) === stableJson(requirements) &&
    (target !== "activated" || (row.activatedAt !== null && row.bookableAfter !== null));
  if (unchanged) return { handled: true, note: "unchanged" };

  // last_checked_at doubles as the freshness mark: the activation poll writes it, and an event
  // older than the poll that already ran must not undo what the poll saw.
  const r = await prisma.creatorPayoutAccount.updateMany({
    where: { id: row.id, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: at } }] },
    data: {
      activationStatus: target,
      requirements,
      lastCheckedAt: at,
      ...(target === "activated" ? { activatedAt, bookableAfter, lastError: null } : {}),
    },
  });
  return { handled: true, note: r.count === 1 ? `account ${target}` : "stale" };
}

// ── payment.dispute.* ───────────────────────────────────────────────────────────

// TODO(Phase 4, BEFORE creatorPayouts.release is switched on): the release gate ("the payment has
// no open dispute") must NOT trust campaign_disputes alone. This webhook is the only writer of
// that table and nothing polls Razorpay for disputes, so a dispute event that was lost, delayed,
// or never subscribed leaves no row at all. The gate must ask Razorpay for the payment's disputes
// in the same fresh-fetch step that re-reads the transfer, and refuse the release on any dispute
// not known to be won ("lost" and "closed" must block too: a payment whose "created" event was
// missed can first be seen already closed, which this handler stores as not open and never pauses).
// Until then nothing here may be described as "reconciled".

const DISPUTE_CLOSED: ReadonlySet<string> = new Set(["won", "lost", "closed"]);
const DISPUTE_KNOWN: ReadonlySet<string> = new Set(["open", "under_review", "action_required", "won", "lost", "closed"]);
/** The payout states where the transfer's hold is already lifted (or being lifted): a pause on them is only an overlay. */
const HOLD_LIFTED: ReadonlySet<string> = new Set(["release_requested", "released", "settlement_failed"]);

/**
 * The dispute's status: the entity's own when Razorpay gives one, else what the event name says.
 * Anything unrecognised is read as OPEN: the safe side, because an open dispute only pauses
 * payouts (cheap and reversible by staff) while a missed one lets money leave.
 */
function disputeStatusOf(name: string, entityStatus: unknown): string {
  const s = wordOf(entityStatus, 24)?.toLowerCase() ?? null;
  if (s && DISPUTE_KNOWN.has(s)) return s;
  const suffix = name.slice("payment.dispute.".length);
  if (DISPUTE_CLOSED.has(suffix) || suffix === "under_review" || suffix === "action_required") return suffix;
  return "open";
}

/**
 * Which status stands once an event arrives. A closed dispute is not reopened by a LATE event: it
 * reopens only when the event is strictly newer than the closure (an escalation to a new
 * phase), and the first verdict (won or lost) outranks a generic "closed".
 */
function mergeDisputeStatus(existing: { status: string; closedAt: Date | null } | null, incoming: string, at: Date): string {
  if (!existing) return incoming;
  const wasClosed = DISPUTE_CLOSED.has(existing.status);
  const isClosed = DISPUTE_CLOSED.has(incoming);
  if (!wasClosed) return incoming;
  if (!isClosed) return !existing.closedAt || at.getTime() > existing.closedAt.getTime() ? incoming : existing.status;
  return existing.status === "closed" ? incoming : existing.status;
}

type PausedRow = { id: string; status: string };

/**
 * Pauses every payout of the payment that still has something in flight, INSIDE the caller's
 * transaction (the dispute row is already written by then, so a dispute row always implies its
 * pauses). Un-pausing is NEVER automatic: a won dispute still needs a staff action. A payout
 * already paused for another reason keeps that reason: the single reason column cannot hold two.
 *
 * The rows are locked first, in id order (so two disputes on one payment cannot deadlock each
 * other, and a transfer event cannot move a row between our read and our write), and the audit
 * row names the status the pause really sat on. One statement pauses them all, one inserts the
 * audit rows: a failure anywhere rolls the whole event back.
 */
async function pausePayouts(tx: Prisma.TransactionClient, paymentId: string, name: string, eventId?: string): Promise<PausedRow[]> {
  const rows = await tx.$queryRaw<Array<{ id: string; booking_id: string; status: string; amount_paise: number }>>`
    SELECT id, booking_id, status, amount_paise FROM creator_payouts
    WHERE razorpay_payment_id = ${paymentId} AND paused_at IS NULL AND status = ANY(${[...PAUSABLE_STATUSES]})
    ORDER BY id
    FOR UPDATE`;
  if (rows.length === 0) return [];
  await tx.creatorPayout.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, pausedAt: null, status: { in: [...PAUSABLE_STATUSES] } },
    data: { pausedAt: new Date(), pausedReason: "dispute" },
  });
  await tx.creatorPayoutEvent.createMany({
    data: rows.map((r) => ({
      payoutId: r.id,
      bookingId: r.booking_id,
      kind: "pause",
      fromStatus: r.status,
      toStatus: r.status,
      amountPaise: r.amount_paise,
      actorType: "razorpay",
      razorpayEventId: eventId ? eventId.slice(0, 100) : null,
      note: `${name}: paused while the dispute is open; staff must resume it`,
    })),
  });
  return rows.map((r) => ({ id: r.id, status: r.status }));
}

type DisputeFields = Omit<Prisma.CampaignDisputeUncheckedCreateInput, "id" | "razorpayDisputeId" | "createdAt" | "updatedAt">;

function disputeChanged(existing: CampaignDispute, f: DisputeFields): boolean {
  return (
    existing.status !== f.status ||
    existing.phase !== f.phase ||
    existing.reasonCode !== f.reasonCode ||
    existing.amountPaise !== f.amountPaise ||
    existing.lastEvent !== f.lastEvent ||
    (existing.respondBy?.getTime() ?? null) !== ((f.respondBy as Date | null)?.getTime() ?? null) ||
    (existing.closedAt?.getTime() ?? null) !== ((f.closedAt as Date | null)?.getTime() ?? null)
  );
}

/**
 * ONE transaction: the dispute row first, then the pauses it implies. So a dispute that is
 * recorded is a dispute whose payouts were paused, and a failure at any step records nothing and
 * pauses nothing. The error then propagates: handleRouteEvent reports a database error as
 * { retry: true } so Razorpay redelivers, and the redelivery applies the whole event (it is
 * idempotent: a second application finds the row and the pauses already there and changes nothing).
 *
 * Two copies of an event racing each other are serialised on the dispute row: the insert is
 * ON CONFLICT DO NOTHING (a plain create that lost the race would abort the whole transaction),
 * and the loser then locks the row, re-reads the winner's committed state and merges onto it.
 */
async function onDisputeEvent(name: string, evt: any, eventId?: string): Promise<Result> {
  const d = evt?.payload?.dispute?.entity;
  if (!isObj(d)) return unreadable(name, "the dispute in the event is missing");
  const disputeId = idOf(d.id);
  const paymentId = idOf(d.payment_id) ?? idOf(evt?.payload?.payment?.entity?.id);
  if (!disputeId || !paymentId) return unreadable(name, "the dispute has no usable id or payment");

  // Only disputes on payments we took for bookings. The merchant account may carry other business.
  const [pay, anyPayout] = await Promise.all([
    prisma.campaignPayment.findFirst({ where: { razorpayPaymentId: paymentId }, select: { bookingId: true } }),
    prisma.creatorPayout.findFirst({ where: { razorpayPaymentId: paymentId }, select: { bookingId: true } }),
  ]);
  if (!pay && !anyPayout) return { handled: false, note: "dispute on a payment we do not know" };

  const at = eventTime(evt);
  const incoming = disputeStatusOf(name, d.status);
  const amount = intOf(d.amount);
  const respondBy = intOf(d.respond_by);
  const opened = intOf(d.created_at);

  /** What the row should hold once this event is applied on top of `existing` (null = a new dispute). */
  const fieldsOver = (existing: CampaignDispute | null): DisputeFields => {
    const status = mergeDisputeStatus(existing, incoming, at);
    const open = !DISPUTE_CLOSED.has(status);
    return {
      razorpayPaymentId: paymentId,
      bookingId: pay?.bookingId ?? anyPayout?.bookingId ?? existing?.bookingId ?? null,
      amountPaise: amount ?? existing?.amountPaise ?? 0, // the column is NOT NULL; 0 is only ever "unreadable", and staff are told
      currency: (wordOf(d.currency, 3) ?? existing?.currency ?? "INR").toUpperCase(),
      status,
      phase: wordOf(d.phase, 24) ?? existing?.phase ?? null,
      reasonCode: wordOf(d.reason_code, 60) ?? existing?.reasonCode ?? null,
      respondBy: respondBy !== null ? new Date(respondBy * 1000) : (existing?.respondBy ?? null),
      openedAt: existing?.openedAt ?? (opened !== null ? new Date(opened * 1000) : name === "payment.dispute.created" ? at : null),
      closedAt: open ? null : (existing?.closedAt ?? at),
      lastEvent: safeName(name).slice(0, 64),
    };
  };

  const out = await prisma.$transaction(async (tx) => {
    // 1. The dispute row, first.
    let fields = fieldsOver(null);
    const created = (await tx.campaignDispute.createMany({ data: [{ razorpayDisputeId: disputeId, ...fields }], skipDuplicates: true })).count === 1;
    let existing: CampaignDispute | null = null;
    let changed = created;
    if (!created) {
      await tx.$queryRaw`SELECT id FROM campaign_disputes WHERE razorpay_dispute_id = ${disputeId} FOR UPDATE`;
      existing = await tx.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: disputeId } });
      fields = fieldsOver(existing);
      changed = disputeChanged(existing, fields);
      if (changed) await tx.campaignDispute.update({ where: { razorpayDisputeId: disputeId }, data: fields });
    }
    // 2. The pauses it implies. Only an open dispute pauses; a closed one never un-pauses.
    const paused = DISPUTE_CLOSED.has(fields.status) ? [] : await pausePayouts(tx, paymentId, name, eventId);
    return { created, existing, fields, changed, paused };
  });

  // Told only once it is committed (never about a state that was rolled back).
  const { created, existing, fields, changed, paused } = out;
  if (created || existing?.status !== fields.status || paused.length > 0) {
    alertDispute({ disputeId, paymentId, bookingId: fields.bookingId ?? null, status: fields.status, amount, paused });
  }
  return { handled: true, note: created ? "dispute recorded" : changed || paused.length > 0 ? "dispute updated" : "unchanged" };
}

/**
 * One email per DISPUTE and status per hour (not per event name: a second, different dispute is
 * new information). The text says only what the pause did. A pause on a payout whose transfer
 * is already released or being released is an overlay: the hold is lifted, so the money can still
 * reach the creator's bank, and staff are told which payouts those are.
 *
 * ⚠️ There is no durable "staff were told" marker for a dispute: campaign_disputes has no
 * alerted_* columns (creator_payouts does, but a dispute is per payment and may have no payout
 * rows). So a dispute alert whose email failed, or a restart between the commit and the email,
 * is not retried by a replay. A Phase 4 digest of open and recently closed disputes read from
 * campaign_disputes (a tiny set) covers it; adding alerted_status / alerted_at to
 * campaign_disputes is an additive change for that phase's own DDL cycle.
 */
function alertDispute(a: { disputeId: string; paymentId: string; bookingId: string | null; status: string; amount: number | null; paused: PausedRow[] }): void {
  const open = !DISPUTE_CLOSED.has(a.status);
  const lifted = a.paused.filter((p) => HOLD_LIFTED.has(p.status)).length;
  alertStaffOncePerHour(
    `dispute:${a.disputeId}:${a.status}`,
    open ? "Payment dispute opened on a creator booking" : `Payment dispute ${a.status}`,
    [
      { label: "Dispute", value: a.disputeId },
      { label: "Payment", value: a.paymentId },
      { label: "Status", value: a.status },
      { label: "Amount", value: a.amount !== null ? inr(a.amount) : "not reported: check Razorpay" },
      { label: "Newly paused by this event", value: String(a.paused.length) },
      ...(lifted > 0
        ? [
            {
              label: "Already released or releasing",
              value: `${lifted} of them. A pause does not stop a transfer whose hold is already lifted: it can still settle to the creator's bank. Check each one in Razorpay.`,
            },
          ]
        : []),
      {
        label: "What happens",
        value: open
          ? "Payouts on this payment that were still in flight are paused, and no release will run on a paused payout. A payout already paused for another reason keeps that reason. Paused payouts are resumed by hand."
          : a.status === "lost"
            ? "A lost dispute is debited from our balance. This event paused nothing, and any pause already recorded stays until staff resume it. Check the creator payouts of this payment in Razorpay before releasing any."
            : "This event paused nothing. Any pause already recorded stays until staff resume it.",
      },
    ],
    a.bookingId ? `/campaigns/${a.bookingId}` : "/campaigns",
  );
}
