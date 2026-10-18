// Creator portal (creators.digitalsukoon.com) — runtime configuration. Every knob is env-driven
// and read at CALL time (tests flip them per case). NaN-guarded like services/campaign/config.ts.

import { razorpayConfig } from "../campaign/config";

function envNum(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * The creator terms as they were when the portal had no payments at all ("we do not pay creators today").
 * A creator who connects a bank account is entering a payment relationship that THOSE terms disclaim, so
 * bank connect stays closed ("terms_pending") until CREATOR_TERMS_VERSION names a rewritten version.
 */
export const PRE_PAYOUT_TERMS_VERSION = "2026-10-17";

export const creatorConfig = {
  /** The whole creator portal is dark unless this is exactly "1" (every /v1/creator/* answers 503). */
  enabled: () => process.env.CREATORS_ENABLED === "1",
  /** The creators app origin: CORS, email links, the Meta connect return URL. */
  appUrl: () => (process.env.CREATORS_APP_URL || "http://localhost:3005").replace(/\/+$/, ""),
  /** Background jobs (token health, metrics, state pruning). Kill switch: CREATOR_CRONS_ENABLED=0. */
  cronsEnabled: () => process.env.CREATOR_CRONS_ENABLED !== "0",
  /** Graph calls the daily metrics refresh may spend across every creator page. */
  metricsCallBudget: () => envNum("CREATOR_METRICS_CALL_BUDGET", 200, 1),
  /** The creator terms a sign-up accepts (bump when /terms changes materially). */
  termsVersion: () => process.env.CREATOR_TERMS_VERSION || PRE_PAYOUT_TERMS_VERSION,
  /** True while the terms in force are still the pre-payout ones: bank connect must not open on them. */
  payoutTermsPending: () => (process.env.CREATOR_TERMS_VERSION || PRE_PAYOUT_TERMS_VERSION) === PRE_PAYOUT_TERMS_VERSION,

  // ── Payouts (Razorpay Route): see docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md ──
  /**
   * Bank connect (and, in later phases, new transfers) is dark unless this is exactly "1". Off never
   * strands money: existing payouts keep reconciling. The Razorpay keys must ALSO be present for the
   * feature to count as available (see payout-account.service routeAvailable()).
   */
  routeEnabled: () => process.env.CREATOR_ROUTE_ENABLED === "1",
  /**
   * Creator pages in the client catalogue, and bookings that pay a creator. Dark unless exactly "1". Alone it
   * does nothing: marketplaceAvailable() below also needs the creator portal switch (CREATORS_ENABLED), the
   * Route switch and Razorpay's keys.
   */
  marketplaceEnabled: () => process.env.CREATORS_MARKETPLACE_ENABLED === "1",
  /**
   * Whether a creator's page can be BOOKED today: the creator portal's master switch (CREATORS_ENABLED) AND the
   * marketplace switch AND the Route switch AND Razorpay configured. The one gate every client-facing creator
   * path asks (the catalogue, picking an account, checkout), approval's offers, and the creator's own offers
   * (/v1/creator/offers*) and the offers worker. Staff pricing a page, and a creator's profile and payout
   * screens, do not depend on it.
   *
   * ⚠️ The master switch is part of it: with it off every /v1/creator/* route answers 503, so a creator cannot
   * sign in to accept anything, and a client who could still pay for (or be offered) their page would just end
   * in an expiry and a refund. (The payout terms are NOT repeated here: a page is bookable only through an
   * ACTIVATED payout account, and that can only exist after a bank connect that passed the terms gate.)
   */
  marketplaceAvailable: (): boolean =>
    creatorConfig.enabled() && creatorConfig.marketplaceEnabled() && creatorConfig.routeEnabled() && razorpayConfig.configured(),
  /**
   * How long a creator has to accept a booking offer, in hours. The offer's real expiry is the EARLIER of this
   * and the end of the posting window (IST), so an offer never outlives the time the post can still be made.
   */
  offerTtlHours: () => envNum("CREATOR_OFFER_TTL_HOURS", 48, 1),
  /**
   * The offers worker (offer expiry, the missed posting window, the launch-day reminder). Kill switch:
   * CREATOR_OFFERS_CRON_ENABLED=0. It also does nothing while the marketplace is switched off.
   */
  offersCronEnabled: () => process.env.CREATOR_OFFERS_CRON_ENABLED !== "0",
  /** Most NEW Razorpay linked accounts we create per IST day, across every creator (a flood brake, not a quota). */
  payoutAccountDailyCap: () => envNum("CREATOR_PAYOUT_ACCOUNT_DAILY_CAP", 50, 1),
  /**
   * The payout workers: the linked-account activation poll (cron/creator-payout.cron.ts) AND the money leg's reconciliation
   * worker (cron/creator-payouts.cron.ts: transfers, holds, releases, settlements, reversals, the refunds of refund_due creator
   * posts, the digest), and the transfer kick right after a capture. Kill switch: CREATOR_PAYOUT_CRON_ENABLED=0, which pauses
   * ALL of them (restart to apply); nothing is lost, every payout simply waits in its state. The runtime pause of RELEASES alone,
   * with no restart, is system_settings creatorPayouts.release = 'off' (payout.service releaseSwitchOn).
   */
  payoutCronEnabled: () => process.env.CREATOR_PAYOUT_CRON_ENABLED !== "0",
  /**
   * Whether our creator id is sent to Razorpay as the linked account's `reference_id`. Razorpay refuses
   * the whole create call unless its `route_code_support` feature is enabled on our account (plan
   * prerequisite 3), so it stays off until Razorpay confirms. Its allowed length is also UNVERIFIED
   * (the request doc says 512, the entity doc 20, and an id of ours is 36).
   */
  routeReferenceId: () => process.env.CREATOR_ROUTE_REFERENCE_ID === "1",
  /**
   * The category pair every creator's linked account is registered under. Plan question (i) is open
   * (candidates: media_and_entertainment, or services → ad_and_marketing), so it is an env switch, not a
   * deploy. Values must be lower-case words from Razorpay's lists; anything else falls back to the default.
   */
  routeCategory: (): { category: string; subcategory: string } => {
    const word = (v: string | undefined, d: string) => (v && /^[a-z_]{2,64}$/.test(v) ? v : d);
    return {
      category: word(process.env.CREATOR_ROUTE_CATEGORY, "media_and_entertainment"),
      subcategory: word(process.env.CREATOR_ROUTE_SUBCATEGORY, "content_and_publishing"),
    };
  },
};
