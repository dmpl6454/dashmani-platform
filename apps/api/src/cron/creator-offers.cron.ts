/**
 * Creator offers (payout plan Phase 3): the clock-driven half of a booking offer.
 *
 * Every 5 minutes, each job bounded:
 *   (a) EXPIRE: an `offered` offer past its expiry is closed (expireOffer): its item goes refund_due, a planned payout is
 *       voided. This worker refunds nothing: the payout worker's job 10 takes the creator's share back and then refunds the
 *       client (staff press Refund only while that worker or the refund sweep is switched off).
 *   (b) MISSED WINDOW: an `accepted` offer whose creator never sent a link by the END OF THE POSTING WINDOW + 24 HOURS is
 *       withdrawn the same way (post_missing_at is stamped first: it is the fact "the creator did not post"). An accepted
 *       offer WITH a link that nobody verified by then is NOT withdrawn (a person decides: the creator did something).
 *   (c) RESEND: an offer whose email never went out (notified_at still NULL) is mailed again, with backoff and a bound.
 *   (d) LAUNCH-DAY REMINDER: one email to a creator whose accepted offer has no link yet, once the window is open, between
 *       09:00 and 20:00 IST. "Once" is recorded in the booking's history (the schema has no column for it).
 *   (e) STAFF ALERTS, derived from state: one email per BOOKING listing every page that needs a person (a refund owed, a
 *       missed window, a link waiting for a decision, an offer the creator was never emailed).
 *
 * ⚠️ AN ALERT IS DONE ONLY WHEN IT WAS SENT. Each alert writes a marker line to the booking's history from `onSent` (the mailer
 * said it took the mail), never before: a held-back or failed alert leaves no marker, so the next tick sends it again. The
 * markers are also what keeps one alert from being sent twice. (Before, the marker came first, and a dropped alert was lost for
 * good.) Alerts are per booking, not per offer: 15 creator pages that expire together are ONE email, not 15 against the shared
 * hourly ceiling.
 *
 * ⚠️ AFTER AN OUTAGE (the marketplace switched off, CREATOR_OFFERS_CRON_ENABLED=0, the API down) the creators could not answer
 * and the deadlines are wall-clock. A tick that finds the last one long ago extends every open offer by the silence and records
 * a grace window for the posting deadlines (services/creator/creator-offer.service effectiveLinkDeadline) BEFORE any closing
 * pass runs, so nothing is mass-expired or mass-withdrawn for time the creators were locked out of.
 *
 * Dark: does nothing unless the marketplace is switched on (CREATORS_MARKETPLACE_ENABLED + CREATOR_ROUTE_ENABLED + the
 * Razorpay keys), and CREATOR_OFFERS_CRON_ENABLED=0 stops it. Overlap guard claimed before the first await. Never logs a
 * token or a Razorpay body; a failure on one offer never stops the next.
 */

import { prisma, type CreatorOffer } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";
import { creatorConfig } from "../services/creator/creator-config";
import { refundSweepEnabled } from "../services/campaign/payment.service";
import {
  ALERT_LOOKBACK_MS,
  GAP_MAX_EXTEND_MS,
  GAP_THRESHOLD_MS,
  GRACE_MAX_MS,
  HEARTBEAT_KEY,
  OFFER_EMAIL,
  REMINDER_PAUSE_MS,
  RETRY_MARKER_CONTAINS,
  RETRY_MARKER_RE,
  alertMarker,
  retryMarker,
  type StaffAlertKind,
} from "../services/creator/creator-offers-config";
import {
  closedOfferText,
  effectiveLinkDeadline,
  expireOffer,
  fmtDateTimeIST,
  loadDeadlineGrace,
  postingWindow,
  recordDeadlineGrace,
  sendLaunchReminder,
  sendOfferEmail,
  withdrawOffer,
  type GraceWindow,
} from "../services/creator/creator-offer.service";
import { alertStaffOncePerHour } from "../services/creator/payout-alert";
import { logBookingEvent } from "../services/campaign/booking.service";
import { scrubSecrets } from "../utils/token-crypto";

