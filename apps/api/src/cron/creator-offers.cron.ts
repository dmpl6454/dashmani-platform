/**
 * Creator offers (payout plan Phase 3): the clock-driven half of a booking offer.
 *
 * Every 5 minutes, three jobs, each bounded:
 *   (a) EXPIRE: an `offered` offer past its expiry is closed (expireOffer): its item goes refund_due, a planned payout is
 *       voided, staff are told. Nothing is refunded: staff press Refund.
 *   (b) MISSED WINDOW: an `accepted` offer whose creator never sent a link by the END OF THE POSTING WINDOW + 24 HOURS.
 *       Staff are alerted ONCE (post_missing_at is stamped first, conditionally), then the offer is withdrawn the same
 *       way. An accepted offer WITH a link that nobody verified by then is not withdrawn (a person decides: the creator
 *       did something); staff are alerted once instead.
 *   (c) LAUNCH-DAY REMINDER: one email to a creator whose accepted offer has no link yet, once the window is open, between
 *       09:00 and 20:00 IST. "Once" is recorded in the booking's history (the schema has no column for it).
 *
 * Dark: does nothing unless the marketplace is switched on (CREATORS_MARKETPLACE_ENABLED + CREATOR_ROUTE_ENABLED + the
 * Razorpay keys), and CREATOR_OFFERS_CRON_ENABLED=0 stops it. Overlap guard claimed before the first await. Never logs a
 * token or a Razorpay body; a failure on one offer never stops the next.
 */

import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";
import { creatorConfig } from "../services/creator/creator-config";
import { expireOffer, linkDeadline, sendLaunchReminder, withdrawOffer } from "../services/creator/creator-offer.service";
import { alertStaffOncePerHour } from "../services/creator/payout-alert";
import { logBookingEvent } from "../services/campaign/booking.service";
import { scrubSecrets } from "../utils/token-crypto";

const TICK_MS = 5 * 60_000;
const FIRST_RUN_MS = 6 * 60_000;
const HOUR_MS = 3_600_000;
/** Most offers handled per job per tick: a backlog drains over several ticks instead of one long one. */
const BATCH = 50;
/** The reminder goes out between these IST hours (a window opens at IST midnight; nobody wants a mail then). */
const REMINDER_FROM_HOUR_IST = 9;
const REMINDER_TO_HOUR_IST = 20;

export interface OffersTickSummary {
  /** False when the tick did nothing at all (switched off, marketplace off, or another tick still running). */
  ran: boolean;
  expired: number;
  /** Accepted offers with no link at the end of the grace: withdrawn. */
  missed: number;
  /** Accepted offers with a link nobody verified by then: staff alerted, offer left alone. */
  unverified: number;
  reminded: number;
  failed: number;
}

const idle = (): OffersTickSummary => ({ ran: false, expired: 0, missed: 0, unverified: 0, reminded: 0, failed: 0 });

let running = false;

/** Tests only. */
export function resetCreatorOffersCronForTests(): void {
  running = false;
}

const istHour = (d: Date) => Math.floor(((d.getTime() + 5.5 * HOUR_MS) % (24 * HOUR_MS)) / HOUR_MS);

function logFailure(what: string, offerId: string, e: unknown): void {
  // A code, never a message that could carry anything else.
  const code = e instanceof AppError ? e.code : "ERROR";
  console.error(`[creator-offers] ${what} failed for ${offerId}: ${scrubSecrets(code).slice(0, 80)}`);
}

/**
 * Someone else got there first (the creator accepted at the last second, staff withdrew, the creator sent a link between the
 * query and the close): the offer is no longer this job's to close, and that is not a failure. Anything else is: a payout
 * already past `planned` (the offer stays open and a person has to look: the transfer-reversal step is a later phase), or an
 * item that is not where its offer says it is (INVALID_STATE), which must never be skipped silently every five minutes.
 */
