/**
 * Configuration + capability gate for the Meta OAuth subsystem
 * ("Post Automation 2", app 298449321694397).
 *
 * ⚠️ CREDENTIAL ISOLATION IS THE POINT OF THIS FILE.
 * Prod already carries META_APP_ID / META_APP_SECRET / META_SYSTEM_USER_TOKEN for a
 * DIFFERENT, OLDER app (998903906094758 "Dashmani Insights") which still powers Top
 * Links and Link Search. Those names are deliberately NOT reused here: pairing one
 * app's id with another app's secret fails with an opaque `(#1) An unknown error`
 * that costs hours to diagnose. Every var below is META_OAUTH_*.
 */

import { tokenCryptoConfigured } from "../../utils/token-crypto";

/** Read-only scope set. */
export const META_OAUTH_SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
  "read_insights",
  "instagram_basic",
  "instagram_manage_insights",
  "business_management",
] as const;

/**
 * Scopes we must NEVER request. The app has them approved, but we do not publish
 * and we do not manage posts — asking for write access we never use is both a
 * consent-screen liability and a review risk. Locked by a test asserting these
 * strings never appear in a built authorize URL.
 */
export const META_FORBIDDEN_SCOPES = [
  "pages_manage_posts",
  "instagram_content_publish",
  "publish_video",
  "pages_manage_engagement",
] as const;

/** Scopes whose absence degrades the connection to PARTIAL_SCOPE. */
export const META_REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "read_insights",
  "instagram_basic",
] as const;

export function metaGraphVersion(): string {
  const v = (process.env.META_GRAPH_VERSION ?? "").trim();
  return v || "v21.0";
}

/** Graph host for this app. NOT meta-graph.ts's GRAPH_BASE — the two apps'
 *  versions must be independently settable. */
export function metaGraphBase(): string {
  return `https://graph.facebook.com/${metaGraphVersion()}`;
}

/** The www host serving the consent dialog (different host to the API host). */
export function metaDialogBase(): string {
  return `https://www.facebook.com/${metaGraphVersion()}`;
}

export function metaOauthAppId(): string {
  return (process.env.META_OAUTH_APP_ID ?? "").trim();
}

export function metaOauthAppSecret(): string {
  return (process.env.META_OAUTH_APP_SECRET ?? "").trim();
}

/**
 * The redirect URI. Explicit, never derived from the request — Meta requires it
 * to byte-match the value registered in the App Dashboard, and deriving it from
 * req.headers.host would silently break behind Cloudflare.
 */
export function metaOauthRedirectUri(): string {
  return (process.env.META_OAUTH_REDIRECT_URI ?? "").trim();
}

/**
 * Origin the callback 302s back to.
 *
 * Explicit rather than reusing INTERNAL_APP_URL because the repo disagrees with
 * itself about that var's default (app.ts says localhost:3000, email.service.ts
 * says the prod portal), and an unset value would emit a literal
 * `Location: undefined/accounts/growth`.
 */
export function metaOauthReturnOrigin(): string {
  return (process.env.META_OAUTH_RETURN_ORIGIN ?? "").trim().replace(/\/+$/, "");
}

/** Which required env vars are missing. Drives the 503 body and the UI banner. */
export function metaOauthMissingEnv(): string[] {
  const missing: string[] = [];
  if (!metaOauthAppId()) missing.push("META_OAUTH_APP_ID");
  if (!metaOauthAppSecret()) missing.push("META_OAUTH_APP_SECRET");
  if (!metaOauthRedirectUri()) missing.push("META_OAUTH_REDIRECT_URI");
  if (!metaOauthReturnOrigin()) missing.push("META_OAUTH_RETURN_ORIGIN");
  if (!tokenCryptoConfigured()) missing.push("META_TOKEN_ENC_KEY");
  return missing;
}

/**
 * DARK SWITCH. Everything Meta-OAuth checks this first; with any var absent the
 * feature is inert and no network call or token write is ever attempted. This is
 * what lets the schema + routes deploy to prod before the owner has registered
 * the redirect URI.
 */
export function metaOauthConfigured(): boolean {
  return metaOauthMissingEnv().length === 0;
}

/**
 * Validate the return origin parses as an absolute http(s) URL with a host.
 * The redirect target is never caller-influenced (there is no `returnTo`
 * parameter anywhere), so the open-redirect surface is zero rather than
 * merely regex-guarded — but a typo'd env var should still fail loudly.
 */
export function metaOauthReturnUrl(search: string): string {
  const origin = metaOauthReturnOrigin();
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new Error(`META_OAUTH_RETURN_ORIGIN is not a valid absolute URL: "${origin}"`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`META_OAUTH_RETURN_ORIGIN must be http(s): "${origin}"`);
  }
  if (!u.host) throw new Error(`META_OAUTH_RETURN_ORIGIN has no host: "${origin}"`);
  // Path is a fixed literal; only the query varies.
  return `${origin}/accounts/growth${search}`;
}

/** Numeric env read with a default and a floor. */
function num(name: string, dflt: number, min = 1): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return dflt;
  return Math.max(min, Math.floor(raw));
}

export const metaTuning = {
  /** Graph calls one discovery pass may spend before parking its cursor. */
  /**
   * ⚠️ 80 was not enough for a real estate and truncated it silently. Discovery
   * costs roughly: pages/100 + pages/50 + ONE CALL PER INSTAGRAM ACCOUNT for its
   * profile. At 369 Pages / 104 IG that is ~112 calls, so an 80-call budget ran
   * out mid-way and simply stopped, reporting success.
   *
   * Discovery is occasional (on connect, and on "refresh channels") rather than a
   * recurring cron, so a generous ceiling costs nothing in steady state. This is a
   * runaway backstop, not a tuning knob.
   */
  discoveryCallBudget: () => num("META_DISCOVERY_CALL_BUDGET", 2000),
  /**
   * Graph calls one steady-state posts run may spend.
   *
   * 400 because the estate is larger than first assumed: the owner's grant reaches
   * 120 assets (72 Pages + 48 IG), and the feed pass alone needs one call each. A
   * 180 budget could not even complete phase 1, so most channels would never be
   * polled. 400 covers the feed pass (~120) with ~280 left for per-post insights,
   * and the fetcher still refuses past the ceiling so this cannot run away.
   */
  postsCallBudget: () => num("META_POSTS_CALL_BUDGET", 400),
  /** Graph calls one interactive single-asset refresh may spend. */
  refreshCallBudget: () => num("META_REFRESH_CALL_BUDGET", 12),
  /** Don't re-fetch a post's insights more often than this. */
  insightsRefreshHours: () => num("META_INSIGHTS_REFRESH_HOURS", 12),
  /** Posts older than this are trimmed by one bounded deleteMany per run. */
  postRetentionDays: () => num("META_POST_RETENTION_DAYS", 120),
  /** Posts cron interval. Floor of 30 min protects the shared Meta budget. */
  postsIntervalMs: () => num("META_POSTS_INTERVAL_MS", 3 * 60 * 60 * 1000, 30 * 60 * 1000),
  /** Send appsecret_proof. Off by default — the sibling app works without it. */
  appsecretProof: () => (process.env.META_OAUTH_APPSECRET_PROOF ?? "") === "1",
};
