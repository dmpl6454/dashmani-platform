// Creator portal (creators.digitalsukoon.com) — runtime configuration. Every knob is env-driven
// and read at CALL time (tests flip them per case). NaN-guarded like services/campaign/config.ts.

function envNum(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

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
  termsVersion: () => process.env.CREATOR_TERMS_VERSION || "2026-10-17",
};
