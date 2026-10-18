/**
 * Creator payouts (Razorpay Route): the MONEY LEG's reconciliation worker (payout plan Phase 4, "Reconciliation cron").
 *
 * Every 5 minutes it moves each payout one step along, from facts it reads fresh. It is the BACKSTOP of everything that is
 * also tried inline (the transfer kick after a capture, a staff click, a decline): anything that did not finish there finishes
 * here, in the same order and through the same engine (services/creator/payout.service), so a payout has exactly one way
 * through each step whoever asks.
 *
 * The plan's 14 jobs, and where each lives:
 *   1  execute `planned` payouts                      engine job "execute"           (NEW transfers only: stopped by CREATOR_ROUTE_ENABLED=0)
 *   2  resolve an unknown create result               engine job "resolve_unknown"   (reads the payment's transfers; never a blind retry)
 *   3  confirm the hold                               engine job "confirm_hold"
 *   4  clean up duplicate transfers                   engine job "cleanup_duplicates"
 *   5  release payouts that are due                   engine job "release"           (the release gate, on fresh facts)
 *   6  re-read a stale release_requested              engine job "resolve_release"
 *   7  poll settlements from the moment of release    engine job "poll_settlement"   ("Paid" only from a processed settlement + UTR)
 *   8  resolve reversal_requested                     engine job "resolve_reversal"
 *   9  re-fetch every held payout daily               engine job "recheck_held"      (catches anything done in the dashboard)
 *      (+ put a released, unsettled payout's hold back after a dispute: engine job "rehold_paused")
 *   10 refund the creator posts that are refund_due   creator-refund.service runRefundDueJob   (reverse BEFORE refund)
 *   11 reconcile refunds                              the refund sweep (cron/campaign.cron.ts, every minute), NOT repeated here
 *   12 refresh linked-account activation              cron/creator-payout.cron.ts (every 5 minutes), NOT repeated here
 *   13 expire offers, missed posting windows          cron/creator-offers.cron.ts, NOT repeated here
 *   14 alerts                                         immediate ones are raised by the steps themselves (failed, settlement_failed, a failed
 *                                                     reversal, needs_attention, an outside refund, a dispute); HERE: a payout account that
 *                                                     is suspended while it holds money, and ONE daily digest of anything past its threshold
 *
 * ⚠️ BOUNDED. At most TICK_CALL_BUDGET (20) Razorpay requests a tick: a job runs only if its worst case still fits, so a backlog drains
 * over several ticks instead of hammering Razorpay (a listing counts as two, as the engine counts it). The payout jobs get all but
 * REFUND_RESERVE of them, so the refunds of job 10 are never starved. Payouts are taken oldest first within each job, and the tick
 * stops early after three trouble answers in a row (Razorpay is down: the next tick tries again).
 *
 * ⚠️ SWITCHES. CREATOR_PAYOUT_CRON_ENABLED=0 stops this whole worker (and the transfer kick): payouts wait in their states, nothing
 * is lost. CREATOR_ROUTE_ENABLED off stops only the creation of NEW transfers: existing payouts, reversals, settlements and refunds
 * keep reconciling, so switching the feature off never strands money. system_settings creatorPayouts.release = 'off' pauses all
 * RELEASES at runtime (the engine reads it before every release). With no Razorpay keys the tick does nothing at all.
 *
 * Overlap guard claimed before the first await. Nothing here logs a Razorpay body or a bank detail; a failure on one payout never
 * stops the next.
 */
import { prisma } from "@dashmani/db";
import { creatorConfig } from "../services/creator/creator-config";
import { razorpayConfig } from "../services/campaign/config";
import { refundSweepEnabled } from "../services/campaign/payment.service";
import { PAYOUT_JOBS, runPayoutJob, selectDuePayouts, transfersEnabled, type PayoutJob } from "../services/creator/payout.service";
import { REFUND_DUE_STUCK_ATTEMPTS, runRefundDueJob, type RefundDueSummary } from "../services/creator/creator-refund.service";
import { alertStaffOncePerHour } from "../services/creator/payout-alert";
import { scrubPayoutSecrets } from "../utils/payout-scrub";

