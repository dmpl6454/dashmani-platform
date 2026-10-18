import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";

// Creator payouts, staff side (Payouts Phase 4 API: apps/api routes/campaign-admin.routes.ts, services/creator/payout-staff.service.ts).
// Admin / Super Admin only on the API. STAFF ONLY: the amounts, Razorpay references and the destination HINT it carries must never
// reach a client or a creator screen. The API builds every row from an allow-list: no PAN, account number or IFSC ever arrives here,
// and nothing in the UI asks for one.

/** The queue's views, exactly the API's `filter` values. */
export type PayoutFilterKey = "needs_attention" | "manual_required" | "paused" | "held_awaiting_verify" | "releasing" | "settlement_pending" | "failed" | "open";

/** What the queue answered about the switches that decide whether money moves (all optional: an older API sends none). */
export interface PayoutSwitches {
  /** false = ALL releases are paused (the runtime switch). The banner reads exactly `=== false`. */
  release?: boolean;
  /** CREATOR_ROUTE_ENABLED: whether NEW transfers to creators' accounts are being made. */
  newTransfers?: boolean;
  /** CREATOR_PAYOUT_CRON_ENABLED: whether the worker runs. */
  worker?: boolean;
}

export interface PayoutLastEvent {
  kind: string;
  toStatus: string | null;
  note: string | null;
  at: string;
}

/** One payout as the queue and the booking page list it. Dates arrive as ISO strings. */
export interface PayoutRow {
  id: string;
  bookingId: string;
  bookingName: string | null;
  bookingItemId: string;
  creatorId: string;
  creatorName: string | null;
  pageName: string | null;
  platform: string | null;
  format: string | null;
  status: string;
  pausedAt: string | null;
  pausedReason: string | null;
  /** What the client paid for this post. */
  itemPricePaise: number;
  /** The creator's share of it, the tax withheld from that share, and what is transferred (gross − tax). */
  grossPaise: number;
  tdsPaise: number;
  amountPaise: number;
  amountReversedPaise: number;
  /** "HDFC ••••1234": a masked reference, frozen when the money was released. null before that. */
  destinationHint: string | null;
  releaseAfter: string | null;
  heldAt: string | null;
  releasedAt: string | null;
  settledAt: string | null;
  reversedAt: string | null;
  errorCode: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastEvent: PayoutLastEvent | null;
}

export interface PayoutQueuePage {
  filter: string;
  rows: PayoutRow[];
  nextCursor: string | null;
  counts?: Partial<Record<PayoutFilterKey, number>>;
  switches?: PayoutSwitches;
}

/** What GET /admin/creator-payouts/:id adds to a row (the Razorpay ids are references, not bank details). */
export interface PayoutDetailFields {
  razorpayPaymentId: string | null;
  razorpayAccountId: string | null;
  razorpayTransferId: string | null;
  transferStatus: string | null;
  settlementStatus: string | null;
  recipientSettlementStatus: string | null;
  recipientSettlementId: string | null;
  settlementUtr: string | null;
  shareBps: number | null;
  tdsBps: number | null;
  nextAttemptAt: string | null;
  lastCheckedAt: string | null;
  onHoldVerifiedAt: string | null;
  transferRequestedAt: string | null;
  releaseRequestedAt: string | null;
  reversalRequestedAt: string | null;
  voidReason: string | null;
  /** Scrubbed by the API. */
  lastError: string | null;
  manualReference: string | null;
  manualPaidAt: string | null;
  manualNote: string | null;
}

export interface PayoutEvent {
  id: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  amountPaise: number | null;
  actorType: string;
  /** Scrubbed by the API: no amounts, ids or bank data. */
  note: string | null;
  createdAt: string;
}

export interface PayoutDetail {
  payout: PayoutRow & Partial<PayoutDetailFields>;
  events: PayoutEvent[];
  item: { status: string; accountName: string | null; platform: string | null; format: string | null; permalink: string | null } | null;
  offer: { status: string; closedReason: string | null; linkSubmittedAt: string | null; linkVerifiedAt: string | null; ownershipCheck: string | null; expiresAt: string | null } | null;
  disputes: Array<{ razorpayDisputeId: string; status: string; amountPaise: number | null; openedAt: string | null; closedAt: string | null }>;
  account: { activationStatus: string; bankChangePending: boolean } | null;
  /** Present on an action's answer: what the engine step said. */
  result?: { ok: boolean; outcome: string; reason?: string; note?: string };
}

export type PayoutActionPath = "pause" | "resume" | "retry-transfer" | "reverse" | "release-now" | "require-manual" | "mark-manual-paid";

const unwrap = <T,>(u: string) => apiFetch<{ data: T }>(u).then((r) => r.data);

export const PAYOUTS_BASE = "/admin/creator-payouts";
const PAGE_SIZE = 50;