const TICK_MS = 5 * 60_000;
const FIRST_RUN_MS = 6 * 60_000;
const HOUR_MS = 3_600_000;
/** Most offers handled per job per tick: a backlog drains over several ticks instead of one long one. */
const BATCH = 50;
/** More are READ than handled for the alert passes, because rows already alerted stay in their result sets. */
const ALERT_SCAN = 200;
/** The reminder goes out between these IST hours (a window opens at IST midnight; nobody wants a mail then). */
const REMINDER_FROM_HOUR_IST = 9;
const REMINDER_TO_HOUR_IST = 20;
/** windowTo is an IST calendar day (00:00 UTC): its posting deadline is that + the rest of the IST day (18.5 h) + the 24 h grace. */
const DEADLINE_AFTER_WINDOWTO_MS = 18.5 * HOUR_MS + 24 * HOUR_MS;

export interface OffersTickSummary {
  /** False when the tick did nothing at all (switched off, marketplace off, or another tick still running). */
  ran: boolean;
  expired: number;
  /** Accepted offers with no link at the end of the grace: withdrawn. */
  missed: number;
  /** Accepted offers with a link nobody verified by then: staff alerted (once), offer left alone. */
  unverified: number;
  reminded: number;
  /** Offer emails that finally went out on a retry. */
  resent: number;
  failed: number;
}

const idle = (): OffersTickSummary => ({ ran: false, expired: 0, missed: 0, unverified: 0, reminded: 0, resent: 0, failed: 0 });

let running = false;
let reminderPausedUntil = 0;

/** Tests only. */
export function resetCreatorOffersCronForTests(): void {
  running = false;
  reminderPausedUntil = 0;
}
/** Tests only: epoch ms until which launch-day reminders are paused (0 = not paused). */
export const reminderPausedUntilForTests = () => reminderPausedUntil;

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

/** The creators among these ids whose account is NOT approved (suspended, closed): they cannot answer or post, so a deadline that passes is not their miss. */
async function unavailableCreators(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const ok = await prisma.creator.findMany({ where: { id: { in: unique }, status: "approved" }, select: { id: true } });
  const approved = new Set(ok.map((c) => c.id));
  return new Set(unique.filter((id) => !approved.has(id)));
}

// ── (a) expire ─────────────────────────────────────────────────────────────────────────────────

/**
 * Close these offers (read a moment ago) if they are still due. Split from the query so a test can hand it an offer that has
 * since changed: that is the only way to exercise the lost race, which needs the row to change BETWEEN the read and the close.
 */
export async function expireCandidates(due: Array<{ id: string; creatorId: string }>, now: Date): Promise<{ expired: number; failed: number }> {
  const away = await unavailableCreators(due.map((o) => o.creatorId));
  let expired = 0;
  let failed = 0;
  for (const o of due) {
    try {
      // The staff email is the per-booking digest below (alertPending), not one email per offer.
      await expireOffer(o.id, now, { alert: false, closedReason: away.has(o.creatorId) ? "creator_unavailable" : "expired" });
      expired++;
    } catch (e) {
      if (lostTheRace(e)) continue;
      failed++;
      logFailure("expire", o.id, e);
    }
  }
  return { expired, failed };
}

/** (a) Close the offers nobody answered in time. */
export async function expireDueOffers(now: Date = new Date()): Promise<{ expired: number; failed: number }> {
  const due = await prisma.creatorOffer.findMany({ where: { status: "offered", expiresAt: { lte: now } }, orderBy: { expiresAt: "asc" }, take: BATCH, select: { id: true, creatorId: true } });
  return expireCandidates(due, now);
}

// ── (b) missed window ──────────────────────────────────────────────────────────────────────────

/** Withdraw these accepted, link-less offers (read a moment ago) whose posting deadline has passed. Split from the query for the same reason as expireCandidates. */
export async function closeMissedCandidates(overdue: CreatorOffer[], now: Date, grace: GraceWindow[]): Promise<{ missed: number; failed: number }> {
  const away = await unavailableCreators(overdue.map((o) => o.creatorId));
  let missed = 0;
  let failed = 0;
  for (const o of overdue) {
    try {
      const deadline = effectiveLinkDeadline(o, grace);
      if (!deadline || deadline.getTime() > now.getTime()) continue;
      // The FACT, stamped first and conditionally (it is also what sorts a withdraw that keeps failing behind fresh ones). The staff email is derived from state (alertPending).
      // Conditional on there still being no link: one that arrived since the read is not a missed window (the withdraw below would refuse it anyway).
      await prisma.creatorOffer.updateMany({ where: { id: o.id, status: "accepted", postMissingAt: null, linkSubmittedAt: null }, data: { postMissingAt: now } });
      await withdrawOffer(o.id, { closedReason: away.has(o.creatorId) ? "creator_unavailable" : "missed_window", alert: false, now });
      missed++;
    } catch (e) {
      if (lostTheRace(e)) continue;
      failed++;
      logFailure("missed-window", o.id, e);
    }
  }
  return { missed, failed };
}