const LOST_RACE_CODES = new Set(["OFFER_CLOSED", "NOT_EXPIRED", "LINK_SUBMITTED", "ALREADY_VERIFIED"]);
function lostTheRace(e: unknown): boolean {
  return e instanceof AppError && e.statusCode === 409 && LOST_RACE_CODES.has(e.code);
}

/** (a) Close the offers nobody answered in time. */
export async function expireDueOffers(now: Date = new Date()): Promise<{ expired: number; failed: number }> {
  const due = await prisma.creatorOffer.findMany({ where: { status: "offered", expiresAt: { lte: now } }, orderBy: { expiresAt: "asc" }, take: BATCH, select: { id: true } });
  let expired = 0;
  let failed = 0;
  for (const o of due) {
    try {
      await expireOffer(o.id, now);
      expired++;
    } catch (e) {
      if (lostTheRace(e)) continue;
      failed++;
      logFailure("expire", o.id, e);
    }
  }
  return { expired, failed };
}

/** (b) Accepted offers whose posting window (+ 24 h) is over. */
export async function closeMissedWindows(now: Date = new Date()): Promise<{ missed: number; unverified: number; failed: number }> {
  // An offer with no window (it cannot be made without one) is never picked up: there is no deadline to miss. The window's
  // last day is a DATE (an IST day at 00:00 UTC), so this only narrows the search; linkDeadline() below is the exact test.
  const overdue = await prisma.creatorOffer.findMany({
    where: { status: "accepted", linkVerifiedAt: null, windowTo: { lt: now } },
    orderBy: { windowTo: "asc" },
    take: BATCH,
  });
  let missed = 0;
  let unverified = 0;
  let failed = 0;
  for (const o of overdue) {
    try {
      const deadline = linkDeadline(o);
      if (!deadline || deadline.getTime() > now.getTime()) continue;
      if (o.linkSubmittedAt) {
        // The creator did send a link and nobody verified it: staff decide (verify it, or withdraw it with the link discarded). Tell them once.
        if (await markOnce(o.bookingId, `Overdue: the creator's link on ${o.pageName} still needs a decision (offer ${o.id})`)) {
          unverified++;
          alertStaffOncePerHour(
            `creator-offer-unverified:${o.id}`,
            "A creator's link is waiting for a decision",
            [
              { label: "Campaign", value: o.bookingId },
              { label: "Page", value: o.pageName },
              { label: "Link check", value: o.ownershipCheck ?? "not checked" },
              { label: "What to do", value: "The posting window is over. Open the campaign and either verify the creator's link, or withdraw the offer with the submitted link discarded." },
            ],
            `/campaigns/${o.bookingId}`,
          );
        }
        continue;
      }
      // Stamp first, conditionally: the staff alert is sent once even if the withdraw below has to be retried.
      const stamped = await prisma.creatorOffer.updateMany({ where: { id: o.id, status: "accepted", postMissingAt: null }, data: { postMissingAt: now } });
      if (stamped.count === 1) {
        alertStaffOncePerHour(
          `creator-offer-missed:${o.id}`,
          "A creator did not post in the window",
          [
            { label: "Campaign", value: o.bookingId },
            { label: "Page", value: o.pageName },
            { label: "What happens", value: "The offer is withdrawn and the post is marked refund due. Nothing is refunded automatically: press Refund on the post." },
          ],
          `/campaigns/${o.bookingId}`,
        );
      }
      await withdrawOffer(o.id, { closedReason: "missed_window", alert: false, now });
      missed++;
    } catch (e) {
      if (lostTheRace(e)) continue;
      failed++;
      logFailure("missed-window", o.id, e);
    }
  }
  return { missed, unverified, failed };
}

/**
 * Record, in the booking's history, that something was done for an offer, and say whether THIS call is the one that did it.
 * (creator_offers has no column for "reminded" or "alerted", and a schema change is not part of this phase.) The marker is
 * the note itself, so asking twice finds the first.
 */