export const TICK_CALL_BUDGET = 20;
/** Requests kept back for job 10 (the refunds of refund_due creator posts) so a busy payout queue cannot starve it. */
export const REFUND_RESERVE = 6;
const TICK_MS = 5 * 60_000;
const FIRST_RUN_MS = 3 * 60_000;
/** Payouts one tick may look at (a job is skipped once the budget cannot hold its worst case). */
const SELECT_LIMIT = 50;
const MAX_TROUBLE_IN_A_ROW = 3;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The most Razorpay requests one step of each job can make, counted the way the engine counts them (a listing = 2). */
export const JOB_COST: Readonly<Record<PayoutJob, number>> = {
  execute: 1,
  resolve_unknown: 3,
  confirm_hold: 4,
  cleanup_duplicates: 5,
  release: 8,
  resolve_release: 2,
  poll_settlement: 1,
  resolve_reversal: 3,
  recheck_held: 4,
  rehold_paused: 3,
};

/**
 * The order the jobs run in when the budget cannot cover them all: taking money BACK and cleaning up come before letting
 * more money OUT, and the settlement poll (which only reads) comes last.
 */
const PRIORITY: Readonly<Record<PayoutJob, number>> = {
  resolve_reversal: 0,
  rehold_paused: 1,
  resolve_unknown: 2,
  cleanup_duplicates: 3,
  execute: 4,
  confirm_hold: 5,
  resolve_release: 6,
  release: 7,
  poll_settlement: 8,
  recheck_held: 9,
};

/** Outcomes that mean "Razorpay did not answer usefully": three in a row stop the tick. */
const TROUBLE_OUTCOMES = new Set(["unread", "unknown"]);

export interface PayoutsTickSummary {
  /** False when the tick did nothing at all (switched off, no keys, or another tick still running). */
  ran: boolean;
  /** Due payouts found. */
  selected: number;
  /** Steps run, per job. */
  jobs: Record<PayoutJob, number>;
  /** Steps that did what was asked (or found it already done). */
  ok: number;
  /** Steps that threw (a database error): counted, logged by code, never stopping the rest. */
  failed: number;
  /** Due payouts left for the next tick because the budget could not hold them. */
  deferred: number;
  /** Razorpay requests this tick spent on payouts (job 10's are in `refunds.calls`). */
  calls: number;
  /** Job 10, or null when it did not run (refund sweep switched off, or nothing to look at). */
  refunds: RefundDueSummary | null;
  /** Payout accounts found suspended while holding money (each is alerted once a day). */
  suspendedHolding: number;
  /** Payouts past their threshold, as found by this tick's digest check (0 on a tick that did not run it). */
  stuck: number;
}

const emptyJobs = (): Record<PayoutJob, number> => Object.fromEntries(PAYOUT_JOBS.map((j) => [j, 0])) as Record<PayoutJob, number>;
const idle = (): PayoutsTickSummary => ({ ran: false, selected: 0, jobs: emptyJobs(), ok: 0, failed: 0, deferred: 0, calls: 0, refunds: null, suspendedHolding: 0, stuck: 0 });

let running = false;
let lastDigestCheckAt = 0;
/** When a digest email last actually went out (set only once the mailer said so). */
let lastDigestSentAt = 0;

/** Tests only. */
export function resetCreatorPayoutsCronForTests(): void {
  running = false;
  lastDigestCheckAt = 0;
  lastDigestSentAt = 0;
}

function logFailure(what: string, id: string, e: unknown): void {
  // A name, never a message that could carry anything else.
  console.error(`[creator-payouts] ${what} failed for ${id}: ${scrubPayoutSecrets((e as Error)?.name ?? "Error")}`);
}

