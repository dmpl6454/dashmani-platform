import { describe, it, expect } from "vitest";
import request from "supertest";
import app from "../../src/app";

/**
 * P12 — CORS preflight caching.
 *
 * Without `Access-Control-Max-Age` the browser re-sends an OPTIONS preflight before
 * (almost) every authenticated cross-origin request, doubling the requests nginx and the
 * rate limiters count. `maxAge: 600` lets a browser reuse a preflight for 10 minutes.
 * It must not widen who is allowed: the origin allowlist is unchanged.
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

  it("a plain GET is unaffected (max-age is a preflight-only header)", async () => {
    const res = await request(app).get("/v1/health").set("Origin", HR_ORIGIN);
    expect(res.status).toBe(200);
    expect(res.headers["access-control-max-age"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe(HR_ORIGIN);
  });
});
