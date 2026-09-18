import type { Request } from "express";
import { verifyAccessToken } from "../utils/jwt";

// ── Rate-limit keying ───────────────────────────────────────────────────────────
//
// WHY (incident 2026-09-18, "Too many requests, please try again later" for many
// employees at once): express-rate-limit keys on `req.ip`. Traffic reaches the API
// as Cloudflare → nginx → Express, i.e. TWO proxy hops, but app.ts sets
// `trust proxy` to 1, so `req.ip` resolves to the CLOUDFLARE EDGE IP, not the user.
// Cloudflare funnels a whole region through a handful of edge IPs (one edge carried
// 16,959 requests that day), so EVERY employee behind an edge shared ONE
// 1000-requests-per-15-min bucket and ONE 20-logins-per-15-min bucket. During the
// evening submit rush the bucket ran dry and hundreds of unrelated users were
// rejected (487 rejections in one 15-min window), which the HR pages then rendered
// as empty lists — read by the owner as "people have lost their links".
//
// Keying rule, in order:
//   1. A request carrying a VALID access token is keyed by the user it belongs to
//      (`u:<type>:<userId>`). Verified, not just decoded — a forged token cannot mint
//      itself a fresh bucket; it falls through to the IP key like any anonymous call.
//      This is the bulk of traffic and the part that caused the storm.
//   2. Everything else is keyed by `req.ip` — still the edge IP under `trust proxy 1`.
//      Anonymous traffic (login, forgot-password, public jobs, bots) is small, and the
//      login endpoints have their own per-(ip, account) limiter below, so one edge's
//      anonymous bucket no longer starves real users. Making this the TRUE client IP
//      needs nginx's real_ip module with Cloudflare's published ranges (a box config
//      change, not code); a header like CF-Connecting-IP is NOT trusted here because a
//      direct-to-origin client could set it and mint unlimited buckets.
//
// Keep these pure (no I/O): they run before body parsing on every request.

export function rateLimitKey(req: Request): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    try {
      const payload = verifyAccessToken(auth.slice(7));
      if (payload && typeof payload.userId === "string" && payload.userId) {
        return `u:${payload.type ?? "x"}:${payload.userId}`;
      }
    } catch {
      // invalid/expired token → anonymous keying below
    }
  }
  return `ip:${req.ip ?? "unknown"}`;
}

// Login attempts are keyed per (client, account), not per client alone. WHY: a
// per-client cap of 20 with the shared-edge `req.ip` above meant "20 logins per 15
// minutes for the whole company" — the 9am rush and the evening submit window both
// tripped it. Per (ip, account) still caps brute force on ONE account from ONE
// client at 20 tries / 15 min, while unrelated people logging in stay independent.
// The identifier is normalised the same way the auth services normalise it (trim +
// lowercase) so `Foo@x.com` and `foo@x.com` share a bucket. Requires express.json()
// to have run — app.ts mounts this limiter AFTER the body parser for that reason.
export function loginRateLimitKey(req: Request): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = typeof body.email === "string" ? body.email : typeof body.identifier === "string" ? body.identifier : "";
  const account = raw.trim().toLowerCase().slice(0, 200);
  return `login:${req.ip ?? "unknown"}:${account}`;
}

/** Health probes never count against anyone's bucket (uptime monitors, pm2 watchdog). */
export function isHealthProbe(req: Request): boolean {
  return req.path === "/health" || req.path === "/v1/health";
}

/** Env-tunable ceilings (tests set them low; prod uses the defaults). */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}
