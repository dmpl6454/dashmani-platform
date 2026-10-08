import path from "path";

// Self-serve campaign booking — runtime configuration. Every knob is env-driven and
// NaN-guarded (a bare parseInt silently disables a limit, because every comparison against
// NaN is false).

function envNum(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * Where uploads and renders live. ⚠️ Deliberately OUTSIDE UPLOAD_DIR: everything under
 * /uploads is served publicly by express.static, and a client's unreviewed creative must
 * never be reachable by URL.
 */
export function campaignMediaDir(): string {
  return path.resolve(process.env.CAMPAIGN_MEDIA_DIR || path.join(process.cwd(), "campaign-media"));
}

export const mediaSubdirs = {
  tmp: () => path.join(campaignMediaDir(), "tmp"),
  orig: () => path.join(campaignMediaDir(), "orig"),
  render: () => path.join(campaignMediaDir(), "render"),
};

export const campaignConfig = {
  /** Refuse new uploads when the disk has less free space than this. */
  minFreeBytes: () => envNum("CAMPAIGN_MIN_FREE_GB", 5) * 1024 ** 3,
  /** Active (not purged) bytes one client may hold at once. */
  clientQuotaBytes: () => envNum("CAMPAIGN_CLIENT_QUOTA_GB", 2) * 1024 ** 3,
  maxUploadsInFlight: () => envNum("CAMPAIGN_MAX_UPLOADS_IN_FLIGHT", 3, 1),
  retentionDays: () => envNum("CAMPAIGN_RETENTION_DAYS", 14, 1),
  unpaidExpiryHours: () => envNum("CAMPAIGN_UNPAID_EXPIRY_HOURS", 24, 1),
  renderEnabled: () => process.env.CAMPAIGN_RENDER_ENABLED !== "0",
  renderTimeoutMs: () => envNum("CAMPAIGN_RENDER_TIMEOUT_MS", 10 * 60_000, 30_000),
  /** Candidate fonts for the overlay, first existing one wins (fonts-noto-core, then DejaVu). */
  fontFiles: () =>
    [
      process.env.CAMPAIGN_FONT_FILE,
      "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ].filter((f): f is string => Boolean(f)),
  clientAppUrl: () => process.env.CLIENT_APP_URL || "https://client.digitalsukoon.com",
  internalAppUrl: () => process.env.INTERNAL_APP_URL || "https://portal.digitalsukoon.com",
  /** Our team's inbox for booking alerts (CC'd on delivery emails). */
  teamEmail: () => process.env.CAMPAIGN_TEAM_EMAIL || process.env.SITE_ENQUIRY_TO || "admin@digitalsukoon.com",
};

export const razorpayConfig = {
  keyId: () => process.env.RAZORPAY_KEY_ID || "",
  keySecret: () => process.env.RAZORPAY_KEY_SECRET || "",
  webhookSecret: () => process.env.RAZORPAY_WEBHOOK_SECRET || "",
  configured: () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
};
