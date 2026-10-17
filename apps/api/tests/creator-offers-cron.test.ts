/**
 * The offers worker (payout plan Phase 3): the clock-driven half of a booking offer. Three jobs, each exercised with an explicit
 * `now`, so no test waits for a clock and none depends on the hour it runs at:
 *   (a) EXPIRE        an `offered` offer past its expiry is closed: item refund_due, planned payout void, staff told
 *   (b) MISSED WINDOW an `accepted` offer with no link at (the window's last IST day + 24 h): staff told once, then withdrawn
 *   (c) REMINDER      one launch-day email to a creator whose accepted offer has no link yet, 09:00-20:00 IST only
 * and its switches: dark with the marketplace off, CREATOR_OFFERS_CRON_ENABLED=0, and the overlap guard.
 *
 * Offers are seeded straight into the database (a booking in `approved`, an item, a `planned` payout, an offer); the transitions
 * themselves are the real service code. Razorpay is a stub that RECORDS every call: nothing here may ever call it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import { notifyAdminByEmail, sendEmail } from "../src/services/email.service";
import { razorpayHttp } from "../src/services/campaign/razorpay";
import { closeMissedWindows, expireDueOffers, resetCreatorOffersCronForTests, runCreatorOffersTick, sendLaunchReminders, startCreatorOffersCron } from "../src/cron/creator-offers.cron";
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

/** An IST calendar day as it is stored (a DATE: that day at 00:00 UTC). */
const day = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
/** The instant an IST wall-clock time falls on. */
const ist = (ymd: string, hhmm: string) => new Date(new Date(`${ymd}T${hhmm}:00.000Z`).getTime() - 5.5 * HOUR);