/**
 * (b) Accepted offers with NO link whose posting window (+ 24 h) is over are withdrawn. ⚠️ Only no-link offers: one whose
 * creator did send a link never leaves its result set while staff decide, and would fill the batch (the unverified-link alert is
 * its own bounded pass). Offers whose withdraw already failed (post_missing_at is set) sort BEHIND fresh ones, so a few that
 * cannot be reversed yet cannot starve the rest.
 */
export async function closeMissedWindows(now: Date = new Date()): Promise<{ missed: number; failed: number }> {
  const grace = await loadDeadlineGrace();
  const overdue = await prisma.creatorOffer.findMany({
    // windowTo is an IST day (00:00 UTC): this is "the plain deadline has passed". effectiveLinkDeadline is the exact test (grace).
    where: { status: "accepted", linkVerifiedAt: null, linkSubmittedAt: null, windowTo: { lte: new Date(now.getTime() - DEADLINE_AFTER_WINDOWTO_MS) } },
    orderBy: [{ postMissingAt: { sort: "asc", nulls: "first" } }, { windowTo: "asc" }],
    take: BATCH,
  });
  return closeMissedCandidates(overdue, now, grace);
}

// ── (c) resend an offer email that never went out ──────────────────────────────────────────────

/**
 * Offers with status `offered` and notified_at NULL, older than OFFER_EMAIL.MIN_AGE_MS (the first send is fire-and-forget after
 * approve and must have finished), still open. Each failed retry writes a marker to the booking's history; the wait before the
 * next is OFFER_EMAIL.BACKOFF_MS, and there are at most OFFER_EMAIL.MAX_RETRIES. ⚠️ The pass STOPS at the first mail that fails:
 * every send is a fresh login to the shared Gmail account (it also carries password resets), so an outage costs one attempt a tick.
 */
export async function resendOfferEmails(now: Date = new Date()): Promise<{ resent: number; failed: number }> {
  const cands = await prisma.creatorOffer.findMany({
    where: { status: "offered", notifiedAt: null, expiresAt: { gt: now }, offeredAt: { lte: new Date(now.getTime() - OFFER_EMAIL.MIN_AGE_MS) } },
    orderBy: { offeredAt: "asc" },
    take: BATCH,
  });
  if (cands.length === 0) return { resent: 0, failed: 0 };
  const retries = await retriesOf(cands.map((o) => o.bookingId));
  let resent = 0;
  let failed = 0;
  for (const o of cands) {
    const done = retries.get(o.id) ?? { count: 0, last: null };
    if (done.count >= OFFER_EMAIL.MAX_RETRIES) continue;
    const since = done.last ?? o.offeredAt;
    if (now.getTime() - since.getTime() < OFFER_EMAIL.BACKOFF_MS[done.count]) continue;
    const outcome = await sendOfferEmail(o.id);
    if (outcome === "sent") {
      resent++;
    } else if (outcome === "failed") {
      failed++;
      await logBookingEvent(o.bookingId, { type: "system" }, retryMarker(o.pageName, o.id, done.count + 1)).catch((e) => logFailure("resend-marker", o.id, e));
      break;
    }
  }
  return { resent, failed };
}

