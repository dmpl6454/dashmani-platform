import crypto from "crypto";
import { prisma, type Creator } from "@dashmani/db";
import { compare, hash } from "bcrypt";
import { AppError } from "../../middleware/error-handler";
import { likeLiteral } from "../../utils/like-literal";
import { scrubSecrets } from "../../utils/token-crypto";
import { stripTagsLinear } from "@dashmani/shared/src/utils/sanitize";
import { creatorConfig } from "./creator-config";
import {
  signCreatorAccessToken,
  signCreatorRefreshToken,
  verifyCreatorRefreshToken,
  hashToken,
  CREATOR_REFRESH_TTL_DAYS,
} from "./creator-jwt";
import { toCreatorMe } from "./creator-view";
import { sendCreatorEmail, adminAlert, button, esc, creatorLink } from "./creator-email";

// Creator portal (creators.digitalsukoon.com) — accounts and sessions. Modelled on
// client-auth.service.ts, with the gaps that service has closed here from the start:
// - every email lookup is case-insensitive AND wildcard-safe (likeLiteral): Prisma sends
//   `equals` + `mode: "insensitive"` as ILIKE without escaping `_` / `%`;
// - every one-time token (refresh, emailed) is consumed with updateMany/deleteMany + count,
//   so two concurrent uses yield exactly one success and a clean error, never a 500;
// - emailed tokens are stored only as a SHA-256 hash (creator_tokens), like refresh tokens.