describe("creator offers worker", () => {
  let clientId: string;

  beforeEach(async () => {
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
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
    vi.mocked(notifyAdminByEmail).mockClear();
    vi.mocked(sendEmail).mockReset();
    vi.mocked(sendEmail).mockImplementation(async () => ({ messageId: "test" }) as never);
    clientId = (await prisma.client.create({ data: { companyName: "Brand A", contactName: "Asha", email: "a@brand.test", passwordHash: "x" } })).id;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
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
  }

  async function seedOffer(o: SeedOpts = {}) {
    const n = ++seq;
    const status = o.status ?? "offered";
    const creator = await prisma.creator.create({
      data: { email: `creator${n}@creators.test`, passwordHash: "x", name: `Creator ${n}`, status: o.creatorStatus ?? "approved", emailVerifiedAt: new Date() },
    });
    const booking = await prisma.campaignBooking.create({
      data: { clientId, name: `Campaign ${n}`, brand: "Brand", status: "approved", format: "post", totalPaise: 250_000, paidAt: new Date(), launchFrom: day(o.from ?? "2026-11-01"), launchTo: day(o.to ?? "2026-11-08") },
    });
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
        status: o.payoutStatus ?? "planned",
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
    it("closes every offer that is `offered` and past its expiry: item refund_due, planned payout void, staff told; leaves the others alone; calls Razorpay never", async () => {
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
        expect(await payoutOf(s)).toBe("void");
        expect(await eventsOf(s.booking.id)).toContainEqual(expect.stringContaining("the offer expired"));
      }
      expect((await offerOf(notYet.offer.id)).status).toBe("offered");
      expect(await itemOf(notYet)).toBe("awaiting_creator");
      expect((await offerOf(accepted.offer.id)).status).toBe("accepted"); // an accepted offer never expires
      expect(await itemOf(accepted)).toBe("manual_pending");
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((s) => s === REFUND_ALERT)).toHaveLength(2);
      await nothingRefunded();
      // A second pass has nothing left to do.
      expect(await expireDueOffers(now)).toEqual({ expired: 0, failed: 0 });
    });

    it("⚠️ one offer that cannot be closed (its payout is already past `planned`) stays open and is counted as a failure, and the next offer is still handled", async () => {
      const now = new Date();
      const stuck = await seedOffer({ expiresAt: new Date(now.getTime() - 3 * HOUR), payoutStatus: "held" });
      const fine = await seedOffer({ expiresAt: new Date(now.getTime() - HOUR) });
      const r = await expireDueOffers(now);
      expect(r).toEqual({ expired: 1, failed: 1 });
      expect(await offerOf(stuck.offer.id)).toMatchObject({ status: "offered", closedReason: null });
      expect(await itemOf(stuck)).toBe("awaiting_creator");
      expect(await payoutOf(stuck)).toBe("held");
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
    });

    it("an offer whose item is not where the offer says it is (INVALID_STATE) is a failure to look at, not a race it quietly lost", async () => {
      const now = new Date();
      const odd = await seedOffer({ expiresAt: new Date(now.getTime() - HOUR), itemStatus: "manual_pending" });
      expect(await expireDueOffers(now)).toEqual({ expired: 0, failed: 1 });
      expect((await offerOf(odd.offer.id)).status).toBe("offered");
      expect(await itemOf(odd)).toBe("manual_pending");
    });

    it("an offer the creator answered at the last second is not a failure and not touched (the race is lost quietly)", async () => {
      const now = new Date();
      const s = await seedOffer({ expiresAt: new Date(now.getTime() - 1000) });
      // The creator accepted just before the worker read it: the worker's read now finds it `accepted`.
      await prisma.creatorOffer.update({ where: { id: s.offer.id }, data: { status: "accepted", acceptedAt: new Date() } });
      await prisma.campaignBookingItem.update({ where: { id: s.item.id }, data: { status: "manual_pending" } });
      expect(await expireDueOffers(now)).toEqual({ expired: 0, failed: 0 });
      expect((await offerOf(s.offer.id)).status).toBe("accepted");
    });
  });

  // ── (b) missed window ─────────────────────────────────────────────────────────

  describe("missed window", () => {
    // The window's last IST day 2026-11-08 ends at 2026-11-09 00:00 IST; the creator has 24 h more to send the link.
    const NOW = ist("2026-11-10", "12:00");

    it("an accepted offer with no link at the window's end + 24 h: staff are alerted ONCE, then it is withdrawn (item refund_due, planned payout void); nothing is refunded", async () => {
      const missed = await seedOffer({ status: "accepted", from: "2026-11-01", to: "2026-11-08" });
      const inGrace = await seedOffer({ status: "accepted", from: "2026-11-03", to: "2026-11-09" }); // closes 2026-11-10 00:00 IST + 24 h = 11-11 00:00
      const r = await closeMissedWindows(NOW);
      expect(r).toEqual({ missed: 1, unverified: 0, failed: 0 });
      expect(await offerOf(missed.offer.id)).toMatchObject({ status: "withdrawn", closedReason: "missed_window", withdrawnById: null });
      expect((await offerOf(missed.offer.id)).postMissingAt).not.toBeNull();
      expect(await itemOf(missed)).toBe("refund_due");
      expect(await payoutOf(missed)).toBe("void");
      expect(await eventsOf(missed.booking.id)).toContainEqual(expect.stringContaining("did not post in the window"));
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((s) => s === MISSED_ALERT)).toHaveLength(1);
      expect(alertSubjects()).not.toContain(REFUND_ALERT); // the missed-window alert already says it
      // Inside the grace: untouched.
      expect(await offerOf(inGrace.offer.id)).toMatchObject({ status: "accepted", postMissingAt: null });
      expect(await itemOf(inGrace)).toBe("manual_pending");
      await nothingRefunded();
      // A second pass does nothing and alerts nobody again.
      expect(await closeMissedWindows(NOW)).toEqual({ missed: 0, unverified: 0, failed: 0 });
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((s) => s === MISSED_ALERT)).toHaveLength(1);
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
      expect(r).toEqual({ missed: 0, unverified: 1, failed: 0 });
      expect(await offerOf(s.offer.id)).toMatchObject({ status: "accepted", postMissingAt: null });
      expect(await itemOf(s)).toBe("manual_pending");
      expect(await payoutOf(s)).toBe("planned");
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((x) => x === UNVERIFIED_ALERT)).toHaveLength(1);
      // Once: the second pass finds the marker in the booking's history and says nothing.
      expect(await closeMissedWindows(NOW)).toEqual({ missed: 0, unverified: 0, failed: 0 });
      expect((await eventsOf(s.booking.id)).filter((n) => n.startsWith("Overdue: the creator's link"))).toHaveLength(1);
    });

    it("a verified post, a still-offered offer and an offer past `planned` are never auto-withdrawn", async () => {
      const verified = await seedOffer({ status: "accepted", link: "auto_ok", verified: true, itemStatus: "posted_manual" });
      const offered = await seedOffer({ status: "offered" });
      await prisma.creatorOffer.update({ where: { id: offered.offer.id }, data: { windowTo: day("2026-11-01"), windowFrom: day("2026-10-25") } });
      expect(await closeMissedWindows(NOW)).toEqual({ missed: 0, unverified: 0, failed: 0 });
      expect((await offerOf(verified.offer.id)).status).toBe("accepted");
      expect((await offerOf(offered.offer.id)).status).toBe("offered");
      // A payout that is past `planned` cannot be reversed yet: the staff alert went out, the offer stays, the failure is counted.
      const held = await seedOffer({ status: "accepted", payoutStatus: "held" });
      const r = await closeMissedWindows(NOW);
      expect(r).toMatchObject({ missed: 0, failed: 1 });
      await flushPayoutAlertsForTests();
      // The withdraw is retried every tick, the staff alert is not: post_missing_at was stamped first, so it goes out once
      // even when the hour's quiet period has passed in between.
      resetPayoutAlertsForTests();
      expect(await closeMissedWindows(NOW)).toMatchObject({ missed: 0, failed: 1 });
      await flushPayoutAlertsForTests();
      expect(alertSubjects().filter((x) => x === MISSED_ALERT)).toHaveLength(1);
      expect((await offerOf(held.offer.id)).postMissingAt).not.toBeNull();
      expect(await offerOf(held.offer.id)).toMatchObject({ status: "accepted" });
      expect(await payoutOf(held)).toBe("held");
      await nothingRefunded();
    });
  });

  // ── (c) the launch-day reminder ───────────────────────────────────────────────

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

    it("a mail that did not go out is retried on the next pass (the claim is given back); a mailer that throws is a counted failure and never stops the rest", async () => {
      const a = await seedOffer({ status: "accepted" });
      const b = await seedOffer({ status: "accepted" });
      vi.mocked(sendEmail).mockImplementation(async (m: any) => {
        if (m.to === a.creator.email) return null as never; // SMTP not configured / refused
        return { messageId: "ok" } as never;
      });
      expect(await sendLaunchReminders(OPEN)).toEqual({ reminded: 1, failed: 0 });
      expect(mailsTo(b.creator.email)).toHaveLength(1);
      expect((await eventsOf(a.booking.id)).some((n) => n.includes("Launch-day reminder"))).toBe(false);
      vi.mocked(sendEmail).mockImplementation(async () => ({ messageId: "ok" }) as never);
      expect(await sendLaunchReminders(OPEN)).toEqual({ reminded: 1, failed: 0 });
      expect(mailsTo(a.creator.email).length).toBeGreaterThanOrEqual(1);
      expect(mailsTo(b.creator.email)).toHaveLength(1); // b was not mailed again
    });

    it("never mails a closed account", async () => {
      const s = await seedOffer({ status: "accepted", creatorStatus: "closed" });
      expect(await sendLaunchReminders(OPEN)).toEqual({ reminded: 0, failed: 0 });
      expect(mailsTo(s.creator.email)).toHaveLength(0);
    });
  });

  // ── the tick, and its switches ────────────────────────────────────────────────

  describe("the tick", () => {
    it("runs the three jobs and reports each", async () => {
      const now = ist("2026-11-10", "12:00");
      const exp = await seedOffer({ expiresAt: new Date(now.getTime() - HOUR) });
      const missed = await seedOffer({ status: "accepted", from: "2026-11-01", to: "2026-11-08" });
      const open = await seedOffer({ status: "accepted", from: "2026-11-09", to: "2026-11-12" });
      const s = await runCreatorOffersTick({ now });
      expect(s).toEqual({ ran: true, expired: 1, missed: 1, unverified: 0, reminded: 1, failed: 0 });
      expect((await offerOf(exp.offer.id)).status).toBe("expired");
      expect((await offerOf(missed.offer.id)).status).toBe("withdrawn");
      expect((await offerOf(open.offer.id)).status).toBe("accepted");
      expect(mailsTo(open.creator.email)).toHaveLength(1);
      await nothingRefunded();
    });

    it("⚠️ DARK: does nothing at all while the marketplace, the Route switch or the Razorpay keys are off, or with CREATOR_OFFERS_CRON_ENABLED=0", async () => {
      const now = new Date();
      const s = await seedOffer({ expiresAt: new Date(now.getTime() - HOUR) });
      for (const off of [{ CREATORS_MARKETPLACE_ENABLED: "0" }, { CREATOR_ROUTE_ENABLED: "0" }, { RAZORPAY_KEY_ID: "" }, { CREATOR_OFFERS_CRON_ENABLED: "0" }]) {
        for (const [k, v] of Object.entries(off)) vi.stubEnv(k, v);
        expect(await runCreatorOffersTick({ now }), JSON.stringify(off)).toEqual({ ran: false, expired: 0, missed: 0, unverified: 0, reminded: 0, failed: 0 });
        vi.unstubAllEnvs();
        vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
        vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
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
