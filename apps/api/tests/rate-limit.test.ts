/**
 * rate-limit.test.ts — the 2026-09-18 "Too many requests" storm.
 *
 * Behind Cloudflare → nginx, `trust proxy 1` makes req.ip the Cloudflare EDGE IP, so
 * the default per-IP limiter put every employee routed through one edge into ONE
 * bucket. The limiter now keys authenticated requests by their VERIFIED user, keeps
 * health probes out of every bucket, and keys login attempts per (client, account).
 *
 * The ceilings are read from env at module load, so this file stubs them low and
 * imports the app dynamically (vitest isolates module registries per file).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { googleAccountOf, isGoogleSignInPath } from "../src/middleware/rate-limit-key";
import { signCreatorAccessToken } from "../src/services/creator/creator-jwt";

vi.stubEnv("RATE_LIMIT_MAX", "4");
vi.stubEnv("RATE_LIMIT_LOGIN_MAX", "2");
// Per-IP ceiling on the Google sign-in POSTs. Below the global 4 so a 429 from it is
// observable before the global limiter would refuse.
vi.stubEnv("RATE_LIMIT_GOOGLE_IP_MAX", "3");
// Google sign-in off: the Google routes answer 503 without ever calling Google, so these
// tests exercise the limiter's keying only (never the network).
vi.stubEnv("GOOGLE_CLIENT_ID", "");

let app: import("express").Express;
beforeAll(async () => {
  app = (await import("../src/app")).default;
});
// The suite runs every file in ONE fork (vitest.config singleFork), so a stubbed env
// would leak into the next file's fresh app instance and shrink its limits.
afterAll(() => vi.unstubAllEnvs());

// Global cap is 4 in this file: 4 requests pass, the 5th from the same key is refused.
// Login tests below stay at ≤4 requests per edge IP so only the LOGIN limiter (cap 2)
// can be the one refusing — the two limiters are asserted separately on purpose.

const SECRET = process.env.JWT_SECRET || "dev-secret";
const tokenFor = (userId: string) =>
  jwt.sign({ userId, email: `${userId}@x.test`, roles: [], type: "employee" }, SECRET, { expiresIn: "15m" });
// Same shape, wrong secret → must NOT mint a bucket of its own.
const forgedToken = (userId: string) =>
  jwt.sign({ userId, email: `${userId}@x.test`, roles: [], type: "employee" }, "not-the-secret", { expiresIn: "15m" });

// Any authenticated route works: the limiter runs before auth/handlers and we only
// assert 429 vs not-429. Distinct edge IPs are simulated via X-Forwarded-For (the
// app trusts one hop, exactly like nginx→Express in prod).
const ROUTE = "/v1/admin/notifications/count";

describe("global rate limiter keying", () => {
  it("keys AUTHENTICATED requests per user: one user exhausting the cap does not block another on the same edge IP", async () => {
    const edge = "162.158.1.1";
    const a = tokenFor("user-a"), b = tokenFor("user-b");
    for (let i = 0; i < 4; i++) {
      const r = await request(app).get(ROUTE).set("Authorization", `Bearer ${a}`).set("X-Forwarded-For", edge);
      expect(r.status).not.toBe(429);
    }
    const blocked = await request(app).get(ROUTE).set("Authorization", `Bearer ${a}`).set("X-Forwarded-For", edge);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ success: false, error: { code: "RATE_LIMIT" } });

    const other = await request(app).get(ROUTE).set("Authorization", `Bearer ${b}`).set("X-Forwarded-For", edge);
    expect(other.status).not.toBe(429);
  });

  it("a FORGED token does not get its own bucket — it is keyed like an anonymous request from that IP", async () => {
    const edge = "162.158.2.2";
    for (let i = 0; i < 4; i++) {
      const r = await request(app).get(ROUTE).set("Authorization", `Bearer ${forgedToken("attacker-" + i)}`).set("X-Forwarded-For", edge);
      expect(r.status).not.toBe(429);
    }
    // Rotating forged user ids buys nothing: the 5th call from this IP is refused.
    const r = await request(app).get(ROUTE).set("Authorization", `Bearer ${forgedToken("attacker-99")}`).set("X-Forwarded-For", edge);
    expect(r.status).toBe(429);
  });

  it("anonymous requests are keyed per IP, and different IPs are independent", async () => {
    for (let i = 0; i < 4; i++) {
      expect((await request(app).get("/v1/jobs").set("X-Forwarded-For", "203.0.113.10")).status).not.toBe(429);
    }
    expect((await request(app).get("/v1/jobs").set("X-Forwarded-For", "203.0.113.10")).status).toBe(429);
    expect((await request(app).get("/v1/jobs").set("X-Forwarded-For", "203.0.113.11")).status).not.toBe(429);
  });

  it("health probes never count and are never refused", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await request(app).get("/v1/health").set("X-Forwarded-For", "203.0.113.50");
      expect(r.status).toBe(200);
    }
    // …and they did not consume that IP's bucket either.
    expect((await request(app).get("/v1/jobs").set("X-Forwarded-For", "203.0.113.50")).status).not.toBe(429);
  });
});

describe("login limiter keying", () => {
  it("is per (client, account): one account hitting the cap does not lock out another account from the same IP", async () => {
    const edge = "162.158.3.3";
    const attempt = (email: string) =>
      request(app).post("/v1/auth/login").set("X-Forwarded-For", edge).send({ email, password: "wrong-password-1" });
    expect((await attempt("alice@example.com")).status).not.toBe(429);
    expect((await attempt("alice@example.com")).status).not.toBe(429);
    expect((await attempt("alice@example.com")).status).toBe(429);
    // Different account, same edge IP → its own bucket.
    expect((await attempt("bob@example.com")).status).not.toBe(429);
  });

  it("normalises the account so case/whitespace variants share one bucket (no evasion, no double counting)", async () => {
    const edge = "162.158.4.4";
    const attempt = (email: string) =>
      request(app).post("/v1/auth/login").set("X-Forwarded-For", edge).send({ email, password: "wrong-password-1" });
    expect((await attempt("Carol@Example.com")).status).not.toBe(429);
    expect((await attempt("  carol@example.com ")).status).not.toBe(429);
    expect((await attempt("carol@example.com")).status).toBe(429);
  });

  it("HR login (identifier field) is covered the same way", async () => {
    const edge = "162.158.5.5";
    const attempt = (identifier: string) =>
      request(app).post("/v1/hr/auth/login").set("X-Forwarded-For", edge).send({ identifier, password: "wrong-password-1" });
    expect((await attempt("dave@example.com")).status).not.toBe(429);
    expect((await attempt("dave@example.com")).status).not.toBe(429);
    expect((await attempt("dave@example.com")).status).toBe(429);
    expect((await attempt("erin@example.com")).status).not.toBe(429);
  });

  // An unsigned JWT-shaped credential: header.payload.signature, base64url. Only the payload
  // is read (unverified) to choose a bucket.
  const fakeGoogleJwt = (claims: Record<string, unknown>) =>
    [
      Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      "c2lnbmF0dXJl",
    ].join(".");

  it("Sign in with Google is keyed per Google account (the token's sub), not per edge IP", async () => {
    const edge = "162.158.6.6";
    const attempt = (credential: string) =>
      request(app).post("/v1/client/auth/google").set("X-Forwarded-For", edge).send({ credential });
    const alice = fakeGoogleJwt({ sub: "1001", email: "alice@gmail.com" });
    const bob = fakeGoogleJwt({ sub: "1002", email: "bob@gmail.com" });
    expect((await attempt(alice)).status).not.toBe(429);
    expect((await attempt(alice)).status).not.toBe(429);
    // The same credential past the cap is refused …
    const blocked = await attempt(alice);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ success: false, error: { code: "RATE_LIMIT" } });
    // … while a different Google account through the same edge has its own bucket.
    expect((await attempt(bob)).status).not.toBe(429);
  });

  it("a Google credential that cannot be decoded falls back to the ip-only bucket", async () => {
    const edge = "162.158.7.7";
    const attempt = (credential: string) =>
      request(app).post("/v1/hr/auth/google").set("X-Forwarded-For", edge).send({ credential });
    expect((await attempt("not-a-jwt")).status).not.toBe(429);
    expect((await attempt("still.not!.a-jwt")).status).not.toBe(429);
    expect((await attempt("garbage")).status).toBe(429);
  });

  it("a `credential` field cannot lift the per-account cap on password login (fresh fake sub per guess)", async () => {
    const edge = "162.158.8.8";
    let n = 0;
    const attempt = () =>
      request(app)
        .post("/v1/client/auth/login")
        .set("X-Forwarded-For", edge)
        .send({ email: "dave@example.com", password: "wrong-password-1", credential: fakeGoogleJwt({ sub: `evil-${++n}` }) });
    expect((await attempt()).status).not.toBe(429);
    expect((await attempt()).status).not.toBe(429);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ success: false, error: { code: "RATE_LIMIT", message: "Too many login attempts, please try again later" } });
  });

  it("Google sign-in has a per-IP ceiling, so minting a fresh fake sub per request cannot dodge it", async () => {
    const edge = "162.158.9.9";
    const attempt = (sub: string) =>
      request(app).post("/v1/auth/google").set("X-Forwarded-For", edge).send({ credential: fakeGoogleJwt({ sub }) });
    expect((await attempt("s1")).status).not.toBe(429);
    expect((await attempt("s2")).status).not.toBe(429);
    expect((await attempt("s3")).status).not.toBe(429);
    // The 4th distinct account from the same IP: every per-account bucket is fresh and the
    // global cap (4) still has room, so only the Google per-IP limiter can be refusing.
    const blocked = await attempt("s4");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ success: false, error: { code: "RATE_LIMIT", message: "Too many sign-in attempts, please try again later" } });
  });

  it("googleAccountOf: sub first, then email, null for anything undecodable or oversized", () => {
    expect(googleAccountOf(fakeGoogleJwt({ sub: "42", email: "X@Y.com" }))).toBe("42");
    expect(googleAccountOf(fakeGoogleJwt({ email: " X@Y.com " }))).toBe("x@y.com");
    expect(googleAccountOf(fakeGoogleJwt({ name: "nobody" }))).toBeNull();
    expect(googleAccountOf("a.b")).toBeNull();
    expect(googleAccountOf("a.%%%.c")).toBeNull();
    expect(googleAccountOf(fakeGoogleJwt({ sub: "1", pad: "x".repeat(9000) }))).toBeNull();
  });
});

describe("creator portal keying", () => {
  // Creator tokens are signed with the CREATOR secret (creator-jwt.ts), so the staff check
  // fails on them; they must still be keyed per creator, not per edge IP.
  const creatorToken = (id: string) => signCreatorAccessToken({ creatorId: id, email: `${id}@creators.test` });
  const CREATOR_ROUTE = "/v1/creator/me";

  it("two creators behind one edge IP get separate buckets", async () => {
    const edge = "162.158.10.10";
    const a = creatorToken("creator-a"), b = creatorToken("creator-b");
    for (let i = 0; i < 4; i++) {
      const r = await request(app).get(CREATOR_ROUTE).set("Authorization", `Bearer ${a}`).set("X-Forwarded-For", edge);
      expect(r.status).not.toBe(429);
    }
    expect((await request(app).get(CREATOR_ROUTE).set("Authorization", `Bearer ${a}`).set("X-Forwarded-For", edge)).status).toBe(429);
    expect((await request(app).get(CREATOR_ROUTE).set("Authorization", `Bearer ${b}`).set("X-Forwarded-For", edge)).status).not.toBe(429);
  });

  it("a creator-shaped token signed with the wrong secret is keyed by IP", async () => {
    const edge = "162.158.11.11";
    const forged = (id: string) =>
      jwt.sign({ creatorId: id, email: "x@y.z", type: "creator" }, "not-the-creator-secret", { audience: "creators", expiresIn: "1h" });
    for (let i = 0; i < 4; i++) {
      const r = await request(app).get(CREATOR_ROUTE).set("Authorization", `Bearer ${forged(`f-${i}`)}`).set("X-Forwarded-For", edge);
      expect(r.status).not.toBe(429);
    }
    expect((await request(app).get(CREATOR_ROUTE).set("Authorization", `Bearer ${forged("f-99")}`).set("X-Forwarded-For", edge)).status).toBe(429);
  });

  it("creator password login is limited per (client, account)", async () => {
    const edge = "162.158.12.12";
    const attempt = (email: string) =>
      request(app).post("/v1/creator/auth/login").set("X-Forwarded-For", edge).send({ email, password: "wrong-password-1" });
    expect((await attempt("Fay@Example.com")).status).not.toBe(429);
    expect((await attempt("fay@example.com")).status).not.toBe(429);
    expect((await attempt("fay@example.com")).status).toBe(429);
    expect((await attempt("gus@example.com")).status).not.toBe(429);
  });

  it("creator forgot-password shares the same per-account bucket (each request sends an email)", async () => {
    const edge = "162.158.13.13";
    const attempt = () => request(app).post("/v1/creator/auth/forgot-password").set("X-Forwarded-For", edge).send({ email: "hal@example.com" });
    expect((await attempt()).status).not.toBe(429);
    expect((await attempt()).status).not.toBe(429);
    expect((await attempt()).status).toBe(429);
  });

  it("the creator Google path is recognised for per-Google-account keying", () => {
    expect(isGoogleSignInPath({ originalUrl: "/v1/creator/auth/google" })).toBe(true);
    expect(isGoogleSignInPath({ originalUrl: "/v1/creator/auth/google/config" })).toBe(false);
  });
});