/** How many retries of each offer's email have failed so far, and when the last one did (read from the history markers). */
async function retriesOf(bookingIds: string[]): Promise<Map<string, { count: number; last: Date | null }>> {
  const rows = await prisma.campaignBookingEvent.findMany({
    where: { bookingId: { in: [...new Set(bookingIds)] }, note: { contains: RETRY_MARKER_CONTAINS } },
    select: { note: true, createdAt: true },
  });
  const out = new Map<string, { count: number; last: Date | null }>();
  for (const r of rows) {
    const m = RETRY_MARKER_RE.exec(r.note ?? "");
    if (!m) continue;
    const cur = out.get(m[1]) ?? { count: 0, last: null };
    cur.count++;
    if (!cur.last || r.createdAt > cur.last) cur.last = r.createdAt;
    out.set(m[1], cur);
  }
  return out;
}

// ── (d) the launch-day reminder ────────────────────────────────────────────────────────────────

/**
 * One reminder per accepted, unposted offer once its window is open. A creator whose account is not approved gets none (they
 * cannot post or paste a link). ⚠️ A mail the mailer REFUSES stops the whole pass and pauses reminders for REMINDER_PAUSE_MS:
 * every attempt is a fresh login to the shared Gmail account, and retrying every offer every five minutes would hammer it.
 * `now` is the schedule's clock (the 09:00-20:00 IST gate); the pause uses the real clock, so a test with a fixed `now` still
 * gets the pause.
 */
export async function sendLaunchReminders(now: Date = new Date()): Promise<{ reminded: number; failed: number }> {
  const hour = istHour(now);
  if (hour < REMINDER_FROM_HOUR_IST || hour >= REMINDER_TO_HOUR_IST) return { reminded: 0, failed: 0 };
  if (Date.now() < reminderPausedUntil) return { reminded: 0, failed: 0 };
  // The window is two IST calendar days stored as DATEs (00:00 UTC): it is open from IST midnight of the first day
  // (5.5 h before that instant) until IST midnight after the last.
  const open = await prisma.creatorOffer.findMany({
    where: { status: "accepted", linkSubmittedAt: null, windowFrom: { lte: new Date(now.getTime() + 5.5 * HOUR_MS) }, windowTo: { gt: new Date(now.getTime() - 18.5 * HOUR_MS) } },
    orderBy: { windowFrom: "asc" },
    take: BATCH,
  });
  const away = await unavailableCreators(open.map((o) => o.creatorId));
  let reminded = 0;
  let failed = 0;
  for (const o of open) {
    if (away.has(o.creatorId)) continue; // no claim row, no mail: nothing to churn every five minutes
    const note = `Launch-day reminder emailed to the creator for ${o.pageName} (offer ${o.id})`;
    try {
      if (await prisma.campaignBookingEvent.findFirst({ where: { bookingId: o.bookingId, note }, select: { id: true } })) continue;
      // Claim first (the history row IS the claim), send, and give the claim back when the mail did not go out, so a later tick tries again.
      const claim = await prisma.campaignBookingEvent.create({ data: { bookingId: o.bookingId, actorType: "system", note } });
      const outcome = await sendLaunchReminder(o);
      if (outcome === "sent") {
        reminded++;
      } else if (outcome === "failed") {
        await prisma.campaignBookingEvent.deleteMany({ where: { id: claim.id } });
        reminderPausedUntil = Date.now() + REMINDER_PAUSE_MS;
        console.warn(`[creator-offers] a launch-day reminder could not be sent: reminders are paused for ${Math.round(REMINDER_PAUSE_MS / 60_000)} minutes.`);
        break;
      } // "skipped": nobody to mail; the claim stays, so it is not tried again
    } catch (e) {
      failed++;
      logFailure("reminder", o.id, e);
    }
  }
  return { reminded, failed };
}

// ── (e) staff alerts, derived from state ───────────────────────────────────────────────────────

interface Pending {
  kind: StaffAlertKind;
  offer: CreatorOffer;
  /** What to tell staff about THIS page. */
  text: string;
}

const ALERT_SUBJECT: Record<StaffAlertKind, string> = {
  refund: "A creator's post needs a refund",
  missed: "A creator did not post in the window",
  unverified: "A creator's link is waiting for a decision",
  undelivered: "A creator has not been emailed their offer",
};
/**
 * Whether a refund-due creator post is refunded by itself: the payout worker's job 10 (reverse the creator's share, then refund the client) runs
 * only while that worker AND the refund sweep are switched on. The digest says what is true now, so staff are never told to press Refund on a post
 * the worker is already refunding (and never told it is automatic when it is not).
 */
