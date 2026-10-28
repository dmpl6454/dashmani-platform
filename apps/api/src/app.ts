import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import rateLimit from "express-rate-limit";
import routes from "./routes";
import { errorHandler } from "./middleware/error-handler";
import { rateLimitKey, loginRateLimitKey, googleIpRateLimitKey, isHealthProbe, isPipelinePath, envInt } from "./middleware/rate-limit-key";
import { pipelineNoStore, pipelineRateLimiter, pipelineJson, skipPipelineSyncLog } from "./middleware/pipeline-rate-limit";
import { pipelineErrorMiddleware } from "./services/pipeline/errors";
import campaignWebhookRoutes from "./routes/campaign-webhook.routes";
import { bigintJsonReplacer } from "./utils/bigint-json";
import { creatorMetaReturnUrl } from "./services/creator/creator-meta-config";

const CREATOR_META_CALLBACK_PATH = "/v1/creator/meta/oauth/callback";

/**
 * The request line as logged, with any OAuth `code` / `state` value blanked on the two Meta
 * callbacks. The creator callback no longer redeems the code itself (the creator's own browser
 * does, via POST /oauth/complete), so a code in a log line would still be usable for minutes.
 */
export function redactOauthQuery(url: string): string {
  // One-time invite tokens travel as path segments on two GETs; a token in a log line
  // is a usable invite until it is accepted (security audit 2026-10-28).
  url = url.replace(/(\/v1\/(?:client\/auth\/join|admin\/users\/invite)\/)[^/?#]+/g, "$1[redacted]");
  if (!/\/oauth\/callback(?:\?|$)/.test(url.split("#")[0])) return url;
  return url.replace(/([?&](?:code|state)=)[^&#]*/g, "$1[redacted]");
}

const app = express();
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");

app.set("trust proxy", 1);

// ⚠️ Every `res.json()` goes through this. Prisma returns `BigInt` for the schema's twenty
// BigInt columns and JSON.stringify cannot serialise one — `GET /accounts` 500'd for a day
// after PR #164 added two such columns to social_accounts. See utils/bigint-json.ts.
app.set("json replacer", bigintJsonReplacer);

// Security headers — CSP disabled for API (served cross-origin to frontend apps)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

const extraOrigins = process.env.EXTRA_CORS_ORIGINS
  ? process.env.EXTRA_CORS_ORIGINS.split(",").map((o) => o.trim())
  : [];

app.use(cors({
  origin: [
    process.env.INTERNAL_APP_URL || "http://localhost:3000",
    process.env.CLIENT_APP_URL || "http://localhost:3001",
    process.env.HR_APP_URL || "http://localhost:3002",
    process.env.JOBS_APP_URL || "http://localhost:3003",
    // Creator portal (apps/creators, creators.digitalsukoon.com).
    process.env.CREATORS_APP_URL || "http://localhost:3005",
    // Sales portal (apps/sales, sales.digitalsukoon.com — static export served by nginx).
    process.env.SALES_APP_URL || "http://localhost:3006",
    // Public marketing site (apps/web, served as static files by nginx) — posts the
    // CH 06 contact form to /v1/public/enquiries.
    ...(process.env.WEBSITE_ORIGINS || "https://digitalsukoon.com,https://www.digitalsukoon.com,http://localhost:3004")
      .split(",")
      .map((o) => o.trim()),
    ...extraOrigins,
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  // P12: let the browser reuse a preflight for 10 minutes. Without it nearly every
  // authenticated cross-origin request is preceded by an OPTIONS that nginx/Cloudflare
  // count and that costs a round trip. The Express rate limiters never see preflights
  // (cors ends them first — it is mounted above the limiter, preflightContinue false),
  // so this does not change their budgets. Security-neutral: the origin allowlist above
  // is unchanged, and a browser caps the value anyway (Chromium at 7200 s).
  maxAge: 600,
}));

// Global rate limiter — keyed per VERIFIED USER, falling back to req.ip for anonymous
// calls (see middleware/rate-limit-key.ts for the 2026-09-18 incident: under
// `trust proxy 1` behind Cloudflare, req.ip is the Cloudflare EDGE IP, so keying on it
// made every employee share one bucket and produced "Too many requests" storms).
// Health probes are exempt so monitors never eat a user's budget.
// Pipeline paths are exempt too: they are counted by the pipeline's own per-minute
// buckets mounted right below, so pipeline polling can never 429 HR submit, Link
// History, accounts or login (spec §3.1, §8.1).
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: envInt("RATE_LIMIT_MAX", 1000),
  keyGenerator: rateLimitKey,
  // The creator Meta OAuth callback has its own per-IP ceiling below, which answers with a
  // REDIRECT; this JSON 429 must never reach a creator coming back from Facebook.
  skip: (req) => isHealthProbe(req) || isPipelinePath(req) || req.path === CREATOR_META_CALLBACK_PATH,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Too many requests, please try again later" } },
}));

// Pipeline: no-store on EVERY response (incl. authenticate's 401), then the read / write /
// message buckets (after cors, so preflights never count).
app.use("/v1/pipeline", pipelineNoStore, pipelineRateLimiter);

// Stricter rate limit on login endpoints — keyed per (client, account). Mounted
// further down, AFTER express.json(), because the key reads the request body.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: envInt("RATE_LIMIT_LOGIN_MAX", 20),
  keyGenerator: loginRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Too many login attempts, please try again later" } },
});

