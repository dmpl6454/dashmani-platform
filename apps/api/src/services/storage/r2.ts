/**
 * Cloudflare R2 (S3-compatible) — signed URLs only (2026-11-02).
 *
 * The browser uploads and downloads straight from R2 with short-lived pre-signed URLs, so the
 * API never holds a file's bytes (the 49 GB box filled up on 2026-10-25). The API itself makes
 * one small request per file: a HEAD, to check what was actually stored before a version points
 * at it.
 *
 * AWS Signature Version 4, query-string form, hand-rolled with node:crypto (no SDK). It is
 * checked against the worked example in AWS's documentation ("Authenticating Requests: Using
 * Query Parameters"), see tests/pipeline/uploads.test.ts.
 *
 * Config (apps/api/.env, runtime only):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *   R2_ENDPOINT (optional; default https://<account>.r2.cloudflarestorage.com)
 * Missing any of the four → uploads are off (r2Config() returns null).
 */
import crypto from "crypto";

export interface R2Config {
  endpoint: string; // https://host[:port], no trailing slash
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function r2Config(): R2Config | null {
  const account = (process.env.R2_ACCOUNT_ID ?? "").trim();
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY ?? "").trim();
  const bucket = (process.env.R2_BUCKET ?? "").trim();
  const endpoint = ((process.env.R2_ENDPOINT ?? "").trim() || (account ? `https://${account}.r2.cloudflarestorage.com` : "")).replace(/\/+$/, "");
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey };
}

/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone). */
export function uriEncode(s: string, keepSlash = false): string {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? out.replace(/%2F/g, "/") : out;
}

const sha256Hex = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: Buffer | string, s: string) => crypto.createHmac("sha256", key).update(s, "utf8").digest();

export interface PresignInput {
  method: string;
  host: string;
  /** Absolute path, e.g. /bucket/key — encoded here (slashes kept). */
  path: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
  expiresSec: number;
  /** Extra query parameters to sign (e.g. response-content-disposition). */
  query?: Record<string, string>;
  /** Headers the client must send exactly, besides host (lower-case names). */
  headers?: Record<string, string>;
}

/** Returns the signed query string (without "?"), in canonical order. */
export function presignQuery(p: PresignInput): string {
  const amzDate = p.date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20130524T000000Z
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${p.region}/${p.service}/aws4_request`;
  const headers: Record<string, string> = { host: p.host };
  for (const [k, v] of Object.entries(p.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(";");

  const params: Record<string, string> = {
    ...(p.query ?? {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${p.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(p.expiresSec),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join("&");
  const canonicalHeaders = headerNames.map((h) => `${h}:${headers[h]}\n`).join("");
  const canonicalRequest = [
    p.method.toUpperCase(),
    uriEncode(p.path, true),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${p.secretAccessKey}`, day);
  const kRegion = hmac(kDate, p.region);
  const kService = hmac(kRegion, p.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return `${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** A pre-signed URL for one object in the bucket (path-style, region "auto"). */
export function presignR2(
  cfg: R2Config,
  method: "GET" | "PUT" | "HEAD",
  key: string,
  expiresSec: number,
  opts: { query?: Record<string, string>; headers?: Record<string, string>; now?: Date } = {},
): string {
  const url = new URL(cfg.endpoint);
  const path = `${url.pathname.replace(/\/+$/, "")}/${cfg.bucket}/${key}`;
  const qs = presignQuery({
    method,
    host: url.host,
    path,
    region: "auto",
    service: "s3",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    date: opts.now ?? new Date(),
    expiresSec,
    query: opts.query,
    headers: opts.headers,
  });
  return `${url.protocol}//${url.host}${uriEncode(path, true)}?${qs}`;
}

export interface R2Object {
  size: number;
  contentType: string;
}

/** What R2 holds at `key`, or null when nothing is there. Throws on anything unexpected. */
export async function headR2Object(cfg: R2Config, key: string, timeoutMs = 8000): Promise<R2Object | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(presignR2(cfg, "HEAD", key, 60), { method: "HEAD", signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`R2 HEAD answered ${res.status}`);
    const size = Number(res.headers.get("content-length") ?? NaN);
    return { size: Number.isFinite(size) ? size : -1, contentType: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() };
  } finally {
    clearTimeout(timer);
  }
}