/** One pass. Exported for tests; the scheduler below calls it. Never throws. */
export async function runCreatorPayoutsTick(opts: { now?: Date; budget?: number } = {}): Promise<PayoutsTickSummary> {
  if (running) return idle();
  running = true; // claimed before the first await
  try {
    if (!creatorConfig.payoutCronEnabled() || !razorpayConfig.configured()) return idle();
    const out: PayoutsTickSummary = { ...idle(), ran: true };
    const now = opts.now ?? new Date();
    const budget = opts.budget ?? TICK_CALL_BUDGET;
    const payoutBudget = Math.max(0, budget - REFUND_RESERVE);
    const newTransfers = transfersEnabled();

    // ── Jobs 1 to 9: the engine's steps ──
    // With the Route switch off, planned payouts are left planned (nothing NEW is created) and must not use up the places
    // the other jobs need, so they are added to the number looked at.
    let limit = SELECT_LIMIT;
    if (!newTransfers) {
      const planned = await prisma.creatorPayout.count({ where: { status: "planned", pausedAt: null } }).catch(() => 0);
      limit += Math.min(planned, 500);
    }
    const due = (await selectDuePayouts(now, limit)).filter((d) => newTransfers || d.job !== "execute");
    due.sort((a, b) => PRIORITY[a.job] - PRIORITY[b.job]);
    out.selected = due.length;

    let trouble = 0;
    let thrown = 0;
    for (const d of due) {
      if (trouble >= MAX_TROUBLE_IN_A_ROW || thrown >= MAX_TROUBLE_IN_A_ROW) {
        out.deferred++;
        continue;
      }
      if (out.calls + JOB_COST[d.job] > payoutBudget) {
        out.deferred++;
        continue;
      }
      try {
        const r = await runPayoutJob(d.job, d.id, opts.now ? { now: opts.now } : {});
        out.jobs[d.job]++;
        out.calls += r.calls;
        if (r.ok) out.ok++;
        trouble = TROUBLE_OUTCOMES.has(r.outcome) ? trouble + 1 : 0;
        thrown = 0;
      } catch (e) {
        out.failed++;
        thrown++;
        logFailure(d.job, d.id, e);
      }
    }

    // ── Job 10: refund the creator posts that are owed (reverse BEFORE refund) ──
    if (refundSweepEnabled()) {
      try {
        const r = await runRefundDueJob({ now: opts.now, budget: Math.max(0, budget - out.calls) });
        out.refunds = r;
      } catch (e) {
        out.failed++;
        logFailure("refund-due", "creator-items", e);
      }
    }

    // ── Job 14: alerts the steps do not raise ──
    try {
      out.suspendedHolding = await alertSuspendedHolding(now);
    } catch (e) {
      logFailure("suspended-holding check", "accounts", e);
    }
    try {
      out.stuck = await digestStuckPayouts(now);
    } catch (e) {
      logFailure("digest", "payouts", e);
    }
    return out;
  } catch (e) {
    console.error("[creator-payouts] tick failed:", scrubPayoutSecrets(String((e as Error)?.message ?? e)).slice(0, 200));
    return { ...idle(), ran: true };
  } finally {
    running = false;
  }
}

// ── Job 14a: a payout account that is suspended while it holds money ────────────────────────────

/** Payouts whose money may sit in a linked account (held or released) or is in transit to or from it. */
const HOLDING_STATUSES = ["held", "release_requested", "released", "settlement_failed", "reversal_requested", "needs_attention"];

const istDay = (d: Date) => new Date(d.getTime() + 5.5 * HOUR_MS).toISOString().slice(0, 10);

/**
 * Razorpay suspended a creator's linked account while payouts of theirs hold money. Nothing is released to a suspended account (the
 * release gate refuses it), but the money is stuck there: staff must reverse it first, then pay the creator by hand. One alert per
 * account per IST day, naming the count and the total, never a bank detail. Returns how many accounts were found.
 */
export async function alertSuspendedHolding(now: Date): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ account_id: string; creator_id: string; n: number; paise: bigint }>>`
    SELECT a.id AS account_id, a.creator_id AS creator_id, count(*)::int AS n, COALESCE(sum(p.amount_paise), 0)::bigint AS paise
      FROM creator_payouts p
      JOIN creator_payout_accounts a ON a.id = p.payout_account_id
     WHERE a.activation_status = 'suspended' AND p.status = ANY(${HOLDING_STATUSES})
     GROUP BY a.id, a.creator_id
     ORDER BY a.id
     LIMIT 25`;
  for (const r of rows) {
    alertStaffOncePerHour(
      `payout-suspended-holding:${r.account_id}:${istDay(now)}`,
      "A creator's payout account is suspended while it holds money",
      [
        { label: "Creator", value: r.creator_id },
        { label: "Payouts holding money", value: String(r.n) },
        { label: "Amount", value: `₹${(Number(r.paise) / 100).toFixed(2)}` },
        {
          label: "What to do",
          value:
            "Nothing is released to a suspended account. Look at the account in the Razorpay dashboard. If it is not reinstated, take each payout back first (Reverse in the payout queue), then pay the creator by bank transfer and record the reference.",
        },
      ],
      "/campaigns/payouts",
    );
  }
  return rows.length;
}

