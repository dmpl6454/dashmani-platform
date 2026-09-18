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

vi.stubEnv("RATE_LIMIT_MAX", "4");
vi.stubEnv("RATE_LIMIT_LOGIN_MAX", "2");

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
});