const refundsAreAutomatic = () => creatorConfig.payoutCronEnabled() && refundSweepEnabled();

const REFUND_TODO_AUTO =
  "Nothing to press: the creator's payout is taken back first and the client is then refunded automatically. If a post still reads refund due after an hour, open the campaign: the post's own note says what stopped it (and never also refund it from the Razorpay dashboard).";
const REFUND_TODO_MANUAL = "Automatic refunds are switched off right now (the payout worker or the refund sweep), so nothing is refunded by itself: open the campaign and press Refund on each of these posts.";

function alertTodo(kind: StaffAlertKind): string {
  switch (kind) {
    case "refund":
      return refundsAreAutomatic() ? REFUND_TODO_AUTO : REFUND_TODO_MANUAL;
    case "missed":
      return `A withdrawn post is marked refund due. ${refundsAreAutomatic() ? REFUND_TODO_AUTO : REFUND_TODO_MANUAL}`;
    case "unverified":
      return "The posting window is over. Open the campaign and either verify the creator's link, or withdraw the offer with the submitted link discarded.";
    case "undelivered":
      return "The offer email could not be delivered after several tries. Contact the creator directly, or withdraw the offer. The offer still expires on its own.";
  }
}

/**
 * Send ONE email per (kind, booking) for everything in `pending` that has no marker yet, and write a marker per offer once the
 * mailer took the mail. Returns how many offers were handed to the mailer. A group the shared hourly ceiling (or the
 * key's quiet hour) holds back writes no marker and is simply tried again next tick.
 */