// ── Job 14b: the daily digest of anything past its threshold ────────────────────────────────────

/** How often the thresholds are looked at. */
const DIGEST_CHECK_EVERY_MS = HOUR_MS;

export interface StuckCategory {
  key: string;
  label: string;
  count: number;
  /** A few payout ids (or item ids for the refund category), oldest first. */
  sample: string[];
}

/**
 * Every payout that is past the point where it should have moved, in one query. The thresholds are generous on purpose (the immediate
 * alerts exist for the urgent ones): this digest is the safety net for the quiet failures: a transfer that never left transfer_requested,
 * a release the gate keeps refusing, a settlement that is slow, a parked payout nobody has looked at, an alert that never reached anyone,
 * a refund that has waited an hour.
 */
export async function findStuckPayouts(now: Date): Promise<StuckCategory[]> {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const t30m = ago(30 * 60_000);
  const t1h = ago(HOUR_MS);
  const t6h = ago(6 * HOUR_MS);
  const t24h = ago(DAY_MS);
  const t4d = ago(4 * DAY_MS);
  const plannedCounts = transfersEnabled();
  const rows = await prisma.$queryRaw<Array<{ key: string; n: number; sample: string[] | null }>>`
    SELECT key, count(*)::int AS n, (array_agg(id ORDER BY ts))[1:5] AS sample FROM (
      SELECT 'planned' AS key, id, created_at AS ts FROM creator_payouts
        WHERE ${plannedCounts} AND status = 'planned' AND paused_at IS NULL AND created_at < ${t30m}::timestamptz AT TIME ZONE 'UTC'
      UNION ALL SELECT 'transfer_requested', id, COALESCE(transfer_requested_at, updated_at) FROM creator_payouts
        WHERE status = 'transfer_requested' AND COALESCE(transfer_requested_at, updated_at) < ${t30m}::timestamptz AT TIME ZONE 'UTC'
      UNION ALL SELECT 'release_requested', id, COALESCE(release_requested_at, updated_at) FROM creator_payouts
        WHERE status = 'release_requested' AND COALESCE(release_requested_at, updated_at) < ${t30m}::timestamptz AT TIME ZONE 'UTC'
      UNION ALL SELECT 'reversal_requested', id, COALESCE(reversal_requested_at, updated_at) FROM creator_payouts
        WHERE status = 'reversal_requested' AND COALESCE(reversal_requested_at, updated_at) < ${t30m}::timestamptz AT TIME ZONE 'UTC'
      UNION ALL SELECT 'needs_attention', id, updated_at FROM creator_payouts
        WHERE status = 'needs_attention' AND updated_at < ${t1h}::timestamptz AT TIME ZONE 'UTC'
      UNION ALL SELECT 'manual_required', id, updated_at FROM creator_payouts
        WHERE status = 'manual_required' AND updated_at < ${t24h}::timestamptz AT TIME ZONE 'UTC'
      UNION ALL SELECT 'failed', id, updated_at FROM creator_payouts
        WHERE status IN ('failed', 'settlement_failed') AND updated_at < ${t6h}::timestamptz AT TIME ZONE 'UTC'
      UNION ALL SELECT 'unalerted', id, updated_at FROM creator_payouts
        WHERE status IN ('failed', 'settlement_failed', 'needs_attention', 'manual_required')
          AND alerted_status IS DISTINCT FROM status AND updated_at < ${t1h}::timestamptz AT TIME ZONE 'UTC'
      UNION ALL SELECT 'slow_settlement', id, released_at FROM creator_payouts
        WHERE status = 'released' AND released_at < ${t4d}::timestamptz AT TIME ZONE 'UTC'
      UNION ALL SELECT 'paused', id, paused_at FROM creator_payouts
        WHERE paused_at IS NOT NULL AND status NOT IN ('settled', 'paid_manual', 'void', 'reversed') AND paused_at < ${t24h}::timestamptz AT TIME ZONE 'UTC'
      UNION ALL SELECT 'held_not_released', id, release_after FROM creator_payouts
        WHERE status = 'held' AND paused_at IS NULL AND release_after IS NOT NULL AND release_after < ${t24h}::timestamptz AT TIME ZONE 'UTC'
      UNION ALL SELECT 'refund_due', id, updated_at FROM campaign_booking_items
        WHERE target_type = 'creator_asset' AND status = 'refund_due' AND attempts >= ${REFUND_DUE_STUCK_ATTEMPTS}
    ) q GROUP BY key ORDER BY key`;
  const label: Record<string, string> = {
    planned: "Planned for over 30 minutes (the transfer was never made)",
    transfer_requested: "Transfer requested over 30 minutes ago and not confirmed",
    release_requested: "Release requested over 30 minutes ago and not confirmed",
    reversal_requested: "Reversal requested over 30 minutes ago and not confirmed",
    needs_attention: "Parked for a person, waiting over an hour",
    manual_required: "To be paid by bank transfer, waiting over a day",
    failed: "Failed over 6 hours ago and not dealt with",
    unalerted: "In a problem state and no alert email ever reached staff",
    slow_settlement: "Released over 4 days ago and still not settled",
    paused: "Paused for over a day",
    held_not_released: "Due for release over a day ago and still held (the release gate keeps refusing it)",
    refund_due: "A creator post has waited about an hour to be refunded",
  };
  return rows.map((r) => ({ key: r.key, label: label[r.key] ?? r.key, count: r.n, sample: (r.sample ?? []).slice(0, 5) }));
}

