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

/**
 * Header-signed request (Authorization header form of Signature V4) — for the bucket-level
 * list and object DELETE the cleanup job makes. Checked against AWS's worked "GET Object"
 * example in tests/pipeline/uploads.test.ts. Returns the headers to send (host excluded —
 * fetch sets it from the URL).
 */
export function signHeaders(p: {
  method: string;
  host: string;
  path: string;
  query?: Record<string, string>;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
  headers?: Record<string, string>;
  payloadHash?: string;
}): Record<string, string> {
  const amzDate = p.date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${p.region}/${p.service}/aws4_request`;
  const payloadHash = p.payloadHash ?? "UNSIGNED-PAYLOAD";
  const headers: Record<string, string> = { host: p.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  for (const [k, v] of Object.entries(p.headers ?? {})) headers[k.toLowerCase()] = v.trim();
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const q = p.query ?? {};
  const canonicalQuery = Object.keys(q)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(q[k])}`)
    .join("&");
  const canonicalRequest = [
    p.method.toUpperCase(),
    uriEncode(p.path, true),
    canonicalQuery,
    names.map((h) => `${h}:${headers[h]}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${p.secretAccessKey}`, day), p.region), p.service), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const out: Record<string, string> = {};
  for (const h of names) if (h !== "host") out[h] = headers[h];
  out.authorization = `AWS4-HMAC-SHA256 Credential=${p.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

async function r2Request(
  cfg: R2Config,
  method: "GET" | "DELETE",
  key: string | null,
  query: Record<string, string> = {},
  timeoutMs = 15_000,
): Promise<{ status: number; ok: boolean; body: string }> {
  const url = new URL(cfg.endpoint);
  const path = `${url.pathname.replace(/\/+$/, "")}/${cfg.bucket}${key ? `/${key}` : ""}`;
  const headers = signHeaders({
    method, host: url.host, path, query, region: "auto", service: "s3",
    accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, date: new Date(),
  });
  const qs = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join("&");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.protocol}//${url.host}${uriEncode(path, true)}${qs ? `?${qs}` : ""}`, { method, headers, signal: ctrl.signal });
    // Read the body inside the abort window (a slow body is bounded too).
    const body = await res.text();
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Text between the first `<tag>` and its `</tag>` after `from` (linear; no regex over the body). */
function between(xml: string, tag: string, from: number): { text: string; end: number } | null {
  const open = xml.indexOf(`<${tag}>`, from);
  if (open < 0) return null;
  const start = open + tag.length + 2;
  const close = xml.indexOf(`</${tag}>`, start);
  if (close < 0) return null;
  return { text: xml.slice(start, close), end: close + tag.length + 3 };
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export interface R2Listing {
  objects: Array<{ key: string; size: number; lastModified: Date }>;
  /** More keys follow; pass the last key as `startAfter`. */
  truncated: boolean;
}

/** One page (≤ 1000) of keys under `prefix`, in key order, after `startAfter`. */
export async function listR2Objects(cfg: R2Config, prefix: string, startAfter: string | null, maxKeys = 1000): Promise<R2Listing> {
  const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": String(maxKeys) };
  if (startAfter) query["start-after"] = startAfter;
  const res = await r2Request(cfg, "GET", null, query);
  const xml = res.body;
  if (!res.ok) throw new Error(`R2 list answered ${res.status}`);
  const objects: R2Listing["objects"] = [];
  let at = 0;
  for (;;) {
    const item = between(xml, "Contents", at);
    if (!item) break;
    at = item.end;
    const key = between(item.text, "Key", 0);
    const mod = between(item.text, "LastModified", 0);
    const size = between(item.text, "Size", 0);
    if (!key || !mod) continue;
    objects.push({ key: unescapeXml(key.text), size: Number(size?.text ?? -1), lastModified: new Date(mod.text) });
  }
  return { objects, truncated: between(xml, "IsTruncated", 0)?.text === "true" };
}

/** Delete one object. A missing object counts as deleted (S3 answers 204 either way). */
export async function deleteR2Object(cfg: R2Config, key: string): Promise<void> {
  const res = await r2Request(cfg, "DELETE", key);
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw new Error(`R2 delete answered ${res.status}`);
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
  /** When the object was stored, or null when R2 did not say. */
  lastModified: Date | null;
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
    const lm = res.headers.get("last-modified");
    const lastModified = lm ? new Date(lm) : null;
    return {
      size: Number.isFinite(size) ? size : -1,
      contentType: (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(),
      lastModified: lastModified && !Number.isNaN(lastModified.getTime()) ? lastModified : null,
    };
  } finally {
    clearTimeout(timer);
  }
}
