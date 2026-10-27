import crypto from "crypto";
import jwt from "jsonwebtoken";
import { prisma } from "@dashmani/db";
import { decryptToken, encryptToken, tokenCryptoConfigured } from "../../utils/token-crypto";
import { AppError } from "../../middleware/error-handler";
import { campaignConfig } from "./config";

// Phase 3 — YouTube channels connected by staff for campaign auto-upload.
//
// One Google login acts as ONE channel (Google asks which channel/brand account at consent), so
// a connection is keyed by the channel id it returned; reconnecting the same channel updates the
// row. Only the refresh token is stored, encrypted with utils/token-crypto (no fallback key:
// without META_TOKEN_ENC_KEY nothing is ever written). Access tokens live in memory only.
//
// ⚠️ An unverified Google Cloud project limits the consent screen to 100 test users and Google
// forces every video it uploads to PRIVATE until the project passes YouTube's API audit. The
// publisher checks the privacy YouTube actually applied and hands the post to staff when it
// differs, so a "published" campaign post is never a video nobody can see.

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];
const UPLOAD_SCOPE = YOUTUBE_SCOPES[0];
const STATE_AUD = "yt-oauth";
const STATE_TTL_SEC = 30 * 60;

export const youtubeOauthConfig = {
  clientId: () => process.env.YOUTUBE_OAUTH_CLIENT_ID || "",
  clientSecret: () => process.env.YOUTUBE_OAUTH_CLIENT_SECRET || "",
  redirectUri: () => process.env.YOUTUBE_OAUTH_REDIRECT_URI || `${campaignConfig.apiPublicUrl()}/v1/youtube/oauth/callback`,
  /** Which env keys are missing — shown to staff instead of a broken connect button. */
  missing: (): string[] => {
    const m: string[] = [];
    if (!process.env.YOUTUBE_OAUTH_CLIENT_ID) m.push("YOUTUBE_OAUTH_CLIENT_ID");
    if (!process.env.YOUTUBE_OAUTH_CLIENT_SECRET) m.push("YOUTUBE_OAUTH_CLIENT_SECRET");
    if (!tokenCryptoConfigured()) m.push("META_TOKEN_ENC_KEY");
    return m;
  },
  configured: () => youtubeOauthConfig.missing().length === 0,
};

const jwtSecret = () => process.env.JWT_SECRET || "dev-secret";

// ── Connect ─────────────────────────────────────────────────────────────────────