function queueUrl(filter: PayoutFilterKey, bookingId: string | null, cursor: string | null, limit = PAGE_SIZE) {
  const q = new URLSearchParams({ filter, limit: String(limit) });
  if (bookingId) q.set("bookingId", bookingId);
  if (cursor) q.set("cursor", cursor);
  return `${PAYOUTS_BASE}?${q.toString()}`;
}

/**
 * The queue, one view, oldest first, with keyset paging (each page's cursor comes from the page before). Every page is
 * re-read together on a refresh, so rows that have moved on do not linger. The first page also carries every view's count and the
 * switches. Re-read every 30 s while the tab is visible: payouts move in the background (the worker runs every few minutes).
 * ⚠️ No keepPreviousData: a new view must never show the previous view's rows under its own heading. `enabled` = false reads nothing
 * (the page waits for the address bar's view and campaign before its first request).
 */
export function usePayoutQueue(filter: PayoutFilterKey, bookingId: string | null, enabled = true) {
  return useSWRInfinite<PayoutQueuePage>(
    (index, prev: PayoutQueuePage | null) => (!enabled ? null : index === 0 ? queueUrl(filter, bookingId, null) : prev?.nextCursor ? queueUrl(filter, bookingId, prev.nextCursor) : null),
    unwrap,
    { refreshInterval: 30_000, revalidateFirstPage: true },
  );
}

/**
 * How many payouts need a person, for the badge on the campaigns page: Needs attention + Manual + Failed (disjoint views, so they add up).
 * One tiny request (limit 1; the counts ride on every answer). It fails quietly and never retries: a badge is a convenience, and the
 * campaigns page must never be slowed or broken by it (no badge is drawn on a failure, nothing is claimed).
 */
export function usePayoutAttentionCount(): number | undefined {
  const { data } = useSWR<PayoutQueuePage>(queueUrl("needs_attention", null, null, 1), unwrap, { refreshInterval: 60_000, revalidateOnFocus: false, shouldRetryOnError: false });
  const c = data?.counts;
  return c ? (c.needs_attention ?? 0) + (c.manual_required ?? 0) + (c.failed ?? 0) : undefined;
}

/** A payout the worker is about to act on or Razorpay is about to answer for: worth re-reading soon. A parked or paused one waits for a person. */
const MOVING = ["planned", "transfer_requested", "release_requested", "released", "reversal_requested"];
export const isMoving = (r: Pick<PayoutRow, "status" | "releaseAfter" | "pausedAt">) =>
  MOVING.includes(r.status) || (r.status === "held" && !!r.releaseAfter && !r.pausedAt);

/**
 * The open payouts of ONE campaign (its creator posts). Only payouts that are not finished are listed by the API (paid out, taken back
 * and void ones are not), so "no row" never means "no payout was ever made": the panel says so. 200 is the API's page maximum and a
 * campaign has a handful of posts. Re-read every 30 s while something is moving.
 */
export function useBookingPayouts(bookingId: string | null) {
  return useSWR<PayoutQueuePage>(bookingId ? queueUrl("open", bookingId, null, 200) : null, unwrap, {
    refreshInterval: (d) => (d?.rows.some(isMoving) ? 30_000 : 0),
  });
}

/** One payout with its history. Loaded only when somebody opens it. */
export function usePayoutDetail(id: string | null) {
  return useSWR<PayoutDetail>(id ? `${PAYOUTS_BASE}/${id}` : null, unwrap, { revalidateOnFocus: false });
}

/** Runs one action on one payout. Resolves with the payout's fresh detail (and `result`); throws an Error carrying the API's sentence when refused. */
export async function runPayoutAction(id: string, action: PayoutActionPath, body?: Record<string, string | undefined>): Promise<PayoutDetail> {
  const clean = body ? Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== "")) : undefined;
  const r = await apiFetch<{ data: PayoutDetail }>(`${PAYOUTS_BASE}/${id}/${action}`, { method: "POST", body: clean && Object.keys(clean).length > 0 ? JSON.stringify(clean) : undefined });
  return r.data;
}

/** Pauses ("off") or resumes ("on") EVERY release, with no restart. */
export async function setReleaseSwitch(mode: "on" | "off"): Promise<"on" | "off"> {
  const r = await apiFetch<{ data: { key: string; release: "on" | "off" } }>(`${PAYOUTS_BASE}/release-switch`, { method: "PUT", body: JSON.stringify({ mode }) });
  return r.data.release;
}

/** The queue's current view as a CSV file (every row of the view, not only the loaded pages). */
export async function downloadPayoutsCsv(filter: PayoutFilterKey, bookingId: string | null): Promise<void> {
  const q = new URLSearchParams({ filter });
  if (bookingId) q.set("bookingId", bookingId);
  const { blob, filename } = await apiFetchBlob(`${PAYOUTS_BASE}.csv?${q.toString()}`);
  downloadBlob(blob, filename ?? `creator-payouts-${filter.replace(/_/g, "-")}.csv`);
}
