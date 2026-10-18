/**
 * The offers worker (payout plan Phase 3): the clock-driven half of a booking offer. Each job is exercised with an explicit
 * `now`, so no test waits for a clock and none depends on the hour it runs at:
 *   (a) EXPIRE        an `offered` offer past its expiry is closed: item refund_due (the share stays held: job 10 of the payout worker takes it back and refunds)
 *   (b) MISSED WINDOW an `accepted` offer with no link at (the window's last IST day + 24 h) is withdrawn
 *   (c) RESEND        an offer whose email never went out is mailed again, with backoff, a bound and a staff alert
 *   (d) REMINDER      one launch-day email to a creator whose accepted offer has no link yet, 09:00-20:00 IST only
 *   (e) STAFF ALERTS  one email per booking, derived from state; a marker is written only once the mailer took the mail
 *   (f) AFTER AN OUTAGE  open offers are extended by the silence and posting deadlines in it move, before anything closes
 * and its switches: dark with the marketplace off, CREATOR_OFFERS_CRON_ENABLED=0, and the overlap guard.
 *
 * Offers are seeded straight into the database (a booking in `approved`, an item, a `held` payout, an offer); the transitions
 * themselves are the real service code. Razorpay is a stub that RECORDS every call: nothing here may ever call it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import { notifyAdminByEmail, sendEmail } from "../src/services/email.service";
import { razorpayHttp } from "../src/services/campaign/razorpay";
import {
  alertPending,
  closeMissedCandidates,
  closeMissedWindows,
  expireCandidates,
  expireDueOffers,
  reminderPausedUntilForTests,
  resendOfferEmails,
  resetCreatorOffersCronForTests,
  resumeAfterOutage,
  runCreatorOffersTick,
  sendLaunchReminders,
  startCreatorOffersCron,
} from "../src/cron/creator-offers.cron";
import { submitOfferLink, loadDeadlineGrace } from "../src/services/creator/creator-offer.service";
import { GRACE_KEY, HEARTBEAT_KEY, OFFER_EMAIL, alertMarker, retryMarker } from "../src/services/creator/creator-offers-config";
import { declineOffer, withdrawOffer } from "../src/services/creator/creator-offer.service";
import { flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let seq = 0;

const razorpayCalls: string[] = [];
const alertSubjects = () => vi.mocked(notifyAdminByEmail).mock.calls.map((c) => String(c[0]));
const mailsTo = (to: string) => vi.mocked(sendEmail).mock.calls.map((c) => c[0] as { to: string; subject: string; html: string }).filter((m) => m.to === to);

const REFUND_ALERT = "A creator's post needs a refund";
const MISSED_ALERT = "A creator did not post in the window";
const UNVERIFIED_ALERT = "A creator's link is waiting for a decision";
const UNDELIVERED_ALERT = "A creator has not been emailed their offer";

/** An IST calendar day as it is stored (a DATE: that day at 00:00 UTC). */
const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
/** The instant an IST wall-clock time falls on. */
const ist = (ymd: string, hhmm: string) => new Date(new Date(`${ymd}T${hhmm}:00.000Z`).getTime() - 5.5 * HOUR);

