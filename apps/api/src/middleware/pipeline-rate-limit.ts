/**
 * The pipeline's isolated rate-limit buckets and body parser (spec §3.1, §8.1, P13).
 *
 * WHY SEPARATE BUCKETS. The pipeline polls every ~10 s per open tab. If that traffic
 * shared the global 1000-per-15-min bucket, a few busy tabs could 429 the same user's HR
 * submit, Link History or accounts — the 2026-09-18 storm class. So the global limiter
 * SKIPS /v1/pipeline/* (isPipelinePath) and these three limiters count it instead, each
 * with its own MemoryStore and a 1-minute window (a 429 clears within 60 s):
 *
 *   read    — GET/HEAD, POST /sync, POST /projects/:id/read   120 / min per user
 *   write   — every other method                                120 / min per user
 *   message — POST /projects/:id/messages (ALSO counted in write) 40 / min per user
 *
 * Keys come from pipelineRateLimitKey: per user even for an EXPIRED (but genuine) token.
 * PIPELINE_RATE_READ_MAX / _WRITE_MAX / _MSG_MAX override the ceilings (tests only).
 *
 * All of this is in-process and disposable: a restart resets the counters (one process).
 */
import express, { type Request, type Response, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { envInt, pipelineRateLimitKey } from "./rate-limit-key";
import { pipelineStats } from "../services/pipeline/stats";
import { warnThrottled } from "../utils/throttled-warn";

export type PipelineBucket = "read" | "write" | "message";

const WINDOW_MS = 60_000;

/** Lowercased path without the query string or one trailing slash. */
function fullPathLower(req: Pick<Request, "originalUrl" | "url">): string {
  const raw = (req.originalUrl || req.url || "").split("?")[0].toLowerCase();
  return raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/** Segments after `/v1/pipeline`, e.g. ["projects", "<id>", "messages"]. */
function pipelineSegments(req: Pick<Request, "originalUrl" | "url">): string[] {
  const parts = fullPathLower(req).split("/").filter(Boolean);
  // parts[0] = "v1", parts[1] = "pipeline"
  return parts.slice(2);
}

/** Which pipeline buckets a request counts against (spec §8.1). */
export function pipelineBucketsOf(req: Pick<Request, "method" | "originalUrl" | "url">): PipelineBucket[] {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return ["read"];
  const seg = pipelineSegments(req);
  if (method === "POST" && seg.length === 1 && seg[0] === "sync") return ["read"];
  if (method === "POST" && seg.length === 3 && seg[0] === "projects" && seg[2] === "read") return ["read"];
  if (method === "POST" && seg.length === 3 && seg[0] === "projects" && seg[2] === "messages") return ["write", "message"];
  return ["write"];
}

function retryAfterSecOf(req: Request): number {
  const info = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit;
  const reset = info?.resetTime instanceof Date ? info.resetTime.getTime() : Date.now() + WINDOW_MS;
  return Math.min(60, Math.max(1, Math.ceil((reset - Date.now()) / 1000)));
}

function makeLimiter(bucket: PipelineBucket, limit: number): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    keyGenerator: (req) => pipelineRateLimitKey(req, bucket),
    skip: (req) => !pipelineBucketsOf(req).includes(bucket),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const retryAfterSec = retryAfterSecOf(req);
      // ⚠️ Answered before morgan is mounted: without this line a 429 storm (the
      // 2026-09-18 class) leaves no trace in the API log. One line per bucket per 10 s.
      warnThrottled(`429:${bucket}`, `[pipeline] 429 PIPELINE_RATE_LIMIT bucket=${bucket}`);
      pipelineStats.rateLimited(bucket);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        success: false,
        error: { code: "PIPELINE_RATE_LIMIT", message: "Live updates paused for a moment", retryAfterSec },
      });
    },
  });
}

/**
 * Every /v1/pipeline response is `Cache-Control: no-store` (spec §3.2) — including the
 * ones pipeline code never writes: authenticate's 401 and validate()'s 400. Mounted first,
 * before the limiters; later setHeader calls (ok(), the error middleware) agree with it.
 */
export const pipelineNoStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

/**
 * Mounted as `app.use("/v1/pipeline", pipelineNoStore, pipelineRateLimiter)` right after
 * the global limiter (and after cors, so preflights never count).
 */
export const pipelineRateLimiter: RequestHandler[] = [
  makeLimiter("read", envInt("PIPELINE_RATE_READ_MAX", 120)),
  makeLimiter("write", envInt("PIPELINE_RATE_WRITE_MAX", 120)),
  makeLimiter("message", envInt("PIPELINE_RATE_MSG_MAX", 40)),
];

/**
 * The pipeline body parser: 64 kb, JSON only. Mounted BEFORE the global 10 mb
 * express.json(), which then skips the request (body-parser sets req._body). It parses
 * every content type as JSON so no pipeline body can reach the larger global parsers by
 * sending another Content-Type — a non-JSON body is simply 400 INVALID_JSON. Its errors
 * are answered in JSON by pipelineErrorMiddleware mounted right after it.
 */
export const pipelineJson: RequestHandler = express.json({ limit: "64kb", type: () => true });

/** morgan `skip` (P13): successful POST /v1/pipeline/sync lines are not logged. */
export function skipPipelineSyncLog(req: Request, res: Response): boolean {
  return req.method === "POST" && fullPathLower(req) === "/v1/pipeline/sync" && res.statusCode < 400;
}
