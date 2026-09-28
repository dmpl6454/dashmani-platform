import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../src/app";

/**
 * P12 — CORS preflight caching.
 *
 * Without `Access-Control-Max-Age` the browser re-sends an OPTIONS preflight before
 * (almost) every authenticated cross-origin request — an extra request that nginx and
 * Cloudflare count and that costs a round trip. `maxAge: 600` lets a browser reuse a
 * preflight for 10 minutes. The Express rate limiters never see preflights (cors ends
 * them first), so this does not change their budgets. It must not widen who is allowed:
 * the origin allowlist is unchanged.
 */
const HR_ORIGIN = process.env.HR_APP_URL || "http://localhost:3002";

function preflight(origin: string) {
  return request(app)
    .options("/v1/health")
    .set("Origin", origin)
    .set("Access-Control-Request-Method", "POST")
    .set("Access-Control-Request-Headers", "Content-Type, Authorization");
}

describe("P12 CORS preflight cache", () => {
  it("an allowed preflight carries access-control-max-age: 600", async () => {
    const res = await preflight(HR_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers["access-control-max-age"]).toBe("600");
    expect(res.headers["access-control-allow-origin"]).toBe(HR_ORIGIN);
  });

  it("keeps the existing preflight contract (credentials, methods, headers)", async () => {
    const res = await preflight(HR_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-allow-methods"]).toBe("GET,POST,PUT,DELETE,PATCH,OPTIONS");
    expect(res.headers["access-control-allow-headers"]).toBe("Content-Type,Authorization,X-Requested-With");
  });

  it("does not widen the origin allowlist", async () => {
    const res = await preflight("https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("a preflight never reaches the rate limiter (cors ends it before the limiter)", async () => {
    // Locks the mount order the app.ts comment relies on. A preflight carries no
    // Authorization header, so if the limiter ever ran first it would key every
    // preflight on req.ip — the Cloudflare edge IP — i.e. the shared-bucket shape of the
    // 2026-09-18 "Too many requests" incident.
    const pre = await request(app)
      .options("/v1/auth/me")
      .set("Origin", HR_ORIGIN)
      .set("Access-Control-Request-Method", "PUT")
      .set("Access-Control-Request-Headers", "Content-Type, Authorization");
    expect(pre.status).toBe(204);
    expect(pre.headers["ratelimit-limit"]).toBeUndefined();

    // Control: the real request on the same path IS counted, so the assertion above is
    // meaningful (401 from authenticate — no token, no DB access).
    const put = await request(app).put("/v1/auth/me").set("Origin", HR_ORIGIN);
    expect(put.status).toBe(401);
    expect(put.headers["ratelimit-limit"]).toBeDefined();
  });

  it("a plain GET is unaffected (max-age is a preflight-only header)", async () => {
    const res = await request(app).get("/v1/health").set("Origin", HR_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers["access-control-max-age"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe(HR_ORIGIN);
  });
});
