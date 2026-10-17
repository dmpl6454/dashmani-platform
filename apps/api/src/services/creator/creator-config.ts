// Creator portal (creators.digitalsukoon.com) — runtime configuration. Every knob is env-driven
// and read at CALL time (tests flip them per case). NaN-guarded like services/campaign/config.ts.

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
  /** Most NEW Razorpay linked accounts we create per IST day, across every creator (a flood brake, not a quota). */
  payoutAccountDailyCap: () => envNum("CREATOR_PAYOUT_ACCOUNT_DAILY_CAP", 50, 1),
  /** The reconciliation worker (account activation poll today; transfers, releases and expiry in later phases). */
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