export function buildAuthUrl(staffId: string): string {
  if (!youtubeOauthConfig.configured()) {
    throw new AppError(503, "YOUTUBE_NOT_CONFIGURED", `YouTube connect is not set up on the server (${youtubeOauthConfig.missing().join(", ")}).`);
  }
  const state = jwt.sign({ staffId, nonce: crypto.randomBytes(12).toString("hex") }, jwtSecret(), { audience: STATE_AUD, expiresIn: STATE_TTL_SEC });
  const q = new URLSearchParams({
    client_id: youtubeOauthConfig.clientId(),
    redirect_uri: youtubeOauthConfig.redirectUri(),
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    // A refresh token is only returned on consent; force it so a reconnect always gets one.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

/** The staff id the state was issued to, or null when it is forged, expired or for another flow. */
export function verifyState(state: string | undefined): string | null {
  if (!state) return null;
  try {
    const p = jwt.verify(state, jwtSecret(), { audience: STATE_AUD }) as { staffId?: string };
    return typeof p.staffId === "string" ? p.staffId : null;
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function postForm(url: string, body: Record<string, string>): Promise<{ status: number; data: TokenResponse }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  return { status: res.status, data };
}

function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string };
    return typeof payload.email === "string" ? payload.email.slice(0, 320) : null;
  } catch {
    return null;
  }
}

/**
 * Finish the OAuth round-trip: code → tokens → the channel this login acts as → upsert.
 * Throws AppError with a short code the callback puts in the redirect (never the Google text).
 */
export async function completeConnect(code: string, staffId: string) {
  if (!youtubeOauthConfig.configured()) throw new AppError(503, "not_configured", "YouTube connect is not set up");
  const tok = await postForm(TOKEN_URL, {
    code,
    client_id: youtubeOauthConfig.clientId(),
    client_secret: youtubeOauthConfig.clientSecret(),
    redirect_uri: youtubeOauthConfig.redirectUri(),
    grant_type: "authorization_code",
  });
  if (tok.status !== 200 || !tok.data.access_token) throw new AppError(502, "exchange_failed", "Google did not accept the sign-in");
  const scopes = (tok.data.scope ?? "").split(/\s+/).filter(Boolean);
  if (!scopes.includes(UPLOAD_SCOPE)) throw new AppError(400, "upload_not_granted", "Upload permission was not granted");

  const ch = await fetch(`${CHANNELS_URL}?part=snippet&mine=true`, {
    headers: { authorization: `Bearer ${tok.data.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const chData = (await ch.json().catch(() => ({}))) as { items?: Array<{ id: string; snippet?: { title?: string } }> };
  const channel = ch.status === 200 ? chData.items?.[0] : undefined;
  if (!channel?.id) throw new AppError(400, "no_channel", "This Google account has no YouTube channel");

  const existing = await prisma.youtubeConnection.findUnique({ where: { channelId: channel.id }, select: { refreshTokenEnc: true } });
  // Google omits refresh_token when it re-uses an earlier grant; keep the stored one then.
  const refreshEnc = tok.data.refresh_token ? encryptToken(tok.data.refresh_token) : existing?.refreshTokenEnc;
  if (!refreshEnc) throw new AppError(400, "no_refresh_token", "Google returned no offline access — remove the app's access in your Google account and connect again");

  const title = (channel.snippet?.title ?? channel.id).slice(0, 200);
  const data = {
    channelTitle: title,
    googleEmail: emailFromIdToken(tok.data.id_token),
    refreshTokenEnc: refreshEnc,
    grantedScopes: scopes.join(" "),
    status: "active",
    lastError: null,
    revokedAt: null,
    connectedById: staffId,
  };
  const row = await prisma.youtubeConnection.upsert({
    where: { channelId: channel.id },
    create: { channelId: channel.id, ...data },
    update: data,
  });
  accessCache.delete(row.id);
  if (tok.data.expires_in) accessCache.set(row.id, { token: tok.data.access_token, exp: Date.now() + (tok.data.expires_in - 60) * 1000 });
  return row;
}

// ── Access tokens ───────────────────────────────────────────────────────────────

const accessCache = new Map<string, { token: string; exp: number }>();
export function __clearYoutubeTokenCacheForTests() {
  accessCache.clear();
}
export function forgetAccessToken(connectionId: string) {
  accessCache.delete(connectionId);
}

/** The connection can no longer act for its channel: Google refused the refresh token. */
export class YoutubeReauthError extends Error {}

export async function getAccessToken(connectionId: string): Promise<string> {
  const hit = accessCache.get(connectionId);
  if (hit && hit.exp > Date.now()) return hit.token;
  const conn = await prisma.youtubeConnection.findUnique({ where: { id: connectionId } });
  if (!conn || conn.status !== "active" || conn.revokedAt) throw new YoutubeReauthError("The YouTube connection is not active.");
  const res = await postForm(TOKEN_URL, {
    client_id: youtubeOauthConfig.clientId(),
    client_secret: youtubeOauthConfig.clientSecret(),
    refresh_token: decryptToken(conn.refreshTokenEnc),
    grant_type: "refresh_token",
  });
  if (res.status === 200 && res.data.access_token) {
    accessCache.set(connectionId, { token: res.data.access_token, exp: Date.now() + Math.max(60, (res.data.expires_in ?? 3600) - 60) * 1000 });
    return res.data.access_token;
  }
  // invalid_grant = revoked, expired (7-day tokens of an app still in "Testing") or password
  // changed. Anything else (invalid_client, 5xx) is our config or Google's — retried, not a reauth.
  if (res.data.error === "invalid_grant") {
    await prisma.youtubeConnection.update({
      where: { id: connectionId },
      data: { status: "needs_reauth", lastError: `Google refused the stored login (${res.data.error ?? res.status}). Reconnect the channel.` },
    });
    throw new YoutubeReauthError("Google refused the stored YouTube login — reconnect the channel.");
  }
  throw new Error(`YouTube token refresh failed (HTTP ${res.status})`);
}

// ── Channel ↔ campaign account ──────────────────────────────────────────────────

const UC_RE = /^UC[\w-]{20,}$/;

/** The UC… id behind a YouTube social_accounts row: pinned in profile_url by the follower sync. */
export function channelIdFrom(handle: string | null | undefined, profileUrl: string | null | undefined): string | null {
  const m = (profileUrl ?? "").match(/\/channel\/(UC[\w-]{20,})/);
  if (m) return m[1];
  const h = (handle ?? "").replace(/^@/, "").trim();
  return UC_RE.test(h) ? h : null;
}

export async function channelIdForSocialAccount(socialAccountId: string): Promise<string | null> {
  const s = await prisma.socialAccount.findUnique({ where: { id: socialAccountId }, select: { handle: true, profileUrl: true } });
  return s ? channelIdFrom(s.handle, s.profileUrl) : null;
}

export async function activeConnectionForChannel(channelId: string) {
  return prisma.youtubeConnection.findFirst({ where: { channelId, status: "active", revokedAt: null }, select: { id: true, channelId: true } });
}

// ── Staff list / disconnect ─────────────────────────────────────────────────────

export async function listConnections() {
  const [rows, yt] = await Promise.all([
    prisma.youtubeConnection.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.socialAccount.findMany({
      where: { status: "ACTIVE", platform: { slug: "youtube" } },
      select: { id: true, displayName: true, handle: true, profileUrl: true },
    }),
  ]);
  const staffIds = [...new Set(rows.map((r) => r.connectedById).filter((x): x is string => Boolean(x)))];
  const staff = staffIds.length ? await prisma.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }) : [];
  const accounts = yt.map((s) => ({ ...s, channelId: channelIdFrom(s.handle, s.profileUrl) }));
  const cards = accounts.length
    ? await prisma.campaignRateCard.findMany({ where: { targetType: "social_account", targetId: { in: accounts.map((a) => a.id) }, active: true }, select: { targetId: true } })
    : [];
  const priced = new Set(cards.map((c) => c.targetId));
  return {
    configured: youtubeOauthConfig.configured(),
    missing: youtubeOauthConfig.missing(),
    publishEnabled: campaignConfig.youtubePublishEnabled(),
    dailyUploads: campaignConfig.youtubeDailyUploads(),
    privacy: campaignConfig.youtubePrivacy(),
    redirectUri: youtubeOauthConfig.redirectUri(),
    connections: rows.map((r) => {
      const acct = accounts.find((a) => a.channelId === r.channelId);
      return {
        id: r.id,
        channelId: r.channelId,
        channelTitle: r.channelTitle,
        googleEmail: r.googleEmail,
        status: r.revokedAt ? "revoked" : r.status,
        lastError: r.lastError,
        connectedBy: staff.find((s) => s.id === r.connectedById)?.name ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        account: acct ? { id: acct.id, name: acct.displayName, onRateCard: priced.has(acct.id) } : null,
      };
    }),
  };
}

export async function disconnect(id: string) {
  const row = await prisma.youtubeConnection.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "NOT_FOUND", "Connection not found");
  await prisma.youtubeConnection.update({ where: { id }, data: { status: "revoked", revokedAt: new Date() } });
  accessCache.delete(id);
  // Best effort: tell Google too. A failure leaves only our local revoke, which already stops uploads.
  try {
    await postForm(REVOKE_URL, { token: decryptToken(row.refreshTokenEnc) });
  } catch {
    /* ignore */
  }
  return { ok: true };
}