async function sendAlertDigests(pending: Pending[]): Promise<number> {
  if (pending.length === 0) return 0;
  const bookingIds = [...new Set(pending.map((p) => p.offer.bookingId))];
  const marked = new Set(
    (await prisma.campaignBookingEvent.findMany({ where: { bookingId: { in: bookingIds }, note: { in: pending.map((p) => alertMarker(p.kind, p.offer.id)) } }, select: { note: true } })).map((e) => e.note),
  );
  const todo = pending.filter((p) => !marked.has(alertMarker(p.kind, p.offer.id)));
  const groups = new Map<string, Pending[]>();
  for (const p of todo) {
    const key = `${p.kind}:${p.offer.bookingId}`;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  let handed = 0;
  for (const [key, group] of groups) {
    const { kind, offer } = group[0];
    const sent = alertStaffOncePerHour(
      `creator-offers-${key}`,
      ALERT_SUBJECT[kind],
      [
        { label: "Campaign", value: offer.bookingId },
        ...group.map((p) => ({ label: p.offer.pageName, value: p.text })),
        { label: "What to do", value: alertTodo(kind) },
      ],
      `/campaigns/${offer.bookingId}`,
      {
        onSent: async () => {
          for (const p of group) await logBookingEvent(p.offer.bookingId, { type: "system" }, alertMarker(p.kind, p.offer.id));
        },
      },
    );
    if (sent) handed += group.length;
  }
  return handed;
}

/** Offers closed in the last ALERT_LOOKBACK_MS whose post is still owed back, and the ones whose creator did not post. */
async function closedPending(now: Date): Promise<Pending[]> {
  const since = new Date(now.getTime() - ALERT_LOOKBACK_MS);
  const closed = await prisma.creatorOffer.findMany({
    where: {
      status: { in: ["declined", "expired", "withdrawn"] },
      closedReason: { in: ["declined", "expired", "creator_unavailable", "missed_window"] },
      OR: [{ declinedAt: { gte: since } }, { expiredAt: { gte: since } }, { withdrawnAt: { gte: since } }],
    },
    orderBy: { updatedAt: "desc" },
    take: ALERT_SCAN,
  });
  const owed = new Set(
    (await prisma.campaignBookingItem.findMany({ where: { id: { in: closed.map((o) => o.bookingItemId) }, status: "refund_due" }, select: { id: true } })).map((i) => i.id),
  );
  const out: Pending[] = [];
  for (const o of closed) {
    if (!owed.has(o.bookingItemId)) continue; // already refunded (or otherwise settled): nothing for staff to do
    if (o.closedReason === "missed_window") out.push({ kind: "missed", offer: o, text: `${closedOfferText("missed_window")} The offer is withdrawn and the post is marked refund due.` });
    else out.push({ kind: "refund", offer: o, text: closedOfferText(o.closedReason, o.closedReason === "expired" && !o.notifiedAt) });
  }
  // A missed window whose withdraw keeps failing (its payout is past `planned`): the offer is still accepted. Say so, rather than nothing.
  const stuck = await prisma.creatorOffer.findMany({
    where: { status: "accepted", linkVerifiedAt: null, linkSubmittedAt: null, postMissingAt: { gte: since } },
    orderBy: { postMissingAt: "desc" },
    take: BATCH,
  });
  for (const o of stuck) out.push({ kind: "missed", offer: o, text: `${closedOfferText("missed_window")} It could not be withdrawn automatically (look at its payout).` });
  return out;
}

/** Accepted offers with a submitted, unverified link past the posting deadline. Newest first, so a pile of old ones never hides a new one. */
async function unverifiedPending(now: Date): Promise<Pending[]> {
  const grace = await loadDeadlineGrace();
  const rows = await prisma.creatorOffer.findMany({
    where: { status: "accepted", linkVerifiedAt: null, linkSubmittedAt: { not: null }, windowTo: { lte: new Date(now.getTime() - DEADLINE_AFTER_WINDOWTO_MS) } },
    orderBy: { windowTo: "desc" },
    take: ALERT_SCAN,
  });
  const out: Pending[] = [];
  for (const o of rows) {
    const deadline = effectiveLinkDeadline(o, grace);
    if (!deadline || deadline.getTime() > now.getTime()) continue;
    out.push({ kind: "unverified", offer: o, text: `The creator sent a link and the posting window is over; its check was “${o.ownershipCheck ?? "not checked"}”.` });
  }
  return out;
}

/** Offers still open whose creator has not been emailed after ALERT_AFTER_RETRIES failed retries. */
async function undeliveredPending(now: Date): Promise<Pending[]> {
  const rows = await prisma.creatorOffer.findMany({
    where: { status: "offered", notifiedAt: null, expiresAt: { gt: now }, offeredAt: { lte: new Date(now.getTime() - OFFER_EMAIL.MIN_AGE_MS) } },
    orderBy: { offeredAt: "asc" },
    take: BATCH,
  });
  if (rows.length === 0) return [];
  const retries = await retriesOf(rows.map((o) => o.bookingId));
  const away = await unavailableCreators(rows.map((o) => o.creatorId));
  const out: Pending[] = [];
  for (const o of rows) {
    if (away.has(o.creatorId)) continue; // not mailable by design
    const n = retries.get(o.id)?.count ?? 0;
    if (n < OFFER_EMAIL.ALERT_AFTER_RETRIES) continue;
    out.push({ kind: "undelivered", offer: o, text: `The offer email failed ${n} times. The offer expires ${fmtDateTimeIST(o.expiresAt)}.` });
  }
  return out;
}

/**
 * (e) Tell staff, one email per booking per kind, about everything that needs a person and has not been told yet. Each pass is
 * bounded. Returns the number of offers handed to the mailer per kind.
 */
export async function alertPending(now: Date = new Date()): Promise<Record<StaffAlertKind, number>> {
  const out: Record<StaffAlertKind, number> = { refund: 0, missed: 0, unverified: 0, undelivered: 0 };
  const closed = await closedPending(now);
  const sets: Array<[Pending[], StaffAlertKind[]]> = [
    [closed.filter((p) => p.kind === "refund"), ["refund"]],
    [closed.filter((p) => p.kind === "missed"), ["missed"]],
    [await unverifiedPending(now), ["unverified"]],
    [await undeliveredPending(now), ["undelivered"]],
  ];
  for (const [pending, [kind]] of sets) out[kind] = await sendAlertDigests(pending);
  return out;
}

// ── after an outage ────────────────────────────────────────────────────────────────────────────

/**
 * Called by every tick that is allowed to run, BEFORE the closing passes. Reads when the last tick ran; if that is long ago the
 * worker (or the marketplace) was off and creators could not act: every open `offered` offer is extended by the silence (never
 * past the end of its posting window), and a grace window is recorded so a posting deadline that fell inside it moves to just after
 * the worker came back. Then it records this tick. A throw means "do not run the closing passes this tick".
 */
export async function resumeAfterOutage(now: Date): Promise<{ gapMs: number; extended: number } | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: HEARTBEAT_KEY } });
  const last = row ? new Date(row.value) : null;
  let result: { gapMs: number; extended: number } | null = null;
  if (last && Number.isFinite(last.getTime())) {
    const gap = now.getTime() - last.getTime();
    if (gap > GAP_THRESHOLD_MS) {
      const extend = Math.min(gap, GAP_MAX_EXTEND_MS);
      // Open offers are few (every one has a paid post behind it); the bound only keeps a runaway table from loading whole.
      const open = await prisma.creatorOffer.findMany({ where: { status: "offered", expiresAt: { gt: last } }, orderBy: { expiresAt: "asc" }, take: 5000, select: { id: true, expiresAt: true, windowTo: true } });
      let extended = 0;
      for (const o of open) {
        const end = postingWindow(null, o.windowTo).to;
        const target = Math.min(o.expiresAt.getTime() + extend, end?.getTime() ?? Infinity);
        if (target <= o.expiresAt.getTime()) continue;
        const res = await prisma.creatorOffer.updateMany({ where: { id: o.id, status: "offered" }, data: { expiresAt: new Date(target) } });
        extended += res.count;
      }
      await recordDeadlineGrace({ from: last.getTime(), until: now.getTime() + Math.min(gap, GRACE_MAX_MS) }, now);
      console.warn(`[creator-offers] resumed after ${Math.round(gap / 60_000)} minutes without a tick: ${extended} open offer(s) extended, posting deadlines in the gap moved.`);
      result = { gapMs: gap, extended };
    }
  }
  const value = now.toISOString();
  await prisma.systemSetting.upsert({ where: { key: HEARTBEAT_KEY }, create: { key: HEARTBEAT_KEY, value }, update: { value } });
  return result;
}

