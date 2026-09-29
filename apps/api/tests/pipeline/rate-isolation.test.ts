/**
 * pipeline/rate-isolation.test.ts — the pipeline's own rate-limit buckets and body parser
 * (spec §3.1, §8.1, P13).
 *
 * The 2026-09-18 "Too many requests" storm came from traffic sharing ONE bucket. The
 * pipeline polls every ~10 s per open tab, so it gets buckets of its own:
 *   - the global limiter SKIPS /v1/pipeline/* (same lowercase predicate), so pipeline
 *     polling can never 429 HR submit, Link History, accounts or login;
 *   - read / write / message limiters per user per minute, keyed by the SIGNATURE-verified
 *     token even when it has EXPIRED — otherwise an expired token is keyed on the
 *     Cloudflare edge IP and many users get 429 before the 401 that triggers a refresh;
 *   - a 64 kb JSON parser mounted before the global 10 mb one, answering 413/400 in JSON.
 *
 * Ceilings are read from env at module load, so each describe block builds its own app
 * with stubbed env (vi.resetModules + dynamic import) and restores env afterwards —
 * the suite runs every file in ONE fork, so a leaked stub would shrink other files' limits.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { Express, Request, Response } from "express";
import { pipelineDb } from "../../src/services/pipeline/db";

const SECRET = process.env.JWT_SECRET || "dev-secret";
const hrToken = (userId: string, expiresIn: number | string = "15m") =>
  jwt.sign({ userId, email: `${userId}@x.test`, roles: [], type: "hr" }, SECRET, { expiresIn });
const forged = (userId: string) =>
  jwt.sign({ userId, email: `${userId}@x.test`, roles: [], type: "hr" }, "not-the-secret", { expiresIn: "15m" });

async function loadApp(env: Record<string, string>): Promise<Express> {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import("../../src/app")).default;
}

afterAll(async () => {
  vi.unstubAllEnvs();
  await pipelineDb.$disconnect();
});

describe("pipeline read bucket (PIPELINE_RATE_READ_MAX=3)", () => {
  let app: Express;
  beforeAll(async () => {
    app = await loadApp({ PIPELINE_RATE_READ_MAX: "3" });
  });

  it("the 4th sync gets 429 PIPELINE_RATE_LIMIT with retryAfterSec, while HR reports and HR login are untouched", async () => {
    const edge = "162.158.10.1";
    const tok = hrToken("rate-user-1");
    for (let i = 0; i < 3; i++) {
      const r = await request(app).post("/v1/pipeline/sync").set("Authorization", `Bearer ${tok}`).set("X-Forwarded-For", edge).send({ clientBuild: 1 });
      expect(r.status).not.toBe(429);
    }
    // A 429 is answered before morgan is mounted, so the limiter itself leaves a trace —
    // one line per bucket per 10 s (the 2026-09-18 storm left none).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const limited = await request(app).post("/v1/pipeline/sync").set("Authorization", `Bearer ${tok}`).set("X-Forwarded-For", edge).send({ clientBuild: 1 });
    const again = await request(app).post("/v1/pipeline/sync").set("Authorization", `Bearer ${tok}`).set("X-Forwarded-For", edge).send({ clientBuild: 1 });
    const lines = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(again.status).toBe(429);
    expect(lines.filter((l) => l.includes("429 PIPELINE_RATE_LIMIT bucket=read"))).toHaveLength(1);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      success: false,
      error: { code: "PIPELINE_RATE_LIMIT", message: "Live updates paused for a moment", retryAfterSec: expect.any(Number) },
    });
    expect(limited.body.error.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(limited.body.error.retryAfterSec).toBeLessThanOrEqual(60);
    expect(limited.headers["cache-control"]).toBe("no-store");

    // The same user, the same edge — the rest of the HR portal is not rate limited.
    const reports = await request(app).get("/v1/hr/reports").set("Authorization", `Bearer ${tok}`).set("X-Forwarded-For", edge);
    expect(reports.status).not.toBe(429);
    const login = await request(app).post("/v1/hr/auth/login").set("X-Forwarded-For", edge).send({ identifier: "nobody@x.test", password: "wrong-password" });
    expect(login.status).not.toBe(429);

    // Another user on the same edge has their own pipeline bucket.
    const other = await request(app).post("/v1/pipeline/sync").set("Authorization", `Bearer ${hrToken("rate-user-2")}`).set("X-Forwarded-For", edge).send({ clientBuild: 1 });
    expect(other.status).not.toBe(429);
  });

  it("/V1/Pipeline/sync (any case) counts against the pipeline bucket", async () => {
    const tok = hrToken("rate-user-case");
    const paths = ["/V1/Pipeline/sync", "/v1/PIPELINE/Sync", "/v1/pipeline/sync"];
    for (const p of paths) {
      const r = await request(app).post(p).set("Authorization", `Bearer ${tok}`).send({ clientBuild: 1 });
      expect(r.status).not.toBe(429);
    }
    const limited = await request(app).post("/V1/Pipeline/SYNC").set("Authorization", `Bearer ${tok}`).send({ clientBuild: 1 });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("PIPELINE_RATE_LIMIT");
  });

  it("100 syncs with EXPIRED HR tokens from one IP are all 401, never 429 (keyed by user, not the edge IP)", async () => {
    const edge = "162.158.20.2";
    for (let i = 0; i < 100; i++) {
      const r = await request(app)
        .post("/v1/pipeline/sync")
        .set("Authorization", `Bearer ${hrToken(`expired-user-${i}`, -60)}`)
        .set("X-Forwarded-For", edge)
        .send({ clientBuild: 1 });
      expect(r.status).toBe(401);
    }
  });

  it("an unsigned or forged token is keyed by IP, so rotating fake user ids buys nothing", async () => {
    const edge = "203.0.113.77";
    for (let i = 0; i < 3; i++) {
      const r = await request(app).post("/v1/pipeline/sync").set("Authorization", `Bearer ${forged(`attacker-${i}`)}`).set("X-Forwarded-For", edge).send({ clientBuild: 1 });
      expect(r.status).toBe(401);
    }
    const r = await request(app).post("/v1/pipeline/sync").set("Authorization", `Bearer ${forged("attacker-99")}`).set("X-Forwarded-For", edge).send({ clientBuild: 1 });
    expect(r.status).toBe(429);
  });

  it("a 65 KB JSON body gets 413 in JSON; malformed JSON gets 400 INVALID_JSON; both are pipeline-only", async () => {
    const big = { clientBuild: 1, pad: "x".repeat(65 * 1024) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tooLarge = await request(app).post("/v1/pipeline/sync").set("X-Forwarded-For", "198.51.100.1").send(big);
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toMatchObject({ success: false, error: { code: "PAYLOAD_TOO_LARGE" } });
    expect(tooLarge.headers["content-type"]).toMatch(/application\/json/);

    const bad = await request(app)
      .post("/v1/pipeline/sync")
      .set("X-Forwarded-For", "198.51.100.2")
      .set("Content-Type", "application/json")
      .send('{"clientBuild": 1,');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ success: false, error: { code: "INVALID_JSON" } });
    // Both are answered at app level, before morgan, so they are logged (throttled) here.
    const lines = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    expect(lines.some((l) => l.includes("413 PAYLOAD_TOO_LARGE"))).toBe(true);
    expect(lines.some((l) => l.includes("400 INVALID_JSON"))).toBe(true);
    for (const r of [tooLarge, bad]) expect(r.headers["cache-control"]).toBe("no-store");

    // A non-JSON content type is still bounded and parsed as JSON (the pipeline accepts JSON only).
    const text = await request(app).post("/v1/pipeline/sync").set("X-Forwarded-For", "198.51.100.3").set("Content-Type", "text/plain").send("hello");
    expect(text.status).toBe(400);
    expect(text.body.error.code).toBe("INVALID_JSON");

    // Just under the limit is accepted by the parser (then rejected by auth, not by size).
    const ok = await request(app).post("/v1/pipeline/sync").set("X-Forwarded-For", "198.51.100.4").send({ clientBuild: 1, pad: "x".repeat(60 * 1024) });
    expect(ok.status).toBe(401);
    // Every pipeline response is no-store — including authenticate's 401.
    expect(ok.headers["cache-control"]).toBe("no-store");

    // The global 10 mb parser still serves everything else.
    const hr = await request(app).post("/v1/hr/auth/login").set("X-Forwarded-For", "198.51.100.5").send({ identifier: "x@x.test", password: "y".repeat(70 * 1024) });
    expect(hr.status).not.toBe(413);
  });
});

describe("the global limiter skips pipeline paths (RATE_LIMIT_MAX=3)", () => {
  let app: Express;
  beforeAll(async () => {
    app = await loadApp({ RATE_LIMIT_MAX: "3" });
  });

  it("10 pipeline calls are never 429, while a 4th non-pipeline call is", async () => {
    const tok = hrToken("global-user-1");
    const edge = "162.158.30.3";
    for (let i = 0; i < 10; i++) {
      const path = i % 2 ? "/V1/Pipeline/sync" : "/v1/pipeline/sync";
      const r = await request(app).post(path).set("Authorization", `Bearer ${tok}`).set("X-Forwarded-For", edge).send({ clientBuild: 1 });
      expect(r.status).not.toBe(429);
    }
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get("/v1/jobs").set("X-Forwarded-For", edge)).status).not.toBe(429);
    }
    expect((await request(app).get("/v1/jobs").set("X-Forwarded-For", edge)).status).toBe(429);
  });
});

describe("bucket classification, keys and the morgan skip (pure)", () => {
  let mod: typeof import("../../src/middleware/pipeline-rate-limit");
  let keys: typeof import("../../src/middleware/rate-limit-key");
  beforeAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    mod = await import("../../src/middleware/pipeline-rate-limit");
    keys = await import("../../src/middleware/rate-limit-key");
  });

  const req = (method: string, originalUrl: string, auth?: string, ip = "10.0.0.1") =>
    ({ method, originalUrl, url: originalUrl, path: originalUrl.split("?")[0], headers: auth ? { authorization: auth } : {}, ip }) as unknown as Request;

  it("classifies read, write and message requests", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(mod.pipelineBucketsOf(req("GET", `/v1/pipeline/projects/${id}`))).toEqual(["read"]);
    expect(mod.pipelineBucketsOf(req("GET", "/v1/pipeline/bootstrap?x=1"))).toEqual(["read"]);
    expect(mod.pipelineBucketsOf(req("POST", "/v1/pipeline/sync"))).toEqual(["read"]);
    expect(mod.pipelineBucketsOf(req("POST", "/V1/PIPELINE/SYNC/"))).toEqual(["read"]);
    expect(mod.pipelineBucketsOf(req("POST", `/v1/pipeline/projects/${id}/read`))).toEqual(["read"]);
    expect(mod.pipelineBucketsOf(req("POST", "/v1/pipeline/projects"))).toEqual(["write"]);
    expect(mod.pipelineBucketsOf(req("PATCH", `/v1/pipeline/projects/${id}`))).toEqual(["write"]);
    expect(mod.pipelineBucketsOf(req("PUT", `/v1/pipeline/messages/${id}/reactions/heart`))).toEqual(["write"]);
    expect(mod.pipelineBucketsOf(req("POST", `/v1/pipeline/projects/${id}/messages`))).toEqual(["write", "message"]);
    expect(mod.pipelineBucketsOf(req("GET", `/v1/pipeline/projects/${id}/messages`))).toEqual(["read"]);
  });

  it("keys a signature-valid token by user even when expired, and anything else by IP", () => {
    expect(keys.pipelineRateLimitKey(req("POST", "/v1/pipeline/sync", `Bearer ${hrToken("k-1")}`), "read")).toBe("p:read:hr:k-1");
    expect(keys.pipelineRateLimitKey(req("POST", "/v1/pipeline/sync", `Bearer ${hrToken("k-2", -60)}`), "read")).toBe("p:read:hr:k-2");
    expect(keys.pipelineRateLimitKey(req("POST", "/v1/pipeline/sync", `Bearer ${forged("k-3")}`, "10.9.9.9"), "write")).toBe("p:write:ip:10.9.9.9");
    expect(keys.pipelineRateLimitKey(req("POST", "/v1/pipeline/sync", "Bearer garbage", "10.9.9.8"), "message")).toBe("p:message:ip:10.9.9.8");
    expect(keys.pipelineRateLimitKey(req("POST", "/v1/pipeline/sync", undefined, "10.9.9.7"), "read")).toBe("p:read:ip:10.9.9.7");
    const typeless = jwt.sign({ userId: "k-4" }, SECRET, { expiresIn: "7d" });
    expect(keys.pipelineRateLimitKey(req("GET", "/v1/pipeline/bootstrap", `Bearer ${typeless}`), "read")).toBe("p:read:x:k-4");
  });

  it("isPipelinePath is case-insensitive and exact on the prefix", () => {
    const p = (path: string) => keys.isPipelinePath({ path } as Request);
    expect(p("/v1/pipeline")).toBe(true);
    expect(p("/v1/pipeline/sync")).toBe(true);
    expect(p("/V1/Pipeline/Sync")).toBe(true);
    expect(p("/v1/pipelines")).toBe(false);
    expect(p("/v1/pipelinex/sync")).toBe(false);
    expect(p("/v1/hr/reports")).toBe(false);
  });

  it("morgan skips only successful POST /v1/pipeline/sync lines", () => {
    const res = (statusCode: number) => ({ statusCode }) as Response;
    expect(mod.skipPipelineSyncLog(req("POST", "/v1/pipeline/sync"), res(200))).toBe(true);
    expect(mod.skipPipelineSyncLog(req("POST", "/V1/Pipeline/sync?x=1"), res(304))).toBe(true);
    expect(mod.skipPipelineSyncLog(req("POST", "/v1/pipeline/sync"), res(429))).toBe(false);
    expect(mod.skipPipelineSyncLog(req("POST", "/v1/pipeline/sync"), res(503))).toBe(false);
    expect(mod.skipPipelineSyncLog(req("GET", "/v1/pipeline/sync"), res(200))).toBe(false);
    expect(mod.skipPipelineSyncLog(req("POST", "/v1/pipeline/projects"), res(201))).toBe(false);
    expect(mod.skipPipelineSyncLog(req("POST", "/v1/hr/reports"), res(200))).toBe(false);
  });
});
