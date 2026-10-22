import useSWR from "swr";
import useSWRInfinite from "swr/infinite";
import { ApiRequestError, ApiUnreadableError, apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";
import { attentionCount, classifyActionFailure, type ActionFailureInput, type PayoutDetailFields, type PayoutEvent, type PayoutFilterKey, type PayoutRow, type PayoutSummary, type PayoutSwitches, type ReleaseSwitchState } from "@dashmani/shared/src/payouts/staff-ui";

// Creator payouts, staff side (Payouts Phase 4 API: apps/api routes/campaign-admin.routes.ts, services/creator/payout-staff.service.ts).
// Admin / Super Admin only on the API. STAFF ONLY: the amounts, Razorpay references and the destination HINT it carries must never
// reach a client or a creator screen. The API builds every row from an allow-list: no PAN, account number or IFSC ever arrives here,
// and nothing in the UI asks for one.
//
// The JSON shapes live in packages/shared/src/payouts/staff-ui.ts, next to the pure display logic that reads them (and its test).

export type { PayoutDetailFields, PayoutEvent, PayoutFilterKey, PayoutRow, PayoutSummary, PayoutSwitches, ReleaseSwitchState };
export type { PayoutLastEvent } from "@dashmani/shared/src/payouts/staff-ui";

export interface PayoutQueuePage {
  filter: string;
  rows: PayoutRow[];
  nextCursor: string | null;
  counts?: Partial<Record<PayoutFilterKey, number>>;
  switches?: PayoutSwitches;
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
 * The queue, one view, with keyset paging (each page's cursor comes from the page before). Every page is re-read together on a refresh,
 * so rows that have moved on do not linger. The first page also carries every view's COMPANY-WIDE count and the switches, which is why a
 * single campaign's queue does not use this: it reads that campaign's payouts (useBookingPayouts) and counts them itself. Re-read every
 * 30 s while the tab is visible: payouts move in the background (the worker runs every few minutes).
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
 * How many payouts need a person, for the badge on the campaigns page: Needs attention + Manual + Failed + Owed after reversal (disjoint
 * views, so they add up). One tiny request (limit 1; the counts ride on every answer). It fails quietly and never retries: a badge is a
 * convenience, and the campaigns page must never be slowed or broken by it (no badge is drawn on a failure, nothing is claimed).
 */
export function usePayoutAttentionCount(): number | undefined {
  const { data } = useSWR<PayoutQueuePage>(queueUrl("needs_attention", null, null, 1), unwrap, { refreshInterval: 60_000, revalidateOnFocus: false, shouldRetryOnError: false });
  return attentionCount(data?.counts);
}

/** A payout the worker is about to act on or Razorpay is about to answer for: worth re-reading soon. A parked or paused one waits for a person. */
const MOVING = ["planned", "transfer_requested", "release_requested", "released", "reversal_requested"];
export const isMoving = (r: Pick<PayoutRow, "status" | "releaseAfter" | "pausedAt">) =>
  MOVING.includes(r.status) || (r.status === "held" && !!r.releaseAfter && !r.pausedAt);

/**
 * EVERY payout of ONE campaign (its creator posts), whatever state it is in: finished ones too (Paid with its bank reference, Paid by hand
 * with its reference, Taken back, Void), so "no row" means no payout exists for that post. 200 is the API's page maximum and a campaign
 * has at most 50 posts. `poll`: "moving" re-reads every 30 s only while something is in flight (the campaign page); "always" every 30 s
 * (the campaign's queue, which also shows work that waits for a person).
 */
export function useBookingPayouts(bookingId: string | null, poll: "moving" | "always" = "moving") {
  return useSWR<PayoutQueuePage>(bookingId ? queueUrl("all", bookingId, null, 200) : null, unwrap, {
    refreshInterval: (d) => (poll === "always" || d?.rows.some(isMoving) ? 30_000 : 0),
  });
}

/**
 * Whether ALL releases are paused, read on its own (a light request): the kill switch must stay reachable and the banner truthful when
 * the heavy queue read is the thing that failed. A failed read leaves `data` undefined and the page offers Pause anyway.
 */
export function useReleaseSwitch(enabled = true) {
  return useSWR<ReleaseSwitchState>(enabled ? `${PAYOUTS_BASE}/release-switch` : null, unwrap, { refreshInterval: 30_000 });
}

/** One payout with its history. Loaded only when somebody opens it. */
export function usePayoutDetail(id: string | null) {
  return useSWR<PayoutDetail>(id ? `${PAYOUTS_BASE}/${id}` : null, unwrap, { revalidateOnFocus: false });
}

// ── Actions: a refusal is not the same as "we don't know" ───────────────────────────────────────

/**
 * An action that got no usable answer (a gateway's HTML 502/504 during a deploy, a dropped connection, a 5xx): the move may have been made.
 * Its message says so. Callers refresh what they show (isUnconfirmed) and never present it as "nothing was changed".
 */
export class UnconfirmedActionError extends Error {
  readonly unconfirmed = true as const;
  constructor(message: string) {
    super(message);
    this.name = "UnconfirmedActionError";
  }
}
export const isUnconfirmed = (e: unknown): e is UnconfirmedActionError => e instanceof UnconfirmedActionError;

function failureOf(e: unknown): ActionFailureInput {
  if (e instanceof ApiRequestError) return { status: e.status, readable: true, message: e.message };
  if (e instanceof ApiUnreadableError) return { status: e.status, readable: false, message: e.message };
  // No answer at all (fetch threw: offline, DNS, the connection reset mid-request).
  return { status: null, readable: false, message: e instanceof Error ? e.message : "" };
}

/** Runs a money request; a refusal passes through untouched (its sentence is the API's), anything else becomes an UnconfirmedActionError. */
export async function guardedAction<T>(run: () => Promise<T>, o: { repeatSafe?: boolean } = {}): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const f = classifyActionFailure(failureOf(e), o);
    if (f.unconfirmed) throw new UnconfirmedActionError(f.text);
    throw e;
  }
}

/** Runs one action on one payout. Resolves with the payout's fresh detail (and `result`); throws an Error carrying the API's sentence when refused, an UnconfirmedActionError when there was no usable answer. */
export function runPayoutAction(id: string, action: PayoutActionPath, body?: Record<string, string | undefined>): Promise<PayoutDetail> {
  const clean = body ? Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== "")) : undefined;
  return guardedAction(
    async () => (await apiFetch<{ data: PayoutDetail }>(`${PAYOUTS_BASE}/${id}/${action}`, { method: "POST", body: clean && Object.keys(clean).length > 0 ? JSON.stringify(clean) : undefined })).data,
    { repeatSafe: true },
  );
}