describe("creator offers worker", () => {
  let clientId: string;

  beforeEach(async () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
    vi.stubEnv("CREATORS_ENABLED", "1");
    vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "1");
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
    vi.stubEnv("CREATOR_OFFERS_CRON_ENABLED", "");
    resetCreatorOffersCronForTests();
    resetPayoutAlertsForTests();
    razorpayCalls.length = 0;
    razorpayHttp.fetch = (async (url: any, init: any) => {
      razorpayCalls.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    vi.mocked(notifyAdminByEmail).mockReset();
    vi.mocked(notifyAdminByEmail).mockImplementation(async () => ({ messageId: "test" }) as never);
    vi.mocked(sendEmail).mockReset();
    vi.mocked(sendEmail).mockImplementation(async () => ({ messageId: "test" }) as never);
    await prisma.systemSetting.deleteMany({ where: { key: { in: [HEARTBEAT_KEY, GRACE_KEY] } } });
    clientId = (await prisma.client.create({ data: { companyName: "Brand A", contactName: "Asha", email: "a@brand.test", passwordHash: "x" } })).id;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    // system_settings is not truncated between tests: the worker's heartbeat and grace must not leak into the next one (or into another file).
    await prisma.systemSetting.deleteMany({ where: { key: { in: [HEARTBEAT_KEY, GRACE_KEY] } } });
  });

  interface SeedOpts {
    status?: "offered" | "accepted";
    expiresAt?: Date;
    /** The window's first and last IST day (YYYY-MM-DD). */
    from?: string;
    to?: string;
    itemStatus?: string;
    payoutStatus?: string;
    /** The creator sent a link (and its check). */
    link?: "auto_ok" | "auto_failed" | "unverifiable";
    verified?: boolean;
    creatorStatus?: string;
    /** Put the offer on an existing booking (one booking holds many creator items). */
    booking?: { id: string };
    offeredAt?: Date;
    /** The offer email went out (default: yes for an offer, as in production when the mailer works). */
    notified?: boolean;
  }

  async function seedOffer(o: SeedOpts = {}) {
    const n = ++seq;
    const status = o.status ?? "offered";
    const creator = await prisma.creator.create({
      data: { email: `creator${n}@creators.test`, passwordHash: "x", name: `Creator ${n}`, status: o.creatorStatus ?? "approved", emailVerifiedAt: new Date() },
    });
    const booking =
      o.booking ??
      (await prisma.campaignBooking.create({
        data: { clientId, name: `Campaign ${n}`, brand: "Brand", status: "approved", format: "post", totalPaise: 250_000, paidAt: new Date(), launchFrom: day(o.from ?? "2026-11-01"), launchTo: day(o.to ?? "2026-11-08") },
      }));
    const card = await prisma.campaignRateCard.create({ data: { targetType: "creator_asset", targetId: crypto.randomUUID(), platform: "instagram", format: "post", pricePaise: 250_000 } });
    const item = await prisma.campaignBookingItem.create({
      data: {
        bookingId: booking.id,
        rateCardId: card.id,
        targetType: "creator_asset",
        targetId: card.targetId,
        platform: "instagram",
        format: "post",
        accountName: `Page ${n}`,
        pricePaise: 250_000,
        status: o.itemStatus ?? (status === "offered" ? "awaiting_creator" : "manual_pending"),
      },
    });
    const payout = await prisma.creatorPayout.create({
      data: {
        bookingId: booking.id,
        bookingItemId: item.id,
        creatorId: creator.id,
        payoutAccountId: crypto.randomUUID(),
        razorpayAccountId: `acc_${n}`,
        razorpayPaymentId: `pay_${n}`,
        status: o.payoutStatus ?? "held", // an offer only exists once its share is held
        itemPricePaise: 250_000,
        shareBps: 4000,
        grossPaise: 100_000,
        amountPaise: 100_000,
      },
    });
    const offer = await prisma.creatorOffer.create({
      data: {
        bookingId: booking.id,
        bookingItemId: item.id,
        creatorId: creator.id,
        creatorAssetId: card.targetId,
        pageName: `Page ${n}`,
        platform: "instagram",
        format: "post",
        status,
        payoutPaise: 100_000,
        windowFrom: day(o.from ?? "2026-11-01"),
        windowTo: day(o.to ?? "2026-11-08"),
        expiresAt: o.expiresAt ?? new Date(Date.now() + DAY),
        ...(o.offeredAt ? { offeredAt: o.offeredAt } : {}),
        notifiedAt: o.notified === false ? null : new Date(),
        acceptedAt: status === "accepted" ? new Date() : null,
        ...(o.link
          ? { linkUrl: `https://www.instagram.com/p/Code${n}/`, linkCanonicalKey: `ig:Code${n}`, linkSubmittedAt: new Date(), ownershipCheck: o.link, ownershipDetail: "x", ownershipCheckedAt: new Date() }
          : {}),
        ...(o.verified ? { linkVerifiedAt: new Date() } : {}),
      },
    });
    return { creator, booking, item, payout, offer };
  }
  type Seeded = Awaited<ReturnType<typeof seedOffer>>;

  const offerOf = (id: string) => prisma.creatorOffer.findUniqueOrThrow({ where: { id } });
  const itemOf = async (s: Seeded) => (await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: s.item.id } })).status;
  const payoutOf = async (s: Seeded) => (await prisma.creatorPayout.findUniqueOrThrow({ where: { id: s.payout.id } })).status;
  const nothingRefunded = async () => {
    expect(razorpayCalls).toEqual([]);
    expect(await prisma.campaignRefund.count()).toBe(0);
  };
  const eventsOf = async (bookingId: string) => (await prisma.campaignBookingEvent.findMany({ where: { bookingId }, orderBy: { createdAt: "asc" } })).map((e) => e.note ?? "");

  // ── (a) expire ────────────────────────────────────────────────────────────────

  describe("expiry", () => {
    it("closes every offer that is `offered` and past its expiry: item refund_due, share left held for the payout worker, staff told; leaves the others alone; calls Razorpay never", async () => {
      const now = new Date();
      const due1 = await seedOffer({ expiresAt: new Date(now.getTime() - 60_000) });
      const due2 = await seedOffer({ expiresAt: new Date(now.getTime() - 3 * HOUR) });
      const notYet = await seedOffer({ expiresAt: new Date(now.getTime() + HOUR) });
      const accepted = await seedOffer({ status: "accepted", expiresAt: new Date(now.getTime() - HOUR) });

      const r = await expireDueOffers(now);
      expect(r).toEqual({ expired: 2, failed: 0 });
      for (const s of [due1, due2]) {
        expect(await offerOf(s.offer.id)).toMatchObject({ status: "expired", closedReason: "expired" });
        expect((await offerOf(s.offer.id)).expiredAt).not.toBeNull();
        expect(await itemOf(s)).toBe("refund_due");
        expect(await payoutOf(s)).toBe("held"); // taking it back is a Razorpay call: the payout worker's job, never this worker's
        expect(await eventsOf(s.booking.id)).toContainEqual(expect.stringContaining("the offer expired"));
      }
      expect((await offerOf(notYet.offer.id)).status).toBe("offered");
      expect(await itemOf(notYet)).toBe("awaiting_creator");
      expect((await offerOf(accepted.offer.id)).status).toBe("accepted"); // an accepted offer never expires
      expect(await itemOf(accepted)).toBe("manual_pending");
      await alertPending(now);
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((s) => s === REFUND_ALERT)).toHaveLength(2);
      await nothingRefunded();
      // A second pass has nothing left to do.
      expect(await expireDueOffers(now)).toEqual({ expired: 0, failed: 0 });
    });

    it("⚠️ one offer that cannot be closed (its payout was already released) stays open and is counted as a failure, and the next offer is still handled", async () => {
      const now = new Date();
      const stuck = await seedOffer({ expiresAt: new Date(now.getTime() - 3 * HOUR), payoutStatus: "released" });
      const fine = await seedOffer({ expiresAt: new Date(now.getTime() - HOUR) });
      const r = await expireDueOffers(now);
      expect(r).toEqual({ expired: 1, failed: 1 });
      expect(await offerOf(stuck.offer.id)).toMatchObject({ status: "offered", closedReason: null });
      expect(await itemOf(stuck)).toBe("awaiting_creator");
      expect(await payoutOf(stuck)).toBe("released");
      expect((await offerOf(fine.offer.id)).status).toBe("expired");
      await nothingRefunded();
    });

    it("accepted offers (whose old expiry is long past) and the batch limit never crowd out a real expiry", async () => {
      const now = new Date();
      // 50 accepted offers with the OLDEST expiry would fill a 50-row batch if the query did not look at `offered` only.
      for (let i = 0; i < 50; i++) await seedOffer({ status: "accepted", expiresAt: new Date(now.getTime() - 10 * DAY - i * 1000) });
      const real = await seedOffer({ expiresAt: new Date(now.getTime() - HOUR) });
      expect(await expireDueOffers(now)).toEqual({ expired: 1, failed: 0 });
      expect((await offerOf(real.offer.id)).status).toBe("expired");
    }, 60_000);

    it("an offer whose item is not where the offer says it is (INVALID_STATE) is a failure to look at, not a race it quietly lost", async () => {
      const now = new Date();
      const odd = await seedOffer({ expiresAt: new Date(now.getTime() - HOUR), itemStatus: "manual_pending" });
      expect(await expireDueOffers(now)).toEqual({ expired: 0, failed: 1 });
      expect((await offerOf(odd.offer.id)).status).toBe("offered");
      expect(await itemOf(odd)).toBe("manual_pending");
    });

    it("⚠️ an offer the creator answered between the worker's read and its close is not a failure and not touched (the race is really lost here: the stale row goes to expireCandidates)", async () => {
      const now = new Date();
      const s = await seedOffer({ expiresAt: new Date(now.getTime() - 1000) });
      // The worker read the offer while it was still `offered` and due ...
      const stale = [{ id: s.offer.id, creatorId: s.creator.id }];
      // ... and the creator accepted before it got to close it.
      await prisma.creatorOffer.update({ where: { id: s.offer.id }, data: { status: "accepted", acceptedAt: new Date() } });
      await prisma.campaignBookingItem.update({ where: { id: s.item.id }, data: { status: "manual_pending" } });
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        expect(await expireCandidates(stale, now)).toEqual({ expired: 0, failed: 0 });
        expect(errors.mock.calls.filter((c) => String(c[0]).startsWith("[creator-offers]"))).toHaveLength(0);
      } finally {
        errors.mockRestore();
      }
      expect(await offerOf(s.offer.id)).toMatchObject({ status: "accepted", closedReason: null });
      expect(await itemOf(s)).toBe("manual_pending");
      expect(await payoutOf(s)).toBe("held");
    });

    it("the negative control: a failure that is NOT a lost race still counts and is logged (an item that is not where its offer says)", async () => {
      const now = new Date();
      const s = await seedOffer({ expiresAt: new Date(now.getTime() - 1000), itemStatus: "manual_pending" });
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        expect(await expireCandidates([{ id: s.offer.id, creatorId: s.creator.id }], now)).toEqual({ expired: 0, failed: 1 });
        expect(errors.mock.calls.filter((c) => String(c[0]).startsWith("[creator-offers]"))).toHaveLength(1);
      } finally {
        errors.mockRestore();
      }
    });
  });

  // ── (b) missed window ─────────────────────────────────────────────────────────

  describe("missed window", () => {
    // The window's last IST day 2026-11-08 ends at 2026-11-09 00:00 IST; the creator has 24 h more to send the link.
    const NOW = ist("2026-11-10", "12:00");

    it("an accepted offer with no link at the window's end + 24 h: staff are alerted ONCE, then it is withdrawn (item refund_due, share left held for the payout worker); nothing is refunded", async () => {
      const missed = await seedOffer({ status: "accepted", from: "2026-11-01", to: "2026-11-08" });
      const inGrace = await seedOffer({ status: "accepted", from: "2026-11-03", to: "2026-11-09" }); // closes 2026-11-10 00:00 IST + 24 h = 11-11 00:00
      const r = await closeMissedWindows(NOW);
      expect(r).toEqual({ missed: 1, failed: 0 });
      expect(await offerOf(missed.offer.id)).toMatchObject({ status: "withdrawn", closedReason: "missed_window", withdrawnById: null });
      expect((await offerOf(missed.offer.id)).postMissingAt).not.toBeNull();
      expect(await itemOf(missed)).toBe("refund_due");
      expect(await payoutOf(missed)).toBe("held");
      expect(await eventsOf(missed.booking.id)).toContainEqual(expect.stringContaining("did not post in the window"));
      await alertPending(NOW);
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((s) => s === MISSED_ALERT)).toHaveLength(1);
      expect(alertSubjects()).not.toContain(REFUND_ALERT); // the missed-window alert already says it
      // Inside the grace: untouched.
      expect(await offerOf(inGrace.offer.id)).toMatchObject({ status: "accepted", postMissingAt: null });
      expect(await itemOf(inGrace)).toBe("manual_pending");
      await nothingRefunded();
      // A second pass does nothing and alerts nobody again (the marker proves the first alert went out).
      expect(await closeMissedWindows(NOW)).toEqual({ missed: 0, failed: 0 });
      await alertPending(NOW);
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((s) => s === MISSED_ALERT)).toHaveLength(1);
      expect((await eventsOf(missed.booking.id)).filter((n) => n === alertMarker("missed", missed.offer.id))).toHaveLength(1);
    });

    it("the deadline is exact: just before it nothing happens, just after it the offer is withdrawn", async () => {
      const s = await seedOffer({ status: "accepted", from: "2026-11-01", to: "2026-11-08" });
      const deadline = ist("2026-11-10", "00:00"); // 2026-11-08's end (11-09 00:00 IST) + 24 h
      expect(await closeMissedWindows(new Date(deadline.getTime() - 1000))).toMatchObject({ missed: 0 });
      expect((await offerOf(s.offer.id)).status).toBe("accepted");
      expect(await closeMissedWindows(new Date(deadline.getTime() + 1000))).toMatchObject({ missed: 1 });
      expect((await offerOf(s.offer.id)).status).toBe("withdrawn");
    });

    it("⚠️ an accepted offer WITH a link that nobody verified is NOT withdrawn: staff are alerted once and decide", async () => {
      const s = await seedOffer({ status: "accepted", link: "auto_failed" });
      const r = await closeMissedWindows(NOW);
      expect(r).toEqual({ missed: 0, failed: 0 });
      expect(await offerOf(s.offer.id)).toMatchObject({ status: "accepted", postMissingAt: null });
      expect(await itemOf(s)).toBe("manual_pending");
      expect(await payoutOf(s)).toBe("held");
      expect((await alertPending(NOW)).unverified).toBe(1);
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((x) => x === UNVERIFIED_ALERT)).toHaveLength(1);
      // Once: the marker (written only because the mailer took the mail) is in the booking's history, so the next pass says nothing.
      expect((await alertPending(NOW)).unverified).toBe(0);
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((x) => x === UNVERIFIED_ALERT)).toHaveLength(1);
      expect((await eventsOf(s.booking.id)).filter((n) => n === alertMarker("unverified", s.offer.id))).toHaveLength(1);
    });

    it("a verified post, a still-offered offer and an offer whose share was already released are never auto-withdrawn", async () => {
      const verified = await seedOffer({ status: "accepted", link: "auto_ok", verified: true, itemStatus: "posted_manual" });
      const offered = await seedOffer({ status: "offered" });
      await prisma.creatorOffer.update({ where: { id: offered.offer.id }, data: { windowTo: day("2026-11-01"), windowFrom: day("2026-10-25") } });
      expect(await closeMissedWindows(NOW)).toEqual({ missed: 0, failed: 0 });
      expect((await offerOf(verified.offer.id)).status).toBe("accepted");
      expect((await offerOf(offered.offer.id)).status).toBe("offered");
      // A payout that has already been released cannot be taken back by this worker: the offer stays, the failure is counted, and staff are told so.
      const held = await seedOffer({ status: "accepted", payoutStatus: "released" });
      const r = await closeMissedWindows(NOW);
      expect(r).toMatchObject({ missed: 0, failed: 1 });
      expect((await alertPending(NOW)).missed).toBe(1);
      await flushPayoutAlertsForTests();
      // The withdraw is retried every tick, the staff alert is not: its marker is written once the mailer took it, even when
      // the hour's quiet period has passed in between.
      resetPayoutAlertsForTests();
      expect(await closeMissedWindows(NOW)).toMatchObject({ missed: 0, failed: 1 });
      expect((await alertPending(NOW)).missed).toBe(0);
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((x) => x === MISSED_ALERT)).toHaveLength(1);
      const stuckAlert = vi.mocked(notifyAdminByEmail).mock.calls.find((c) => c[0] === MISSED_ALERT)!;
      expect(stuckAlert[1].map((d: any) => d.value).join(" ")).toMatch(/could not be withdrawn automatically/);
      expect((await offerOf(held.offer.id)).postMissingAt).not.toBeNull();
      expect(await offerOf(held.offer.id)).toMatchObject({ status: "accepted" });
      expect(await payoutOf(held)).toBe("released");
      await nothingRefunded();
    });
  });

  describe("missed window: nothing that stays in its result set can starve a real one", () => {
    const NOW = ist("2026-11-10", "12:00");

    it("⚠️ 50 offers whose creator DID send a link (they stay in the set while staff decide) cannot crowd out a real missed window", async () => {
      for (let i = 0; i < 50; i++) await seedOffer({ status: "accepted", from: "2026-10-01", to: "2026-10-08", link: "auto_failed" }); // the OLDEST windows
      const real = await seedOffer({ status: "accepted", from: "2026-11-01", to: "2026-11-08" });
      expect(await closeMissedWindows(NOW)).toEqual({ missed: 1, failed: 0 });
      expect(await offerOf(real.offer.id)).toMatchObject({ status: "withdrawn", closedReason: "missed_window" });
      expect(await itemOf(real)).toBe("refund_due");
    }, 60_000);

    it("⚠️ 50 offers whose withdraw keeps failing (a payout already released) fall BEHIND fresh ones after their first try, so they cannot starve a fresh one for ever", async () => {
      for (let i = 0; i < 50; i++) await seedOffer({ status: "accepted", from: "2026-10-01", to: "2026-10-08", payoutStatus: "released" });
      const fresh = await seedOffer({ status: "accepted", from: "2026-11-01", to: "2026-11-08" });
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined); // 99 expected failures: keep the log readable
      try {
        // The first tick fills its batch with the 50 oldest (all fail, all get post_missing_at) ...
        expect(await closeMissedWindows(NOW)).toEqual({ missed: 0, failed: 50 });
        expect((await offerOf(fresh.offer.id)).status).toBe("accepted");
        // ... and from the second tick on, the never-tried one goes first.
        expect(await closeMissedWindows(NOW)).toEqual({ missed: 1, failed: 49 });
      } finally {
        errors.mockRestore();
      }
      expect(await offerOf(fresh.offer.id)).toMatchObject({ status: "withdrawn", closedReason: "missed_window" });
    }, 60_000);

    it("⚠️ a link that arrives between the worker's read and its close is a lost race (not a failure, nothing withdrawn, no false 'did not post' stamp), for a submitted and for a verified link", async () => {
      const submitted = await seedOffer({ status: "accepted" });
      const verified = await seedOffer({ status: "accepted", itemStatus: "manual_pending" });
      const stale = [submitted.offer, verified.offer]; // read while both still had NO link
      await prisma.creatorOffer.update({ where: { id: submitted.offer.id }, data: { linkUrl: "https://www.instagram.com/p/Late1/", linkCanonicalKey: "ig:Late1", linkSubmittedAt: new Date(), ownershipCheck: "auto_ok" } });
      await prisma.creatorOffer.update({ where: { id: verified.offer.id }, data: { linkUrl: "https://www.instagram.com/p/Late2/", linkCanonicalKey: "ig:Late2", linkSubmittedAt: new Date(), ownershipCheck: "auto_ok", linkVerifiedAt: new Date() } });
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        expect(await closeMissedCandidates(stale, NOW, [])).toEqual({ missed: 0, failed: 0 });
        expect(errors.mock.calls.filter((c) => String(c[0]).startsWith("[creator-offers]"))).toHaveLength(0);
      } finally {
        errors.mockRestore();
      }
      for (const s of [submitted, verified]) {
        expect(await offerOf(s.offer.id)).toMatchObject({ status: "accepted", postMissingAt: null });
        expect(await itemOf(s)).toBe("manual_pending");
        expect(await payoutOf(s)).toBe("held");
      }
    });

    it("⚠️ a suspended creator's offers that run out are closed as `creator_unavailable` and SAY so: they are not blamed for a miss they could not have avoided", async () => {
      const exp = await seedOffer({ creatorStatus: "suspended", expiresAt: new Date(NOW.getTime() - HOUR) });
      const miss = await seedOffer({ status: "accepted", creatorStatus: "suspended", from: "2026-11-01", to: "2026-11-08" });
      const fine = await seedOffer({ status: "accepted", from: "2026-11-01", to: "2026-11-08" });
      expect(await expireDueOffers(NOW)).toEqual({ expired: 1, failed: 0 });
      expect(await closeMissedWindows(NOW)).toEqual({ missed: 2, failed: 0 });
      expect(await offerOf(exp.offer.id)).toMatchObject({ status: "expired", closedReason: "creator_unavailable" });
      expect(await offerOf(miss.offer.id)).toMatchObject({ status: "withdrawn", closedReason: "creator_unavailable" });
      expect(await offerOf(fine.offer.id)).toMatchObject({ status: "withdrawn", closedReason: "missed_window" });
      for (const x of [exp, miss]) {
        const row = await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: x.item.id } });
        expect(row.status).toBe("refund_due");
        expect(row.lastError).toMatch(/suspended or closed/);
        expect(row.lastError).not.toMatch(/didn't post|didn't respond/);
      }
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: fine.item.id } })).lastError).toMatch(/didn't post/);
      await alertPending(NOW);
      await flushPayoutAlertsForTests();
      // The two suspended creators' posts are "needs a refund" alerts that say why; the ordinary miss is the missed-window alert.
      const refundBodies = vi.mocked(notifyAdminByEmail).mock.calls.filter((c) => c[0] === REFUND_ALERT).map((c) => c[1].map((d: any) => d.value).join(" "));
      expect(refundBodies).toHaveLength(2);
      for (const b of refundBodies) expect(b).toMatch(/suspended or closed/);
      expect(alertSubjects().filter((x) => x === MISSED_ALERT)).toHaveLength(1);
    });
  });

  // ── (c) resend an offer email that never went out ─────────────────────────────

  describe("resend an offer email that never went out", () => {
    const offerMails = (email: string) => mailsTo(email).filter((m) => /booking offer/i.test(m.subject));
    const failOfferMail = () => vi.mocked(sendEmail).mockImplementation(async (m: any) => (/booking offer/i.test(m.subject) ? (null as never) : ({ messageId: "ok" } as never)));
    const retryNotes = async (x: Seeded) => (await eventsOf(x.booking.id)).filter((n) => n.includes("could not be sent (offer "));
    /** Pretend retry k failed at `at` (the marker's own clock is the real one; the worker's `now` is injected). */
    const stamp = (x: Seeded, k: number, at: Date) => prisma.campaignBookingEvent.updateMany({ where: { bookingId: x.booking.id, note: { contains: `retry ${k})` } }, data: { createdAt: at } });
    const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

    it("mails an offer whose first email never went out, stamps notified_at, and never mails it again", async () => {
      const now = new Date();
      const s = await seedOffer({ notified: false, offeredAt: new Date(now.getTime() - 11 * 60_000), expiresAt: new Date(now.getTime() + 2 * DAY) });
      expect(await resendOfferEmails(now)).toEqual({ resent: 1, failed: 0 });
      expect((await offerOf(s.offer.id)).notifiedAt).not.toBeNull();
      expect(offerMails(s.creator.email)).toHaveLength(1);
      expect(offerMails(s.creator.email)[0].subject).toContain("₹1,000");
      for (const never of ["2,500", "Brand A", "a@brand.test", "Asha"]) expect(offerMails(s.creator.email)[0].html).not.toContain(never);
      expect(await resendOfferEmails(now)).toEqual({ resent: 0, failed: 0 });
      expect(offerMails(s.creator.email)).toHaveLength(1);
    });

    it("leaves alone an offer younger than 10 minutes (the first send may still be running), an expired one, an accepted one and one whose creator is suspended; no marker for those", async () => {
      const now = new Date();
      const young = await seedOffer({ notified: false, offeredAt: new Date(now.getTime() - 9 * 60_000), expiresAt: new Date(now.getTime() + DAY) });
      const expired = await seedOffer({ notified: false, offeredAt: new Date(now.getTime() - 3 * HOUR), expiresAt: new Date(now.getTime() - HOUR) });
      const accepted = await seedOffer({ status: "accepted", notified: false, offeredAt: new Date(now.getTime() - 3 * HOUR) });
      const suspended = await seedOffer({ notified: false, creatorStatus: "suspended", offeredAt: new Date(now.getTime() - 3 * HOUR), expiresAt: new Date(now.getTime() + DAY) });
      expect(await resendOfferEmails(now)).toEqual({ resent: 0, failed: 0 });
      for (const x of [young, expired, accepted, suspended]) expect(mailsTo(x.creator.email), x.offer.id).toHaveLength(0);
      for (const x of [young, expired, accepted, suspended]) expect(await retryNotes(x)).toEqual([]);
      // At the 10-minute edge the young one is mailed (the others still are not).
      expect(await resendOfferEmails(new Date(now.getTime() + 2 * 60_000))).toEqual({ resent: 1, failed: 0 });
      expect(offerMails(young.creator.email)).toHaveLength(1);
      expect(mailsTo(suspended.creator.email)).toHaveLength(0);
    });

    it("⚠️ a failed retry is written to the booking's history and backs off (10 min, 30 min, 2 h, 6 h, 12 h), at most 5 retries: after that nothing, however long the wait", async () => {
      failOfferMail();
      const warn = quiet();
      try {
        const t0 = Date.now();
        const s = await seedOffer({ notified: false, offeredAt: new Date(t0 - 11 * 60_000), expiresAt: new Date(t0 + 30 * DAY) });
        const tries = () => offerMails(s.creator.email).length;
        expect(await resendOfferEmails(new Date(t0))).toEqual({ resent: 0, failed: 1 });
        expect(tries()).toBe(1);
        expect(await retryNotes(s)).toEqual([expect.stringContaining("retry 1)")]);
        expect((await offerOf(s.offer.id)).notifiedAt).toBeNull(); // not delivered: NULL is the state
        expect(await resendOfferEmails(new Date(t0 + 5 * 60_000))).toEqual({ resent: 0, failed: 0 }); // inside the backoff: not even tried
        expect(tries()).toBe(1);
        let t = t0;
        for (let k = 1; k < OFFER_EMAIL.MAX_RETRIES; k++) {
          await stamp(s, k, new Date(t)); // retry k failed at t
          const wait = OFFER_EMAIL.BACKOFF_MS[k];
          expect(await resendOfferEmails(new Date(t + wait - 60_000)), `before retry ${k + 1}`).toEqual({ resent: 0, failed: 0 });
          expect(tries()).toBe(k);
          t += wait + 1000;
          expect(await resendOfferEmails(new Date(t)), `retry ${k + 1}`).toEqual({ resent: 0, failed: 1 });
          expect(tries()).toBe(k + 1);
        }
        await stamp(s, OFFER_EMAIL.MAX_RETRIES, new Date(t));
        expect(tries()).toBe(OFFER_EMAIL.MAX_RETRIES);
        expect(await retryNotes(s)).toHaveLength(OFFER_EMAIL.MAX_RETRIES);
        expect(await resendOfferEmails(new Date(t + 10 * DAY))).toEqual({ resent: 0, failed: 0 }); // the bound
        expect(tries()).toBe(OFFER_EMAIL.MAX_RETRIES);
      } finally {
        warn.mockRestore();
      }
    });

    it("a retry that finally succeeds stamps notified_at and the retries stop", async () => {
      failOfferMail();
      const t0 = Date.now();
      const s = await seedOffer({ notified: false, offeredAt: new Date(t0 - 11 * 60_000), expiresAt: new Date(t0 + 5 * DAY) });
      expect(await resendOfferEmails(new Date(t0))).toEqual({ resent: 0, failed: 1 });
      await stamp(s, 1, new Date(t0));
      vi.mocked(sendEmail).mockImplementation(async () => ({ messageId: "ok" }) as never);
      expect(await resendOfferEmails(new Date(t0 + 31 * 60_000))).toEqual({ resent: 1, failed: 0 });
      expect((await offerOf(s.offer.id)).notifiedAt).not.toBeNull();
      expect(await resendOfferEmails(new Date(t0 + 10 * HOUR))).toEqual({ resent: 0, failed: 0 });
      expect(offerMails(s.creator.email)).toHaveLength(2); // one failed attempt, one that went out
    });

    it("⚠️ stops at the FIRST mail that fails in a tick: an SMTP outage costs one login a tick, not one per offer", async () => {
      failOfferMail();
      const now = new Date();
      for (let i = 0; i < 3; i++) await seedOffer({ notified: false, offeredAt: new Date(now.getTime() - HOUR + i * 1000), expiresAt: new Date(now.getTime() + DAY) });
      const warn = quiet();
      try {
        expect(await resendOfferEmails(now)).toEqual({ resent: 0, failed: 1 });
      } finally {
        warn.mockRestore();
      }
      expect(vi.mocked(sendEmail).mock.calls.filter((c) => /booking offer/i.test((c[0] as { subject: string }).subject))).toHaveLength(1);
    });

    it("⚠️ after three failed retries staff are told ONCE (one email per booking), while there is still time to ring the creator; two failures say nothing", async () => {
      const now = new Date();
      const s = await seedOffer({ notified: false, offeredAt: new Date(now.getTime() - 3 * HOUR), expiresAt: new Date(now.getTime() + 2 * DAY) });
      const note = (n: number) => prisma.campaignBookingEvent.create({ data: { bookingId: s.booking.id, actorType: "system", note: retryMarker(s.offer.pageName, s.offer.id, n) } });
      await note(1);
      await note(2);
      expect((await alertPending(now)).undelivered).toBe(0);
      await note(3);
      expect((await alertPending(now)).undelivered).toBe(1);
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((x) => x === UNDELIVERED_ALERT)).toHaveLength(1);
      const body = vi.mocked(notifyAdminByEmail).mock.calls.find((c) => c[0] === UNDELIVERED_ALERT)![1].map((d: any) => `${d.label} ${d.value}`).join(" ");
      expect(body).toContain(s.offer.pageName);
      expect(body).toMatch(/failed 3 times/);
      resetPayoutAlertsForTests(); // an hour on: the marker, not the quiet hour, keeps it from going out again
      expect((await alertPending(now)).undelivered).toBe(0); // the marker went in once the mailer took the alert
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((x) => x === UNDELIVERED_ALERT)).toHaveLength(1);
      expect((await eventsOf(s.booking.id)).filter((n) => n === alertMarker("undelivered", s.offer.id))).toHaveLength(1);
      // The offer is left alone: its expiry clock keeps running.
      expect((await offerOf(s.offer.id)).status).toBe("offered");
    });

    it("the tick runs it and reports it", async () => {
      const now = new Date();
      const s = await seedOffer({ notified: false, offeredAt: new Date(now.getTime() - HOUR), expiresAt: new Date(now.getTime() + DAY) });
      const r = await runCreatorOffersTick({ now });
      expect(r).toMatchObject({ ran: true, resent: 1, failed: 0 });
      expect((await offerOf(s.offer.id)).notifiedAt).not.toBeNull();
    });
  });

  // ── (e) staff alerts ──────────────────────────────────────────────────────────

  describe("staff alerts: one per booking, marked done only once the mailer took them, never lost", () => {
    const NOW = ist("2026-11-10", "12:00");

    it("⚠️ 15 offers of ONE booking that expire together are ONE email naming all 15 pages (not 15 alerts against the shared hourly ceiling)", async () => {
      const first = await seedOffer({ expiresAt: new Date(NOW.getTime() - HOUR) });
      const all = [first];
      for (let i = 0; i < 14; i++) all.push(await seedOffer({ booking: first.booking, expiresAt: new Date(NOW.getTime() - HOUR) }));
      expect(await expireDueOffers(NOW)).toEqual({ expired: 15, failed: 0 });
      expect((await alertPending(NOW)).refund).toBe(15);
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((x) => x === REFUND_ALERT)).toHaveLength(1);
      const labels = vi.mocked(notifyAdminByEmail).mock.calls.find((c) => c[0] === REFUND_ALERT)![1].map((d: any) => d.label);
      for (const x of all) expect(labels).toContain(x.offer.pageName);
      expect((await eventsOf(first.booking.id)).filter((n) => n.startsWith("Staff alerted [refund]"))).toHaveLength(15);
      expect((await alertPending(NOW)).refund).toBe(0);
    }, 60_000);

    it("⚠️ a mailer that is down leaves NO marker, so the next pass sends the alert again; once the mailer took it, never again", async () => {
      const s = await seedOffer({ expiresAt: new Date(NOW.getTime() - HOUR) });
      await expireDueOffers(NOW);
      vi.mocked(notifyAdminByEmail).mockImplementation(async () => null as never); // SMTP down: the mailer never took it
      expect((await alertPending(NOW)).refund).toBe(1);
      await flushPayoutAlertsForTests();
      expect((await eventsOf(s.booking.id)).some((n) => n.startsWith("Staff alerted"))).toBe(false);
      vi.mocked(notifyAdminByEmail).mockImplementation(async () => ({ messageId: "ok" }) as never);
      expect((await alertPending(NOW)).refund).toBe(1); // tried again (the failed attempt released its quiet hour)
      await flushPayoutAlertsForTests();
      expect((await eventsOf(s.booking.id)).filter((n) => n === alertMarker("refund", s.offer.id))).toHaveLength(1);
      resetPayoutAlertsForTests(); // an hour on: it is the MARKER (not the mailer's quiet hour) that keeps it from going out again
      expect((await alertPending(NOW)).refund).toBe(0);
      expect(vi.mocked(notifyAdminByEmail).mock.calls.filter((c) => c[0] === REFUND_ALERT)).toHaveLength(2);
    });

    it("⚠️ the shared hourly ceiling never drops an alert for good: 14 bookings, 12 go out, the other 2 follow in the next hour", async () => {
      const all: Seeded[] = [];
      for (let i = 0; i < 14; i++) all.push(await seedOffer({ expiresAt: new Date(NOW.getTime() - HOUR) }));
      expect(await expireDueOffers(NOW)).toEqual({ expired: 14, failed: 0 });
      expect((await alertPending(NOW)).refund).toBe(12);
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((x) => x === REFUND_ALERT)).toHaveLength(12);
      resetPayoutAlertsForTests(); // an hour later
      expect((await alertPending(NOW)).refund).toBe(2);
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((x) => x === REFUND_ALERT)).toHaveLength(14);
      let marked = 0;
      for (const x of all) marked += (await eventsOf(x.booking.id)).filter((n) => n === alertMarker("refund", x.offer.id)).length;
      expect(marked).toBe(14);
    }, 60_000);

    it("a creator who declines tells staff at once (and the marker goes in), so the worker does not tell them again; a refunded or staff-withdrawn post needs no alert", async () => {
      const dec = await seedOffer();
      await declineOffer(dec.creator.id, dec.offer.id, "no thanks", NOW);
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((x) => x === REFUND_ALERT)).toHaveLength(1);
      expect((await eventsOf(dec.booking.id)).filter((n) => n === alertMarker("refund", dec.offer.id))).toHaveLength(1);
      const refunded = await seedOffer({ expiresAt: new Date(NOW.getTime() - HOUR) });
      await expireDueOffers(NOW);
      await prisma.campaignBookingItem.update({ where: { id: refunded.item.id }, data: { status: "refunded" } }); // staff refunded it before any alert
      const byStaff = await seedOffer();
      await withdrawOffer(byStaff.offer.id, { staffId: crypto.randomUUID(), now: NOW });
      expect((await alertPending(NOW)).refund).toBe(0);
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((x) => x === REFUND_ALERT)).toHaveLength(1);
    });

    it("an offer the creator declined whose immediate alert was lost is picked up by the worker's pass", async () => {
      vi.mocked(notifyAdminByEmail).mockImplementation(async () => null as never);
      const dec = await seedOffer();
      await declineOffer(dec.creator.id, dec.offer.id, null, NOW);
      await flushPayoutAlertsForTests();
      expect((await eventsOf(dec.booking.id)).some((n) => n.startsWith("Staff alerted"))).toBe(false);
      vi.mocked(notifyAdminByEmail).mockImplementation(async () => ({ messageId: "ok" }) as never);
      resetPayoutAlertsForTests();
      expect((await alertPending(NOW)).refund).toBe(1);
      await flushPayoutAlertsForTests();
      expect((await eventsOf(dec.booking.id)).filter((n) => n === alertMarker("refund", dec.offer.id))).toHaveLength(1);
    });
  });

  // ── (f) after an outage ───────────────────────────────────────────────────────

  describe("after an outage (the marketplace off, the worker off, the API down): nothing is mass-expired or mass-withdrawn for time creators were locked out of", () => {
    const NOW = ist("2026-11-10", "12:00");
    const setHeartbeat = (at: Date) => prisma.systemSetting.upsert({ where: { key: HEARTBEAT_KEY }, create: { key: HEARTBEAT_KEY, value: at.toISOString() }, update: { value: at.toISOString() } });
    const heartbeat = async () => (await prisma.systemSetting.findUnique({ where: { key: HEARTBEAT_KEY } }))?.value ?? null;
    const err = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

    it("a tick records itself; a normal gap (the last tick 10 minutes ago) and a first run (no heartbeat) change nothing", async () => {
      const o = await seedOffer({ expiresAt: new Date(NOW.getTime() + HOUR), to: "2026-11-10" });
      expect(await resumeAfterOutage(NOW)).toBeNull(); // no heartbeat yet
      expect(await heartbeat()).toBe(NOW.toISOString());
      await setHeartbeat(new Date(NOW.getTime() - 10 * 60_000));
      expect(await resumeAfterOutage(NOW)).toBeNull();
      expect((await offerOf(o.offer.id)).expiresAt.getTime()).toBe(NOW.getTime() + HOUR);
      expect(await loadDeadlineGrace()).toEqual([]);
      expect(await heartbeat()).toBe(NOW.toISOString());
    });

    it("⚠️ after hours of silence, offers that fell due DURING it are extended by the silence and are NOT expired on the resume tick; one that fell due before it is", async () => {
      await setHeartbeat(new Date(NOW.getTime() - 5 * HOUR));
      const during = await seedOffer({ expiresAt: new Date(NOW.getTime() - 2 * HOUR), to: "2026-11-20" });
      const later = await seedOffer({ expiresAt: new Date(NOW.getTime() + 10 * HOUR), to: "2026-11-20" });
      const before = await seedOffer({ expiresAt: new Date(NOW.getTime() - 6 * HOUR), to: "2026-11-20" }); // due before the silence began: the last tick should have had it
      const w = err();
      let s;
      try {
        s = await runCreatorOffersTick({ now: NOW });
      } finally {
        w.mockRestore();
      }
      expect(s).toMatchObject({ ran: true, expired: 1, failed: 0 });
      expect(await offerOf(during.offer.id)).toMatchObject({ status: "offered" });
      expect((await offerOf(during.offer.id)).expiresAt.getTime()).toBe(NOW.getTime() + 3 * HOUR); // -2h + the 5h of silence
      expect((await offerOf(later.offer.id)).expiresAt.getTime()).toBe(NOW.getTime() + 15 * HOUR);
      expect((await offerOf(before.offer.id)).status).toBe("expired");
      expect(await itemOf(during)).toBe("awaiting_creator");
      expect(await heartbeat()).toBe(NOW.toISOString());
    });

    it("an extension never goes past the end of the posting window", async () => {
      await setHeartbeat(new Date(NOW.getTime() - 20 * HOUR));
      const o = await seedOffer({ expiresAt: new Date(NOW.getTime() - 2 * HOUR), from: "2026-11-01", to: "2026-11-10" }); // the window ends 2026-11-11 00:00 IST = NOW + 11.5 h
      const w = err();
      try {
        await resumeAfterOutage(NOW);
      } finally {
        w.mockRestore();
      }
      expect((await offerOf(o.offer.id)).expiresAt.getTime()).toBe(ist("2026-11-11", "00:00").getTime());
    });

    it("an outage longer than a week extends by a week at most (a three-week switch-off does not revive three-week-old offers)", async () => {
      await setHeartbeat(new Date(NOW.getTime() - 20 * DAY));
      const o = await seedOffer({ expiresAt: new Date(NOW.getTime() - 19 * DAY), from: "2026-10-01", to: "2026-11-30" });
      const w = err();
      try {
        const r = await resumeAfterOutage(NOW);
        expect(r).toMatchObject({ extended: 1 });
      } finally {
        w.mockRestore();
      }
      expect((await offerOf(o.offer.id)).expiresAt.getTime()).toBe(NOW.getTime() - 19 * DAY + 7 * DAY);
    });

    it("⚠️ an accepted offer whose posting deadline fell in the silence can still take its link and is not withdrawn on the resume tick; once the grace has passed it is", async () => {
      // The window's last day is 2026-11-08: the deadline is 2026-11-10 00:00 IST, twelve hours before NOW.
      const s = await seedOffer({ status: "accepted", from: "2026-11-01", to: "2026-11-08" });
      const url = "https://www.instagram.com/p/GraceOne/";
      // Without the grace the deadline has passed: the creator is locked out (the control).
      await expect(submitOfferLink(s.creator.id, s.offer.id, url, NOW)).rejects.toMatchObject({ code: "POSTING_CLOSED" });
      await setHeartbeat(new Date(NOW.getTime() - 20 * HOUR));
      const w = err();
      let tick;
      try {
        tick = await runCreatorOffersTick({ now: NOW });
      } finally {
        w.mockRestore();
      }
      expect(tick).toMatchObject({ ran: true, missed: 0, failed: 0 });
      expect(await offerOf(s.offer.id)).toMatchObject({ status: "accepted", postMissingAt: null });
      expect(await itemOf(s)).toBe("manual_pending");
      const grace = await loadDeadlineGrace();
      expect(grace).toEqual([{ from: NOW.getTime() - 20 * HOUR, until: NOW.getTime() + 20 * HOUR }]);
      // The creator can send the link now.
      const sent = await submitOfferLink(s.creator.id, s.offer.id, url, NOW);
      expect(sent.check).toBe("unverifiable"); // (no page to read in this seed: a person decides)
      expect((await offerOf(s.offer.id)).linkSubmittedAt).not.toBeNull();
      // A second offer with NO link: not withdrawn inside the grace, withdrawn after it.
      const quiet = await seedOffer({ status: "accepted", from: "2026-11-01", to: "2026-11-08" });
      expect(await closeMissedWindows(new Date(NOW.getTime() + 19 * HOUR))).toEqual({ missed: 0, failed: 0 });
      expect((await offerOf(quiet.offer.id)).status).toBe("accepted");
      expect(await closeMissedWindows(new Date(NOW.getTime() + 21 * HOUR))).toEqual({ missed: 1, failed: 0 });
      expect((await offerOf(quiet.offer.id)).status).toBe("withdrawn");
    });

    it("⚠️ the marketplace switched off for hours and back on: the offer that fell due meanwhile is still open and still acceptable", async () => {
      const t0 = ist("2026-11-10", "09:00");
      const o = await seedOffer({ expiresAt: new Date(t0.getTime() + HOUR), to: "2026-11-20" });
      const w = err();
      try {
        expect(await runCreatorOffersTick({ now: t0 })).toMatchObject({ ran: true, expired: 0 }); // on: records its heartbeat
        vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "0");
        expect((await runCreatorOffersTick({ now: new Date(t0.getTime() + 3 * HOUR) })).ran).toBe(false); // off for hours: nothing runs, no heartbeat
        vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "1");
        const back = new Date(t0.getTime() + 6 * HOUR);
        expect(await runCreatorOffersTick({ now: back })).toMatchObject({ ran: true, expired: 0, failed: 0 });
        expect(await offerOf(o.offer.id)).toMatchObject({ status: "offered" });
        expect((await offerOf(o.offer.id)).expiresAt.getTime()).toBe(t0.getTime() + HOUR + 6 * HOUR);
      } finally {
        w.mockRestore();
      }
    });

    it("⚠️ if the outage check itself cannot run, NOTHING is closed this tick (not knowing is not a licence to expire)", async () => {
      const o = await seedOffer({ expiresAt: new Date(NOW.getTime() - HOUR) });
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await prisma.$executeRawUnsafe("ALTER TABLE system_settings RENAME TO system_settings_renamed_for_test");
      try {
        const s = await runCreatorOffersTick({ now: NOW });
        expect(s).toMatchObject({ ran: true, expired: 0, missed: 0, failed: 1 });
      } finally {
        await prisma.$executeRawUnsafe("ALTER TABLE system_settings_renamed_for_test RENAME TO system_settings");
        errors.mockRestore();
      }
      expect((await offerOf(o.offer.id)).status).toBe("offered");
      // And the next tick, with the table back, is the normal one.
      expect((await runCreatorOffersTick({ now: NOW })).expired).toBe(1);
    });
  });

  // ── (d) the launch-day reminder ───────────────────────────────────────────────

  describe("launch-day reminder", () => {
    // Inside the window 2026-11-01 .. 2026-11-08, at 10:00 IST.
    const OPEN = ist("2026-11-03", "10:00");

    it("emails the creator ONCE with the amount, the deadline and the disclosure line, and records it in the booking's history", async () => {
      const s = await seedOffer({ status: "accepted" });
      const r = await sendLaunchReminders(OPEN);
      expect(r).toEqual({ reminded: 1, failed: 0 });
      const mail = mailsTo(s.creator.email);
      expect(mail).toHaveLength(1);
      expect(mail[0].subject).toBe(`Reminder: post for ${s.offer.pageName}`);
      for (const must of ["₹1,000", "8 Nov 2026", "Paid partnership", s.offer.pageName, s.offer.id]) expect(mail[0].html).toContain(must);
      for (const never of ["2,500", "Brand A", "a@brand.test", "Asha"]) expect(mail[0].html).not.toContain(never);
      expect(await eventsOf(s.booking.id)).toContainEqual(expect.stringContaining("Launch-day reminder emailed"));
      expect(await sendLaunchReminders(OPEN)).toEqual({ reminded: 0, failed: 0 });
      expect(await sendLaunchReminders(ist("2026-11-04", "10:00"))).toEqual({ reminded: 0, failed: 0 }); // never a second one
      expect(mailsTo(s.creator.email)).toHaveLength(1);
    });

    it("only between 09:00 and 20:00 IST, only once the window is open and before it closes, only for an accepted offer with no link", async () => {
      const s = await seedOffer({ status: "accepted" });
      for (const t of [ist("2026-11-03", "08:59"), ist("2026-11-03", "20:00"), ist("2026-11-03", "03:00")]) {
        expect(await sendLaunchReminders(t)).toEqual({ reminded: 0, failed: 0 });
      }
      expect(await sendLaunchReminders(ist("2026-10-31", "10:00"))).toEqual({ reminded: 0, failed: 0 }); // the window has not opened
      expect(await sendLaunchReminders(ist("2026-11-09", "10:00"))).toEqual({ reminded: 0, failed: 0 }); // the window is over
      expect(mailsTo(s.creator.email)).toHaveLength(0);
      expect(await sendLaunchReminders(ist("2026-11-03", "09:00"))).toEqual({ reminded: 1, failed: 0 });

      const offered = await seedOffer({ status: "offered" });
      const linked = await seedOffer({ status: "accepted", link: "auto_ok" });
      const r = await sendLaunchReminders(ist("2026-11-03", "12:00"));
      expect(r.reminded).toBe(0);
      expect(mailsTo(offered.creator.email)).toHaveLength(0);
      expect(mailsTo(linked.creator.email)).toHaveLength(0);
    });

    it("⚠️ a mail the mailer refuses stops the pass and pauses reminders (the shared mailbox is not hammered): ONE attempt, the claim is given back, nothing is tried inside the pause, and the next pass after it retries", async () => {
      const a = await seedOffer({ status: "accepted" });
      const b = await seedOffer({ status: "accepted" });
      vi.mocked(sendEmail).mockImplementation(async () => null as never); // SMTP not configured / refused / throttled
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        expect(await sendLaunchReminders(OPEN)).toEqual({ reminded: 0, failed: 0 });
      } finally {
        warn.mockRestore();
      }
      expect(vi.mocked(sendEmail)).toHaveBeenCalledTimes(1); // b was not even tried: no 50 failing logins a tick
      for (const s of [a, b]) expect((await eventsOf(s.booking.id)).some((n) => n.includes("Launch-day reminder"))).toBe(false); // the claim is given back
      expect(reminderPausedUntilForTests()).toBeGreaterThan(Date.now() + 20 * 60_000);

      // Inside the pause: no query, no mail, no login.
      vi.mocked(sendEmail).mockClear();
      expect(await sendLaunchReminders(OPEN)).toEqual({ reminded: 0, failed: 0 });
      expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();

      // After it, with a working mailer, both are mailed, once each.
      resetCreatorOffersCronForTests();
      vi.mocked(sendEmail).mockImplementation(async () => ({ messageId: "ok" }) as never);
      expect(await sendLaunchReminders(OPEN)).toEqual({ reminded: 2, failed: 0 });
      expect(mailsTo(a.creator.email)).toHaveLength(1);
      expect(mailsTo(b.creator.email)).toHaveLength(1);
    });

    it("a mailer that THROWS is the same: the claim is given back and the pass pauses", async () => {
      const a = await seedOffer({ status: "accepted" });
      vi.mocked(sendEmail).mockImplementation(async () => {
        throw new Error("smtp down");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        expect(await sendLaunchReminders(OPEN)).toEqual({ reminded: 0, failed: 0 });
      } finally {
        warn.mockRestore();
      }
      expect((await eventsOf(a.booking.id)).some((n) => n.includes("Launch-day reminder"))).toBe(false);
      expect(reminderPausedUntilForTests()).toBeGreaterThan(Date.now());
    });

    it("⚠️ a suspended or closed account gets no reminder, and no claim row is churned for it every five minutes", async () => {
      const closed = await seedOffer({ status: "accepted", creatorStatus: "closed" });
      const suspended = await seedOffer({ status: "accepted", creatorStatus: "suspended" });
      const fine = await seedOffer({ status: "accepted" });
      expect(await sendLaunchReminders(OPEN)).toEqual({ reminded: 1, failed: 0 });
      expect(mailsTo(closed.creator.email)).toHaveLength(0);
      expect(mailsTo(suspended.creator.email)).toHaveLength(0);
      expect(mailsTo(fine.creator.email)).toHaveLength(1);
      expect(await eventsOf(suspended.booking.id)).toEqual([]);
      expect(await eventsOf(closed.booking.id)).toEqual([]);
      // Reinstated, they still get their one reminder.
      await prisma.creator.update({ where: { id: suspended.creator.id }, data: { status: "approved" } });
      expect(await sendLaunchReminders(OPEN)).toEqual({ reminded: 1, failed: 0 });
      expect(mailsTo(suspended.creator.email)).toHaveLength(1);
    });
  });

  // ── the tick, and its switches ────────────────────────────────────────────────

  describe("the tick", () => {
    it("runs the jobs and reports each", async () => {
      const now = ist("2026-11-10", "12:00");
      const exp = await seedOffer({ expiresAt: new Date(now.getTime() - HOUR) });
      const missed = await seedOffer({ status: "accepted", from: "2026-11-01", to: "2026-11-08" });
      const open = await seedOffer({ status: "accepted", from: "2026-11-09", to: "2026-11-12" });
      const s = await runCreatorOffersTick({ now });
      expect(s).toEqual({ ran: true, expired: 1, missed: 1, unverified: 0, reminded: 1, resent: 0, failed: 0 });
      expect((await offerOf(exp.offer.id)).status).toBe("expired");
      expect((await offerOf(missed.offer.id)).status).toBe("withdrawn");
      expect((await offerOf(open.offer.id)).status).toBe("accepted");
      expect(mailsTo(open.creator.email)).toHaveLength(1);
      await nothingRefunded();
    });

    it("⚠️ DARK: does nothing at all while the marketplace, the Route switch or the Razorpay keys are off, or with CREATOR_OFFERS_CRON_ENABLED=0", async () => {
      const now = new Date();
      const s = await seedOffer({ expiresAt: new Date(now.getTime() - HOUR) });
      for (const off of [{ CREATORS_ENABLED: "0" }, { CREATORS_MARKETPLACE_ENABLED: "0" }, { CREATOR_ROUTE_ENABLED: "0" }, { RAZORPAY_KEY_ID: "" }, { CREATOR_OFFERS_CRON_ENABLED: "0" }]) {
        for (const [k, v] of Object.entries(off)) vi.stubEnv(k, v);
        expect(await runCreatorOffersTick({ now }), JSON.stringify(off)).toEqual({ ran: false, expired: 0, missed: 0, unverified: 0, reminded: 0, resent: 0, failed: 0 });
        vi.unstubAllEnvs();
        vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
        vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
        vi.stubEnv("CREATORS_ENABLED", "1");
        vi.stubEnv("CREATORS_MARKETPLACE_ENABLED", "1");
        vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
      }
      expect((await offerOf(s.offer.id)).status).toBe("offered");
      expect(await itemOf(s)).toBe("awaiting_creator");
      // And the guard is released: the next, enabled, tick runs.
      expect((await runCreatorOffersTick({ now })).expired).toBe(1);
    });

    it("the overlap guard is claimed before the first await: of two simultaneous ticks exactly one runs", async () => {
      const now = new Date();
      await seedOffer({ expiresAt: new Date(now.getTime() - HOUR) });
      const [a, b] = await Promise.all([runCreatorOffersTick({ now }), runCreatorOffersTick({ now })]);
      expect([a.ran, b.ran].sort()).toEqual([false, true]);
      expect(a.expired + b.expired).toBe(1);
    });

    it("the scheduler: CREATOR_OFFERS_CRON_ENABLED=0 starts nothing and says so; enabled, it schedules the first run", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
      vi.stubEnv("CREATOR_OFFERS_CRON_ENABLED", "0");
      startCreatorOffersCron();
      expect(vi.getTimerCount()).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("CREATOR_OFFERS_CRON_ENABLED=0"));
      vi.stubEnv("CREATOR_OFFERS_CRON_ENABLED", "");
      startCreatorOffersCron();
      expect(vi.getTimerCount()).toBe(1);
      vi.clearAllTimers();
      warn.mockRestore();
    });
  });
});