/** One pass of the jobs. Exported for tests; the scheduler below calls it. Never throws. */
export async function runCreatorOffersTick(opts: { now?: Date } = {}): Promise<OffersTickSummary> {
  if (running) return idle();
  running = true; // claimed before the first await
  const out: OffersTickSummary = { ...idle(), ran: true };
  try {
    if (!creatorConfig.offersCronEnabled() || !creatorConfig.marketplaceAvailable()) return idle();
    const now = opts.now ?? new Date();
    try {
      await resumeAfterOutage(now);
    } catch (e) {
      // Without knowing whether creators were locked out, closing anything could mass-expire real offers.
      out.failed++;
      console.error("[creator-offers] outage check failed, nothing closed this tick:", scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 200));
      return out;
    }
    const pass = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        out.failed++;
        console.error(`[creator-offers] ${name} pass failed:`, scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 200));
      }
    };
    await pass("expiry", async () => {
      const a = await expireDueOffers(now);
      out.expired = a.expired;
      out.failed += a.failed;
    });
    await pass("missed-window", async () => {
      const b = await closeMissedWindows(now);
      out.missed = b.missed;
      out.failed += b.failed;
    });
    await pass("resend", async () => {
      const r = await resendOfferEmails(now);
      out.resent = r.resent;
      out.failed += r.failed;
    });
    await pass("reminder", async () => {
      const c = await sendLaunchReminders(now);
      out.reminded = c.reminded;
      out.failed += c.failed;
    });
    await pass("alert", async () => {
      const d = await alertPending(now);
      out.unverified = d.unverified;
    });
    return out;
  } finally {
    running = false;
  }
}

export function startCreatorOffersCron(): void {
  if (!creatorConfig.offersCronEnabled()) {
    console.warn("[creator-offers] CREATOR_OFFERS_CRON_ENABLED=0: offer expiry, missed-window, email retries and reminders are NOT running.");
    return;
  }
  const tick = () => {
    runCreatorOffersTick()
      .then((s) => {
        if (s.expired || s.missed || s.unverified || s.reminded || s.resent || s.failed) console.log("[creator-offers]", JSON.stringify(s));
      })
      .catch((e) => console.error("[creator-offers] tick failed:", scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 200)));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, TICK_MS);
  }, FIRST_RUN_MS);
}
