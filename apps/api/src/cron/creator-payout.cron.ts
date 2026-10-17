/**
 * Creator payouts (Razorpay Route): the linked-account activation poll.
 *
 * ⚠️ WHY A POLL. Razorpay sends no notification when a linked account activates or fails verification
 * [R2 FAQ Q11-12]; the product.route.* webhooks are an accelerator, not the source of truth, and
 * product.route.suspended is not delivered at all. So every 5 minutes this reads the Route product of
 * each account whose status can still change, and writes what Razorpay says through the SAME mapping the
 * webhook uses (applyProductStatus), so there is one place a status is decided.
 *
 * Who is polled (and how often), oldest check first:
 *   • setup finished, status requested / under_review / needs_clarification: every tick;
 *   • setup NOT finished but a product exists (a creator stopped at the bank step): hourly;
 *   • activated or suspended: daily (this is how a suspension is noticed, and a re-activation).
 * An account whose setup lease is held right now is skipped: that request is writing it.
 *
 * Bounded: at most TICK_CALL_BUDGET (20) Razorpay calls a tick, and the tick stops early after three
 * failures in a row (Razorpay is down; the next tick tries again). An account that failed is left alone
 * for 30 minutes (in memory) so one broken row cannot eat the budget forever at the head of the queue.
 *
 * Staff are told ONCE per episode when an account that finished setup becomes needs_clarification
 * (with the field references only) or suspended: the stamp `alerted:<status>` in last_error records that
 * the email went out, and is cleared when the account leaves that status, so a later relapse alerts again.
 * Alerts go through alertStaffOncePerHour (rate-limited: the Gmail account is shared with password resets).
 *
 * Nothing here ever logs a Razorpay body. Overlap guard claimed before the first await. Kill switch
 * CREATOR_PAYOUT_CRON_ENABLED=0; a no-op while the Razorpay keys are absent. It does NOT depend on
 * CREATOR_ROUTE_ENABLED: switching the feature off must never stop reconciling an existing account.
 */

import { prisma } from "@dashmani/db";
import { creatorConfig } from "../services/creator/creator-config";
import { razorpayConfig } from "../services/campaign/config";
import { RazorpayError, fetchRouteProduct } from "../services/campaign/razorpay";
import { applyProductStatus } from "../services/creator/payout-account.service";
import { setupIsDone, toPayoutAccountView } from "../services/creator/payout-account-view";
import { alertStaffOncePerHour } from "../services/creator/payout-alert";
import { scrubPayoutSecrets } from "../utils/payout-scrub";

export const TICK_CALL_BUDGET = 20;
const TICK_MS = 5 * 60_000;
const FIRST_RUN_MS = 4 * 60_000;
const MIN = 60_000;
const HOUR_MS = 60 * MIN;
const DAY_MS = 24 * HOUR_MS;
const FAIL_COOLDOWN_MS = 30 * MIN;
const MAX_CONSECUTIVE_FAILURES = 3;

const NON_FINAL = ["not_started", "requested", "under_review", "needs_clarification"];
const FINAL = ["activated", "suspended"];
const SETUP_DONE_STEPS = ["bank", "done"];

export interface PayoutTickSummary {
  /** False when the tick did nothing at all (switched off, no keys, or another tick still running). */
  ran: boolean;
  polled: number;
  changed: number;
  failed: number;
  alerted: number;
}

const idle = (): PayoutTickSummary => ({ ran: false, polled: 0, changed: 0, failed: 0, alerted: 0 });

let running = false;
const failedAt = new Map<string, number>();

/** Tests only. */
export function resetCreatorPayoutCronForTests(): void {
  running = false;
  failedAt.clear();
}

function logFailure(rowId: string, e: unknown): void {
  // A code and a status, never a message or a body.
  const what = e instanceof RazorpayError ? `${e.code ?? "HTTP"} ${e.status}` : "unexpected error";
  console.error(`[creator-payout] poll failed for ${rowId}: ${scrubPayoutSecrets(what)}`);
}

