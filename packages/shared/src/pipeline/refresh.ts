/**
 * P1 — classify the outcome of a token-refresh round trip.
 *
 * Three outcomes, not two:
 *
 *  - "ok"        the refresh endpoint answered 2xx with a JSON body. The caller still has
 *                to check that the body actually carries both tokens.
 *  - "rejected"  the refresh endpoint deliberately refused, with a JSON 4xx (400 = the
 *                refresh token is missing, 401 = invalid, expired, already used, or the
 *                user is no longer active). The session is really over: clear it and send
 *                the user to /login.
 *  - "transient" nothing trustworthy was said about the session: fetch threw (offline,
 *                DNS, CORS, connection reset), a 429 from a limiter, any 5xx (including our
 *                own JSON 500 when the DB is struggling), or a body that is not JSON (an
 *                nginx or Cloudflare HTML page, a captive portal, a truncated body). Keep
 *                the tokens and let the caller retry later.
 *
 * ⚠️ WHY. Before P1 every one of the transient cases signed the user out of the whole HR
 * portal: a network blip during a refresh wiped localStorage and hard-redirected to
 * /login with no way back. Only a JSON refusal from OUR API is a verdict on the session.
 *
 * Pure and dependency-free on purpose: the HR portal calls it, and the apps/api vitest
 * suite tests it directly.
 */
export type RefreshOutcome = "ok" | "rejected" | "transient";

export interface RefreshAttempt {
  /** fetch() itself threw (or the body could not be read). */
  threw: boolean;
  /** HTTP status of the refresh response, when there was one. */
  status?: number;
  /** The body parsed as a JSON object. */
  isJson?: boolean;
}

export function classifyRefreshOutcome({ threw, status, isJson }: RefreshAttempt): RefreshOutcome {
  if (threw) return "transient";
  if (typeof status !== "number" || !Number.isFinite(status)) return "transient";
  // A limiter or a struggling server is never a verdict on the session, JSON or not.
  if (status === 429 || status >= 500) return "transient";
  // Only OUR API answers in JSON; anything else is a proxy, a portal or a broken body.
  if (!isJson) return "transient";
  if (status >= 200 && status < 300) return "ok";
  // 400 and 401 are what the refresh endpoint actually sends. Any other JSON 4xx is the
  // same kind of deliberate refusal; treating it as transient would leave the user
  // signed in to a session every request fails on, with no route back to /login.
  if (status >= 400 && status < 500) return "rejected";
  return "transient";
}