async function markOnce(bookingId: string, note: string): Promise<boolean> {
  const exists = await prisma.campaignBookingEvent.findFirst({ where: { bookingId, note }, select: { id: true } });
  if (exists) return false;
  await logBookingEvent(bookingId, { type: "system" }, note);
  return true;
}

/** (c) One reminder per accepted, unposted offer once its window is open. */
export async function sendLaunchReminders(now: Date = new Date()): Promise<{ reminded: number; failed: number }> {
  const hour = istHour(now);
  if (hour < REMINDER_FROM_HOUR_IST || hour >= REMINDER_TO_HOUR_IST) return { reminded: 0, failed: 0 };
  // The window is two IST calendar days stored as DATEs (00:00 UTC): it is open from IST midnight of the first day
  // (5.5 h before that instant) until IST midnight after the last.
  const open = await prisma.creatorOffer.findMany({
    where: { status: "accepted", linkSubmittedAt: null, windowFrom: { lte: new Date(now.getTime() + 5.5 * HOUR_MS) }, windowTo: { gt: new Date(now.getTime() - 18.5 * HOUR_MS) } },
    orderBy: { windowFrom: "asc" },
    take: BATCH,
  });
  let reminded = 0;
  let failed = 0;
  for (const o of open) {
    const note = `Launch-day reminder emailed to the creator for ${o.pageName} (offer ${o.id})`;
    try {
      if (await prisma.campaignBookingEvent.findFirst({ where: { bookingId: o.bookingId, note }, select: { id: true } })) continue;
      // Claim first (the history row IS the claim), send, and give the claim back when the mail did not go out, so the next tick tries again.
      const claim = await prisma.campaignBookingEvent.create({ data: { bookingId: o.bookingId, actorType: "system", note } });
      const sent = await sendLaunchReminder(o);
      if (sent) reminded++;
      else await prisma.campaignBookingEvent.deleteMany({ where: { id: claim.id } });
    } catch (e) {
      failed++;
      logFailure("reminder", o.id, e);
    }
  }
  return { reminded, failed };
}

/** One pass of the three jobs. Exported for tests; the scheduler below calls it. Never throws. */
export async function runCreatorOffersTick(opts: { now?: Date } = {}): Promise<OffersTickSummary> {
  if (running) return idle();
  running = true; // claimed before the first await
  const out: OffersTickSummary = { ...idle(), ran: true };
  try {
    if (!creatorConfig.offersCronEnabled() || !creatorConfig.marketplaceAvailable()) return idle();
    const now = opts.now ?? new Date();
    try {
      const a = await expireDueOffers(now);
      out.expired = a.expired;
      out.failed += a.failed;
    } catch (e) {
      out.failed++;
      console.error("[creator-offers] expiry pass failed:", scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 200));
    }
    try {
      const b = await closeMissedWindows(now);
      out.missed = b.missed;
      out.unverified = b.unverified;
      out.failed += b.failed;
    } catch (e) {
      out.failed++;
      console.error("[creator-offers] missed-window pass failed:", scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 200));
    }
    try {
      const c = await sendLaunchReminders(now);
      out.reminded = c.reminded;
      out.failed += c.failed;
    } catch (e) {
      out.failed++;
      console.error("[creator-offers] reminder pass failed:", scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 200));
    }
    return out;
  } finally {
    running = false;
  }
}

export function startCreatorOffersCron(): void {
  if (!creatorConfig.offersCronEnabled()) {
    console.warn("[creator-offers] CREATOR_OFFERS_CRON_ENABLED=0: offer expiry, missed-window and reminders are NOT running.");
    return;
  }
  const tick = () => {
    runCreatorOffersTick()
      .then((s) => {
        if (s.expired || s.missed || s.unverified || s.reminded || s.failed) console.log("[creator-offers]", JSON.stringify(s));
      })
      .catch((e) => console.error("[creator-offers] tick failed:", scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 200)));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, FIRST_RUN_MS);
}