/** Pauses ("off") or resumes ("on") EVERY release, with no restart. Idempotent. */
export function setReleaseSwitch(mode: "on" | "off"): Promise<"on" | "off"> {
  return guardedAction(async () => (await apiFetch<{ data: { key: string; release: "on" | "off" } }>(`${PAYOUTS_BASE}/release-switch`, { method: "PUT", body: JSON.stringify({ mode }) })).data.release, { repeatSafe: true });
}

/** "Mark refunded": the client was repaid outside the portal and this creator post's refund is still owed here. The API records THAT refund; it never sends another. */
export function markItemRefunded(bookingId: string, itemId: string, refundId?: string): Promise<unknown> {
  return guardedAction(() => apiFetch(`/admin/campaigns/${bookingId}/items/${itemId}/mark-refunded`, { method: "POST", body: JSON.stringify(refundId ? { refundId } : {}) }));
}

/** The queue's current view as a CSV file (every row of the view, not only the loaded pages). */
export async function downloadPayoutsCsv(filter: PayoutFilterKey, bookingId: string | null): Promise<void> {
  const q = new URLSearchParams({ filter });
  if (bookingId) q.set("bookingId", bookingId);
  const { blob, filename } = await apiFetchBlob(`${PAYOUTS_BASE}.csv?${q.toString()}`);
  downloadBlob(blob, filename ?? `creator-payouts-${filter.replace(/_/g, "-")}.csv`);
}