/** One pass of the poll. Exported for tests; the scheduler below calls it. Never throws. */
export async function runCreatorPayoutTick(opts: { now?: Date; budget?: number } = {}): Promise<PayoutTickSummary> {
  if (running) return idle();
  running = true; // claimed before the first await
  const out: PayoutTickSummary = { ...idle(), ran: true };
  try {
    if (!creatorConfig.payoutCronEnabled() || !razorpayConfig.configured()) return idle();
    const now = opts.now ?? new Date();
    const budget = opts.budget ?? TICK_CALL_BUDGET;
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const notChecked = (ms: number) => ({ OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: ago(ms) } }] });

    const candidates = await prisma.creatorPayoutAccount.findMany({
      where: {
        razorpayAccountId: { not: null },
        razorpayProductId: { not: null },
        AND: [
          { OR: [{ setupLockedUntil: null }, { setupLockedUntil: { lt: now } }] },
          {
            OR: [
              { setupStep: { in: SETUP_DONE_STEPS }, activationStatus: { in: NON_FINAL }, ...notChecked(4 * MIN) },
              { setupStep: { notIn: SETUP_DONE_STEPS }, activationStatus: { in: NON_FINAL }, ...notChecked(HOUR_MS) },
              { activationStatus: { in: FINAL }, ...notChecked(DAY_MS) },
            ],
          },
        ],
      },
      orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }],
      take: budget * 3, // headroom for rows skipped by the failure cooldown
    });

    let calls = 0;
    let consecutiveFailures = 0;
    for (const row of candidates) {
      if (calls >= budget) break;
      const cool = failedAt.get(row.id);
      if (cool !== undefined && now.getTime() - cool < FAIL_COOLDOWN_MS) continue;
      calls++;
      try {
        const product = await fetchRouteProduct(row.razorpayAccountId!, row.razorpayProductId!);
        consecutiveFailures = 0;
        failedAt.delete(row.id);
        const res = await applyProductStatus(
          row,
          { activationStatus: product.activation_status, requirements: product.requirements, at: opts.now ?? new Date(), settlementHint: product.settlement_hint },
          { touch: true },
        );
        out.polled++;
        if (res.applied) out.changed++;
        if (await alertIfNeeded(row.id, now)) out.alerted++;
      } catch (e) {
        out.failed++;
        failedAt.set(row.id, now.getTime());
        logFailure(row.id, e);
        if (e instanceof RazorpayError && (e.status === 401 || e.status === 403)) {
          alertStaffOncePerHour("payout-account-poll-auth", "Razorpay refused the payout account poll", [
            { label: "What happened", value: `Razorpay answered HTTP ${e.status} when we read a creator's linked account. The keys may be wrong or Route may have been switched off.` },
            { label: "What happens", value: "Account statuses stop updating until this is fixed. Nothing is paid or changed by the poll." },
          ]);
        }
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break; // Razorpay is down: the next tick tries again
      }
    }
    return out;
  } catch (e) {
    console.error("[creator-payout] tick failed:", scrubPayoutSecrets(String((e as Error)?.message ?? e)).slice(0, 200));
    return out;
  } finally {
    running = false;
  }
}

/**
 * After a poll: tell staff once when a finished-setup account is needs_clarification or suspended, and clear the
 * stamp once it has left that status. Re-reads the row (a webhook may have moved it a moment ago).
 * @returns true when an alert was handed to the mailer.
 */
async function alertIfNeeded(rowId: string, now: Date): Promise<boolean> {
  const fresh = await prisma.creatorPayoutAccount.findUnique({ where: { id: rowId } });
  if (!fresh) return false;
  const status = fresh.activationStatus;
  const flagged = setupIsDone(fresh) && (status === "needs_clarification" || status === "suspended");
  if (!flagged) {
    if (fresh.lastError?.startsWith("alerted:")) {
      await prisma.creatorPayoutAccount.updateMany({ where: { id: rowId, lastError: { startsWith: "alerted:" } }, data: { lastError: null } });
    }
    return false;
  }
  const stamp = `alerted:${status}`;
  if (fresh.lastError === stamp) return false;
  const creator = await prisma.creator.findUnique({ where: { id: fresh.creatorId }, select: { id: true, name: true, email: true } });
  const fields = (toPayoutAccountView(fresh, now)?.requirements ?? []).map((r) => `${r.field} (${r.reason})`).join(", ");
  return alertStaffOncePerHour(
    `payout-account:${fresh.id}:${status}`,
    status === "suspended" ? "Creator payout account suspended by Razorpay" : "Creator payout account needs clarification",
    [
      { label: "Creator", value: creator ? `${creator.name} (${creator.email})` : fresh.creatorId },
      { label: "Razorpay account", value: fresh.razorpayAccountId ?? "" },
      { label: "Status", value: status },
      ...(fields ? [{ label: "Fields Razorpay named", value: fields }] : []),
      {
        label: "What to do",
        value:
          status === "suspended"
            ? "Look at the account in the Razorpay dashboard. Do not release anything for this creator until it is reinstated."
            : "Open the account in the Razorpay dashboard and see what it needs. Where it is the creator's bank details, they can ask for a change from their payout page.",
      },
    ],
    `/creators/${fresh.creatorId}`,
    {
      // Stamped only once the mail really went out: a failed send leaves the row unstamped, so the next tick tries again.
      onSent: async () => {
        await prisma.creatorPayoutAccount.updateMany({ where: { id: rowId, activationStatus: status }, data: { lastError: stamp } });
      },
    },
  );
}

export function startCreatorPayoutCron(): void {
  if (!creatorConfig.payoutCronEnabled()) {
    console.warn("[creator-payout] CREATOR_PAYOUT_CRON_ENABLED=0: the payout account poll is NOT running.");
    return;
  }
  const tick = () => {
    runCreatorPayoutTick()
      .then((s) => {
        if (s.changed || s.failed || s.alerted) console.log("[creator-payout]", JSON.stringify(s));
      })
      .catch((e) => console.error("[creator-payout] tick failed:", scrubPayoutSecrets(String((e as Error)?.message ?? e)).slice(0, 200)));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, FIRST_RUN_MS);
}