// Sign in with Google: a per-client ceiling across the three Google POSTs (see the mounts;
// keyed on req.ip — the edge IP under `trust proxy 1`, hence the generous default).
const googleIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: envInt("RATE_LIMIT_GOOGLE_IP_MAX", 200),
  keyGenerator: googleIpRateLimitKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Too many sign-in attempts, please try again later" } },
});

// Stricter rate limit on public job applications (prevent spam)
const publicLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Too many applications, please try again later" } },
});
app.use("/v1/jobs/:id/apply", publicLimiter);
app.use("/v1/internship/apply", publicLimiter);

// Pipeline body parser: 64 kb, BEFORE the global 10 mb parser (which then skips the
// already-parsed request). Its 413 / malformed-JSON errors are answered in JSON by the
// pipeline error middleware here — they would otherwise reach the global 500.
app.use("/v1/pipeline", pipelineJson, pipelineErrorMiddleware);

// Razorpay webhook: raw body (the signature is an HMAC of the exact bytes), so it is mounted
// BEFORE the global JSON parser, which would otherwise consume and re-shape the body.
app.use("/v1/webhooks/razorpay", campaignWebhookRoutes);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Login limiter needs req.body (per-account key) → after the body parsers.
app.use("/v1/auth/login", authLimiter);
app.use("/v1/hr/auth/login", authLimiter);
app.use("/v1/client/auth/login", authLimiter);
// Public self-signup: the same per-(client, account) bucket — 20 attempts per 15 min keeps a
// bot from minting accounts in bulk without punishing a brand on a shared office IP.
app.use("/v1/client/auth/signup", authLimiter);
// Accepting a team invite sets a password from an emailed token: POST only (the GET that shows
// the invite is a page load). No email in the body, so the bucket is the client's IP.
app.post("/v1/client/auth/join", authLimiter);
// Password reset and HR self-registration (security audit 2026-10-28): every
// forgot-password call sends an email from the shared hr@ Gmail account, which password
// resets for every portal depend on, and registration mints an ACTIVE account. They had
// only the global 1000-per-15-min limit. Same per-(client, account) bucket as login.
for (const path of [
  "/v1/auth/forgot-password",
  "/v1/auth/reset-password",
  "/v1/client/auth/forgot-password",
  "/v1/client/auth/reset-password",
  "/v1/hr/auth/register",
]) {
  app.post(path, authLimiter);
}
// Sign in with Google: the body carries no email, so loginRateLimitKey buckets by the ID
// token's (unverified) `sub` — per (client, Google account), like the password logins.
// ⚠️ POST on the exact path only — `app.use` would prefix-match GET /google/config, which every
// sign-in page load reads, and spend the 20-per-15-min login bucket on page views (seen live).
// The per-account key reads an UNVERIFIED `sub`, so a script could mint a fresh bucket per
// request — and every Google POST makes us call Google's tokeninfo. googleIpLimiter restores a
// hard per-client ceiling (looser than the per-account one) so our box can never be driven to
// hammer Google from its one IP, which would break Sign in with Google for every portal.
// Mounted AFTER authLimiter, so it counts only the requests that would actually reach Google.
for (const path of ["/v1/client/auth/google", "/v1/hr/auth/google", "/v1/auth/google", "/v1/creator/auth/google"]) {
  app.post(path, authLimiter, googleIpLimiter);
}
// Creator portal: password login, public sign-up and forgot-password share the per-(client,
// account) bucket (the key reads `email`). POST on the exact paths, like the Google mounts —
// no prefix match can catch a GET. forgot-password is included because every request sends
// an email: without a cap a script could make our SMTP account mail one inbox endlessly.
for (const path of ["/v1/creator/auth/login", "/v1/creator/auth/signup", "/v1/creator/auth/forgot-password"]) {
  app.post(path, authLimiter);
}
// Creator sign-up also gets a per-client ceiling that IGNORES the email: the per-(client,
// account) bucket above is fresh for every new address, and every sign-up sends a verification
// email from the Gmail account shared with password resets on every portal (review SEC-5).
// Keyed on req.ip — the Cloudflare edge IP under `trust proxy 1` — hence a generous default;
// the hard backstop is the daily creator-email cap in creator-auth.service.ts.
const creatorSignupIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: envInt("RATE_LIMIT_CREATOR_SIGNUP_IP_MAX", 30),
  keyGenerator: (req) => `csu:${req.ip ?? "unknown"}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Too many sign-ups from this network, please try again later" } },
});
app.post("/v1/creator/auth/signup", creatorSignupIpLimiter);
// The creator Meta OAuth callback is public (Facebook redirects the browser to it with no
// session). It only reads one row and redirects, but a per-IP ceiling still bounds it. Over the
// limit it REDIRECTS (?error=busy) like every other outcome of that route — a raw JSON 429 on
// api.digitalsukoon.com would strand the creator outside the app.
const creatorMetaCallbackLimiter = rateLimit({
  windowMs: 60_000,
  max: envInt("RATE_LIMIT_CREATOR_META_CALLBACK_MAX", 60),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, creatorMetaReturnUrl("?error=busy"));
  },
});
app.get(CREATOR_META_CALLBACK_PATH, creatorMetaCallbackLimiter);

if (process.env.NODE_ENV !== "test") {
  // P13: successful POST /v1/pipeline/sync polls are not logged (hundreds of thousands
  // of lines a day); failures that reach this point still are. ⚠️ Pipeline 429s and
  // 413 / INVALID_JSON bodies are answered ABOVE this line and never reach morgan (as
  // the global limiter's 429s never did) — the pipeline limiter and error middleware log
  // those themselves, throttled (utils/throttled-warn.ts).
  morgan.token("url", (req) => redactOauthQuery((req as express.Request).originalUrl || req.url || ""));
  app.use(morgan("combined", { skip: skipPipelineSyncLog }));
}

// Serve uploaded files (documents, profile pictures)
// ⚠️ Uploaded bytes are user-supplied. Before the 2026-10-28 audit an anonymous job
// applicant could store `x.html` and have it served as a web page on this origin.
// middleware/upload.ts now fixes the stored extension; these headers also cover files
// already on disk: no MIME sniffing, a sandbox CSP (no script, no same-origin access)
// and a download — not a page — for anything that is not an image or PDF.
const INLINE_UPLOAD_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".pdf"]);
app.use(
  "/uploads",
  express.static(UPLOAD_DIR, {
    dotfiles: "deny",
    index: false,
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Not on PDFs: Chrome refuses to open a PDF under a sandbox CSP, and a PDF cannot
      // run script on this origin anyway.
      if (ext !== ".pdf") {
        res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      }
      if (!INLINE_UPLOAD_EXTS.has(ext)) {
        res.setHeader("Content-Disposition", "attachment");
      }
    },
  }),
);

app.use("/v1", routes);
app.use(errorHandler);

export default app;