/**
 * At most once an hour, look for payouts past their threshold, and email ONE digest per day while there are any (counted from the last
 * digest that really went out: `onSent`, so a failed send is tried again the next hour). Returns how many payouts were found
 * (0 on a tick that did not run the check). Only ids, counts and our own wording go into the mail.
 */
export async function digestStuckPayouts(now: Date): Promise<number> {
  if (now.getTime() - lastDigestCheckAt < DIGEST_CHECK_EVERY_MS) return 0;
  lastDigestCheckAt = now.getTime();
  const found = await findStuckPayouts(now);
  const total = found.reduce((n, c) => n + c.count, 0);
  if (total === 0) return 0;
  if (now.getTime() - lastDigestSentAt < DAY_MS) return total;
  alertStaffOncePerHour(
    "payout-digest",
    `${total} creator payout${total === 1 ? "" : "s"} past the point they should have moved`,
    [
      ...found.map((c) => ({ label: c.label, value: `${c.count}${c.sample.length ? ` (e.g. ${c.sample.join(", ")})` : ""}` })),
      { label: "What to do", value: "Open the payout queue and work through each. Every row says why it is where it is, and every action there is safe to repeat." },
    ],
    "/campaigns/payouts",
    {
      now: now.getTime(),
      onSent: () => {
        lastDigestSentAt = now.getTime();
      },
    },
  );
  return total;
}

// ── Scheduler ───────────────────────────────────────────────────────────────────────────────────

export function startCreatorPayoutsCron(): void {
  if (!creatorConfig.payoutCronEnabled()) {
    console.warn("[creator-payouts] CREATOR_PAYOUT_CRON_ENABLED=0: the payout reconciliation worker is NOT running. Payouts wait in their states.");
    return;
  }
  const tick = () => {
    runCreatorPayoutsTick()
      .then((s) => {
        if (s.ok || s.failed || s.refunds?.checked || s.suspendedHolding || s.stuck) {
          console.log("[creator-payouts]", JSON.stringify({ selected: s.selected, calls: s.calls, jobs: s.jobs, ok: s.ok, failed: s.failed, deferred: s.deferred, refunds: s.refunds, suspendedHolding: s.suspendedHolding, stuck: s.stuck }));
        }
      })
      .catch((e) => console.error("[creator-payouts] tick failed:", scrubPayoutSecrets(String((e as Error)?.message ?? e)).slice(0, 200)));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, FIRST_RUN_MS);
}