const BCRYPT_ROUNDS = 12;
const VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 24 * 60 * 60 * 1000;
/** "Resend verification email" at most once per this window (signup's own email counts). */
export const RESEND_VERIFICATION_COOLDOWN_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A non-negative integer env knob, or the default (NaN-safe). */
function envCap(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * ⚠️ Hard daily ceiling on creator emails (verification + reset links), all creators together.
 * Every sign-up mails an address the caller chooses from hr@digitalsukoon.com — the Gmail
 * account that also sends password resets for every portal and the HR mail. Per-client rate
 * limits key on the Cloudflare edge IP, so they cannot be the last line (review SEC-5). Over the
 * cap a sign-up still succeeds without its email (the creator can ask again later), a resend
 * answers 503 EMAIL_BUSY, and a reset request is dropped (that route is opaque anyway).
 */
async function creatorEmailBudgetLeft(): Promise<boolean> {
  const sent = await prisma.creatorToken.count({ where: { createdAt: { gte: new Date(Date.now() - DAY_MS) } } });
  const ok = sent < envCap("CREATOR_EMAIL_DAILY_CAP", 300);
  if (!ok) warnOnce("[creator-auth] daily creator email cap reached — skipping verification/reset emails");
  return ok;
}

/** Staff "new creator" alerts per rolling 24 h; past it the review queue is the record. */
async function signupAlertBudgetLeft(): Promise<boolean> {
  const n = await prisma.creator.count({ where: { createdAt: { gte: new Date(Date.now() - DAY_MS) } } });
  return n <= envCap("CREATOR_SIGNUP_ALERT_DAILY_CAP", 25);
}

let lastWarnAt = 0;
function warnOnce(msg: string) {
  if (Date.now() - lastWarnAt < 10 * 60 * 1000) return;
  lastWarnAt = Date.now();
  console.warn(msg);
}

type TokenPurpose = "verify_email" | "reset_password";

const EMAIL_EXISTS = () =>
  new AppError(409, "EMAIL_EXISTS", "An account with this email already exists. Sign in, or use “Forgot password”.");
const INVALID_CREDENTIALS = () => new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
const ACCOUNT_CLOSED = () => new AppError(401, "ACCOUNT_CLOSED", "This account is closed.");

/** A bcrypt hash of nothing anyone knows: compared against when the email is unknown, so a
 *  login for a missing account costs the same time as a wrong password (no enumeration). */
let dummyHash: Promise<string> | null = null;
const timingDummy = () => (dummyHash ??= hash(crypto.randomBytes(16).toString("hex"), BCRYPT_ROUNDS));

/** Case-insensitive, wildcard-safe lookup of a creator by email (any status). */
export async function findCreatorByEmail(email: string): Promise<Creator | null> {
  const e = email.trim().toLowerCase().slice(0, 254);
  if (!e) return null;
  return prisma.creator.findFirst({ where: { email: { equals: likeLiteral(e), mode: "insensitive" } } });
}

/** Mint a session: a 1h access token and a single-use refresh token (only its hash is stored). */
export async function issueCreatorSession(c: Creator) {
  const accessToken = signCreatorAccessToken({ creatorId: c.id, email: c.email });
  const refreshToken = await storeRefreshToken(c.id);
  return { accessToken, refreshToken, creator: toCreatorMe(c) };
}

async function storeRefreshToken(creatorId: string): Promise<string> {
  const refreshToken = signCreatorRefreshToken(creatorId);
  await prisma.creatorRefreshToken.create({
    data: {
      creatorId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + CREATOR_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  });
  return refreshToken;
}

/**
 * A fresh emailed token for `purpose`. Earlier unused tokens of the same purpose are retired
 * first, so only the newest link in the creator's inbox works. Returns the RAW token (for the
 * link) — the database only ever sees its hash.
 */
async function issueEmailToken(creatorId: string, purpose: TokenPurpose): Promise<string> {
  const now = new Date();
  const token = crypto.randomBytes(32).toString("base64url");
  await prisma.$transaction([
    prisma.creatorToken.updateMany({ where: { creatorId, purpose, usedAt: null }, data: { usedAt: now } }),
    prisma.creatorToken.create({
      data: {
        creatorId,
        purpose,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + (purpose === "verify_email" ? VERIFY_TTL_MS : RESET_TTL_MS)),
      },
    }),
  ]);
  return token;
}

/** Fire-and-forget mail: a slow or failing SMTP server never delays or fails the request. */
function background(label: string, send: () => Promise<unknown>) {
  void send().catch((e) => console.error(`[creator-auth] ${label} failed:`, scrubSecrets(String(e?.message ?? e))));
}

function sendVerifyEmail(c: Pick<Creator, "email" | "name">, token: string) {
  const link = creatorLink(`/verify-email?token=${token}`);
  background("verify email", () =>
    sendCreatorEmail(
      c.email,
      "Confirm your email — Digital Sukoon Creators",
      "Confirm your email",
      `<p>Hi ${esc(c.name)},</p>
<p>Confirm this is your email address so we can review your creator account.</p>
<p style="margin:20px 0">${button(link, "Confirm email")}</p>
<p style="color:#777;font-size:12px">The link works for 7 days. If you did not sign up, ignore this email.</p>`,
    ),
  );
}

function alertNewCreator(c: Creator, method: string) {
  background("admin alert", () =>
    adminAlert(
      "New creator signed up",
      [
        { label: "Name", value: c.name },
        { label: "Email", value: c.email },
        ...(c.country ? [{ label: "Country", value: c.country }] : []),
        { label: "Method", value: method },
      ],
      `/creators/${c.id}`,
    ),
  );
}

// ── Sign-up / sign-in ──────────────────────────────────────────────────────────

/**
 * Public sign-up. ⚠️ It can never take over or modify an existing account: any existing
 * creator row for the email, in any casing and any status (closed included), is a 409 and
 * nothing is written. A concurrent duplicate loses on the unique index with the same 409.
 */
export async function creatorSignup(data: { name: string; email: string; password: string; country?: string }) {
  const email = data.email.trim().toLowerCase();
  if (await findCreatorByEmail(email)) throw EMAIL_EXISTS();

  const now = new Date();
  const passwordHash = await hash(data.password, BCRYPT_ROUNDS);
  let creator: Creator;
  try {
    creator = await prisma.creator.create({
      data: {
        email,
        passwordHash,
        name: data.name,
        country: data.country ?? null,
        status: "draft",
        termsVersion: creatorConfig.termsVersion(),
        termsAcceptedAt: now,
        adultConfirmedAt: now,
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") throw EMAIL_EXISTS();
    throw err;
  }

  if (await creatorEmailBudgetLeft()) {
    const token = await issueEmailToken(creator.id, "verify_email");
    sendVerifyEmail(creator, token);
  }
  if (await signupAlertBudgetLeft()) alertNewCreator(creator, "Email and password");
  return issueCreatorSession(creator);
}

export async function creatorLogin(email: string, password: string) {
  const c = await findCreatorByEmail(email);
  if (!c) {
    await compare(password, await timingDummy());
    throw INVALID_CREDENTIALS();
  }
  if (!(await compare(password, c.passwordHash))) throw INVALID_CREDENTIALS();
  // Only someone holding the right password learns that the account is closed.
  if (c.status === "closed") throw ACCOUNT_CLOSED();
  return issueCreatorSession(c);
}

/**
 * Rotate a refresh token. The stored hash is CONSUMED with deleteMany + count before anything
 * is minted, so two concurrent refreshes with one token give exactly one 200 and one 401.
 */
export async function creatorRefresh(refreshToken: string) {
  let creatorId: string;
  try {
    creatorId = verifyCreatorRefreshToken(refreshToken).creatorId;
  } catch (e) {
    if (e instanceof AppError) throw e; // CREATORS_NOT_CONFIGURED (503), never a 401
    throw new AppError(401, "INVALID_TOKEN", "Invalid or expired refresh token");
  }
  const consumed = await prisma.creatorRefreshToken.deleteMany({
    where: { tokenHash: hashToken(refreshToken), creatorId, expiresAt: { gt: new Date() } },
  });
  if (consumed.count === 0) throw new AppError(401, "INVALID_TOKEN", "Invalid or expired refresh token");

  const c = await prisma.creator.findUnique({ where: { id: creatorId } });
  if (!c || c.status === "closed") throw new AppError(401, "INVALID_TOKEN", "Invalid or expired refresh token");

  return {
    accessToken: signCreatorAccessToken({ creatorId: c.id, email: c.email }),
    refreshToken: await storeRefreshToken(c.id),
  };
}

/** Sign out this device: the refresh token stops working. Unknown tokens are a no-op. */
export async function creatorLogout(refreshToken: string) {
  await prisma.creatorRefreshToken.deleteMany({ where: { tokenHash: hashToken(refreshToken) } });
}

// ── Password reset ─────────────────────────────────────────────────────────────

/**
 * Always resolves (the route answers `{ sent: true }` either way): whether an email has an
 * account is never revealed. Closed accounts get nothing. The mail goes out in the
 * background so the response time does not depend on SMTP either.
 */
export async function creatorForgotPassword(email: string) {
  const c = await findCreatorByEmail(email);
  if (!c || c.status === "closed") return;
  if (!(await creatorEmailBudgetLeft())) return;
  const token = await issueEmailToken(c.id, "reset_password");
  const link = creatorLink(`/reset-password?token=${token}`);
  background("reset email", () =>
    sendCreatorEmail(
      c.email,
      "Reset your password — Digital Sukoon Creators",
      "Reset your password",
      `<p>Hi ${esc(c.name)},</p>
<p>Someone (hopefully you) asked to reset the password for your creator account.</p>
<p style="margin:20px 0">${button(link, "Choose a new password")}</p>
<p style="color:#777;font-size:12px">The link works for 24 hours and only once. Not in your inbox? Check spam. If you did not ask for this, ignore this email — your password stays the same.</p>`,
    ),
  );
}

/**
 * Consume a single-use emailed token of `purpose`: true only for the ONE caller that flips
 * `usedAt` on an unexpired, unused row.
 */
async function consumeEmailToken(tokenId: string): Promise<boolean> {
  const r = await prisma.creatorToken.updateMany({
    where: { id: tokenId, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  return r.count === 1;
}

/** Set a new password from an emailed link; every existing session (refresh token) ends. */
export async function creatorResetPassword(token: string, newPassword: string) {
  const invalid = () => new AppError(400, "INVALID_TOKEN", "This reset link is invalid or has expired. Ask for a new one.");
  const row = await prisma.creatorToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { creator: { select: { id: true, status: true, emailVerifiedAt: true } } },
  });
  if (!row || row.purpose !== "reset_password" || row.creator.status === "closed") throw invalid();
  const passwordHash = await hash(newPassword, BCRYPT_ROUNDS);
  if (!(await consumeEmailToken(row.id))) throw invalid();

  await prisma.$transaction([
    prisma.creator.update({
      where: { id: row.creatorId },
      // The link was opened from the inbox, which proves the address as well as verify_email does.
      data: { passwordHash, ...(row.creator.emailVerifiedAt ? {} : { emailVerifiedAt: new Date() }) },
    }),
    prisma.creatorRefreshToken.deleteMany({ where: { creatorId: row.creatorId } }),
  ]);
}

// ── Email verification ─────────────────────────────────────────────────────────

/**
 * Single-use: the token is consumed on first use. A repeat of an already-USED link for an
 * account that is now verified answers `verified` again (a double click, or a mail scanner
 * that opened the page first, must not show "invalid link" to someone who IS verified);
 * an unknown, expired or superseded link is a 400.
 */
export async function creatorVerifyEmail(token: string) {
  const invalid = () => new AppError(400, "INVALID_TOKEN", "This confirmation link is invalid or has expired. Sign in to send a new one.");
  const row = await prisma.creatorToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { creator: { select: { id: true, status: true, emailVerifiedAt: true } } },
  });
  if (!row || row.purpose !== "verify_email" || row.creator.status === "closed") throw invalid();

  if (await consumeEmailToken(row.id)) {
    await prisma.creator.updateMany({ where: { id: row.creatorId, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
    return;
  }
  // Re-read: a concurrent first use may have consumed it a moment ago.
  const now = await prisma.creatorToken.findUnique({
    where: { id: row.id },
    select: { usedAt: true, creator: { select: { emailVerifiedAt: true } } },
  });
  if (now?.usedAt && now.creator.emailVerifiedAt) return; // idempotent repeat
  throw invalid();
}

/** Send a fresh confirmation link, at most once per RESEND_VERIFICATION_COOLDOWN_MS. */
export async function creatorResendVerification(creatorId: string) {
  const c = await prisma.creator.findUnique({ where: { id: creatorId } });
  if (!c || c.status === "closed") throw ACCOUNT_CLOSED();
  if (c.emailVerifiedAt) return { sent: false as const, alreadyVerified: true as const };

  const last = await prisma.creatorToken.findFirst({
    where: { creatorId, purpose: "verify_email" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (last && Date.now() - last.createdAt.getTime() < RESEND_VERIFICATION_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_VERIFICATION_COOLDOWN_MS - (Date.now() - last.createdAt.getTime())) / 1000);
    throw new AppError(429, "TOO_SOON", `We just sent one — check your inbox (and spam). You can ask again in ${wait} seconds.`);
  }
  if (!(await creatorEmailBudgetLeft())) {
    throw new AppError(503, "EMAIL_BUSY", "We can't send emails right now. Please try again in a little while.");
  }
  const token = await issueEmailToken(c.id, "verify_email");
  sendVerifyEmail(c, token);
  return { sent: true as const };
}

// ── Continue with Google ───────────────────────────────────────────────────────

/**
 * ⚠️ Pre-account hijack guard (review SEC-2). Anyone can sign up with someone else's address and
 * a password of their choosing, and use it before verifying. When the address's real owner then
 * proves control through Google, the account becomes theirs ALONE: the password is replaced by an
 * unusable one, every session and pending emailed link ends — only then is a session issued.
 * Conditional on emailVerifiedAt still being null, so a concurrent second Google sign-in does
 * not end the first one's fresh session.
 */
async function claimUnverifiedAccount(creatorId: string) {
  const now = new Date();
  const unusable = await hash(crypto.randomBytes(32).toString("hex"), BCRYPT_ROUNDS);
  await prisma.$transaction(async (tx) => {
    const r = await tx.creator.updateMany({ where: { id: creatorId, emailVerifiedAt: null }, data: { emailVerifiedAt: now, passwordHash: unusable } });
    if (r.count === 0) return;
    await tx.creatorRefreshToken.deleteMany({ where: { creatorId } });
    await tx.creatorToken.updateMany({ where: { creatorId, usedAt: null }, data: { usedAt: now } });
  });
}

/**
 * The GIS credential is verified with Google first (our audience, Google's issuer, unexpired,
 * email VERIFIED). Then:
 * - an existing creator with that email (any casing) signs in — Google proved control of the
 *   address, exactly what a reset email proves. An UNVERIFIED account is claimed first
 *   (claimUnverifiedAccount: whoever made it loses the password and every session); a closed
 *   one is refused;
 * - an unknown email without both confirmations answers `{ needsProfile }` and writes NOTHING;
 *   the creators app then asks for the terms + 18+ confirmations (and country) and calls again;
 * - with both, a creator is created with `emailVerifiedAt = now` and an unusable random
 *   password (bcrypt of 256 random bits) — "Forgot password" sets a real one.
 */
export async function creatorGoogleSignIn(input: {
  credential: string;
  country?: string;
  acceptTerms?: true;
  confirmAdult?: true;
}): Promise<
  | { kind: "session"; created: boolean; session: Awaited<ReturnType<typeof issueCreatorSession>> }
  | { kind: "needsProfile"; needsProfile: true; email: string; name: string }
> {
  const { verifyGoogleIdToken } = await import("../google-id-token");
  let identity;
  try {
    identity = await verifyGoogleIdToken(input.credential);
  } catch (e) {
    // The verifier answers 401 for a token it refuses; the creator contract names that 400
    // GOOGLE_INVALID. 503s (not configured / Google down) pass through unchanged.
    if (e instanceof AppError && e.statusCode === 401) throw new AppError(400, "GOOGLE_INVALID", e.message);
    throw e;
  }
  const email = identity.email;
  const name = (stripTagsLinear(identity.name).trim() || email.split("@")[0]).slice(0, 120).padEnd(2, ".");

  const existing = await findCreatorByEmail(email);
  if (existing) {
    if (existing.status === "closed") throw ACCOUNT_CLOSED();
    if (!existing.emailVerifiedAt) await claimUnverifiedAccount(existing.id);
    const c = await prisma.creator.findUniqueOrThrow({ where: { id: existing.id } });
    return { kind: "session", created: false, session: await issueCreatorSession(c) };
  }

  if (input.acceptTerms !== true || input.confirmAdult !== true) {
    return { kind: "needsProfile", needsProfile: true, email, name };
  }

  const now = new Date();
  let creator: Creator;
  try {
    creator = await prisma.creator.create({
      data: {
        email,
        passwordHash: await hash(crypto.randomBytes(32).toString("hex"), BCRYPT_ROUNDS),
        name,
        country: input.country ?? null,
        status: "draft",
        emailVerifiedAt: now,
        termsVersion: creatorConfig.termsVersion(),
        termsAcceptedAt: now,
        adultConfirmedAt: now,
      },
    });
  } catch (err: any) {
    // Two first sign-ins racing on one verified email: the loser signs in to the winner's row.
    if (err?.code === "P2002") {
      const raced = await findCreatorByEmail(email);
      if (raced && raced.status !== "closed") return { kind: "session", created: false, session: await issueCreatorSession(raced) };
      throw EMAIL_EXISTS();
    }
    throw err;
  }
  if (await signupAlertBudgetLeft()) alertNewCreator(creator, "Continue with Google");
  return { kind: "session", created: true, session: await issueCreatorSession(creator) };
}
