import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

// Production API. Point at http://<your-mac-ip>:4000/v1 for local dev.
// Builds (EAS) always talk to production. EXPO_PUBLIC_API_URL exists only for local test runs
// (`EXPO_PUBLIC_API_URL=http://localhost:4000/v1 npx expo start --ios`); it is never set in eas.json.
export const API_URL = process.env.EXPO_PUBLIC_API_URL || "https://api.digitalsukoon.com/v1";
/** Base URL without /v1 — used for static file URLs like /uploads/ */
export const API_BASE = API_URL.replace(/\/v1\/?$/, "");

/** Every request is aborted after this long (ms) unless `timeoutMs` says otherwise. */
export const REQUEST_TIMEOUT_MS = 20000;

/** fetch options plus an optional per-request timeout. */
export type RequestOptions = RequestInit & { timeoutMs?: number };

/** Cursor-pagination envelope meta (`{ success, data, meta }`). */
export type PageMeta = { cursor?: string | null; has_more: boolean; limit?: number };

/** Which portal the session belongs to — mirrors the two web portals:
 *  "hr"    → hr.digitalsukoon.com     (employee portal, /hr/* endpoints)
 *  "admin" → portal.digitalsukoon.com (internal portal, /admin/* + RBAC endpoints)
 */
export type PortalMode = "hr" | "admin";

const KEYS = {
  mode: "portalMode",
  hr: { access: "hrAccessToken", refresh: "hrRefreshToken", user: "hrUser" },
  admin: { access: "accessToken", refresh: "refreshToken", user: "adminUser" },
};

const MSG = {
  network: "Couldn't reach the server. Check your connection and try again.",
  timeout: "The server is taking too long. Check your connection and try again.",
  unexpected: "The server returned an unexpected answer. Try again.",
  cancelled: "The request was cancelled.",
};

// Storage adapter: SecureStore is native-only — on web fall back to localStorage
// (wrapped in try/catch: private windows / blocked site data throw on access).
const store = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === "web") {
      try {
        return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
      } catch {
        return null;
      }
    }
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") {
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
      } catch {
        /* storage unavailable */
      }
      return;
    }
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      /* storage unavailable */
    }
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === "web") {
      try {
        if (typeof localStorage !== "undefined") localStorage.removeItem(key);
      } catch {
        /* storage unavailable */
      }
      return;
    }
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      /* storage unavailable */
    }
  },
};

export class ApiError extends Error {
  code?: string;
  details?: Array<{ field: string; message: string }>;
  /** HTTP status, when the server answered. */
  status?: number;
  /** Seconds to wait before retrying (429 / 503 capacity answers). */
  retryAfterSec?: number;
  constructor(message: string, code?: string, details?: Array<{ field: string; message: string }>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

export type SessionUser = {
  id: string;
  name: string;
  email: string | null;
  phone?: string | null;
  profileImageUrl: string | null;
  roles: string[];
};

// ---- small type guards ----
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function headersToRecord(h: HeadersInit | undefined): Record<string, string> {
  if (!h) return {};
  if (Array.isArray(h)) {
    const out: Record<string, string> = {};
    h.forEach(([k, v]) => {
      out[k] = v;
    });
    return out;
  }
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  return { ...(h as Record<string, string>) };
}

function retryAfterHeader(res: Response): number | undefined {
  const raw = res.headers?.get?.("Retry-After");
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseDetails(v: unknown): Array<{ field: string; message: string }> | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Array<{ field: string; message: string }> = [];
  for (const item of v as unknown[]) {
    if (!isRecord(item)) continue;
    const f = item.field ?? item.path;
    const field = Array.isArray(f)
      ? (f as unknown[]).map((p) => String(p)).join(".")
      : typeof f === "string"
        ? f
        : typeof f === "number"
          ? String(f)
          : "";
    const message = typeof item.message === "string" ? item.message : "";
    if (message) out.push({ field, message });
  }
  return out;
}

/** Build an ApiError from a `{ success: false, error }` envelope. */
function errorFromBody(body: Record<string, unknown>, res: Response, fallback: string): ApiError {
  const e = body.error;
  const message =
    isRecord(e) && typeof e.message === "string" && e.message
      ? e.message
      : typeof e === "string" && e
        ? e
        : fallback;
  const code = isRecord(e) && typeof e.code === "string" ? e.code : undefined;
  const err = new ApiError(message, code, isRecord(e) ? parseDetails(e.details) : undefined);
  err.status = res.status;
  if (isRecord(e) && typeof e.retryAfterSec === "number") err.retryAfterSec = e.retryAfterSec;
  else if (res.status === 429 || res.status === 503) err.retryAfterSec = retryAfterHeader(res);
  return err;
}

// ---- Transport: one fetch with a timeout, the body read included ----
type RawResponse = { res: Response; text: string };

async function send(url: string, init: RequestOptions): Promise<RawResponse> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, signal: callerSignal, ...rest } = init;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort);
  }
  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const text = await res.text();
    return { res, text };
  } catch {
    if (timedOut) throw new ApiError(MSG.timeout, "TIMEOUT");
    if (callerSignal?.aborted) throw new ApiError(MSG.cancelled, "ABORTED");
    throw new ApiError(MSG.network, "NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

// ---- Mode ----
let modeCache: PortalMode | null = null;

export async function getMode(): Promise<PortalMode> {
  if (modeCache) return modeCache;
  const m = await store.get(KEYS.mode);
  modeCache = m === "admin" ? "admin" : "hr";
  return modeCache;
}

export async function setMode(mode: PortalMode) {
  modeCache = mode;
  await store.set(KEYS.mode, mode);
}

function keysFor(mode: PortalMode) {
  return mode === "admin" ? KEYS.admin : KEYS.hr;
}

// ---- Session ----
export async function getStoredUser(mode?: PortalMode): Promise<SessionUser | null> {
  const m = mode ?? (await getMode());
  try {
    const raw = await store.get(keysFor(m).user);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export async function storeSession(mode: PortalMode, accessToken: string, refreshToken: string, user?: SessionUser) {
  const k = keysFor(mode);
  await store.set(k.access, accessToken);
  await store.set(k.refresh, refreshToken);
  if (user) await store.set(k.user, JSON.stringify(user));
}

export async function clearSession(mode?: PortalMode) {
  const m = mode ?? (await getMode());
  const k = keysFor(m);
  await store.remove(k.access);
  await store.remove(k.refresh);
  await store.remove(k.user);
}

export async function hasSession(mode?: PortalMode): Promise<boolean> {
  const m = mode ?? (await getMode());
  const t = await store.get(keysFor(m).access);
  return !!t;
}

function roleName(r: unknown): string {
  if (typeof r === "string") return r;
  if (!isRecord(r)) return "";
  if (isRecord(r.role) && typeof r.role.name === "string") return r.role.name;
  return typeof r.name === "string" ? r.name : "";
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Normalise a server user object (roles may be strings or `{ role: { name } }`). */
function toSessionUser(raw: unknown): SessionUser | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id : typeof raw.id === "number" ? String(raw.id) : "";
  if (!id) return null;
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : "",
    email: strOrNull(raw.email),
    phone: strOrNull(raw.phone),
    profileImageUrl: strOrNull(raw.profileImageUrl),
    roles: Array.isArray(raw.roles) ? (raw.roles as unknown[]).map(roleName).filter(Boolean) : [],
  };
}

// ---- Single-flight token refresh (per portal) ----
// Refresh tokens are SINGLE-USE on the server (rotated on every refresh).
// If several requests 401 at once, only ONE refresh call may fire — the rest
// must await the same promise, or the losers would burn the rotated token
// and log the user out (the exact parallel-401 bug fixed on web, PR #138).
//
// Outcomes:
//   "ok"        → new tokens stored, retry the request
//   "rejected"  → the server refused the refresh token (400/401/403) → sign out
//   "transient" → network failure / timeout / 5xx / 429 → tokens KEPT, the request fails softly
type RefreshResult = "ok" | "rejected" | "transient";
const refreshInFlight: Partial<Record<PortalMode, Promise<RefreshResult> | null>> = {};
/** Why the last transient refresh failed — surfaced as the original request's error code. */
const lastTransientCode: Partial<Record<PortalMode, "NETWORK_ERROR" | "TIMEOUT">> = {};

async function tryRefresh(mode: PortalMode): Promise<RefreshResult> {
  const existing = refreshInFlight[mode];
  if (existing) return existing;
  const p = (async (): Promise<RefreshResult> => {
    try {
      const k = keysFor(mode);
      const refreshToken = await store.get(k.refresh);
      if (!refreshToken) return "rejected";
      const endpoint = mode === "admin" ? "/auth/refresh" : "/hr/auth/refresh";
      let raw: RawResponse;
      try {
        raw = await send(`${API_URL}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
      } catch (e: unknown) {
        lastTransientCode[mode] = e instanceof ApiError && e.code === "TIMEOUT" ? "TIMEOUT" : "NETWORK_ERROR";
        return "transient";
      }
      const { res, text } = raw;
      if (res.status === 400 || res.status === 401 || res.status === 403) return "rejected";
      if (!res.ok) {
        lastTransientCode[mode] = "NETWORK_ERROR";
        return "transient";
      }
      const parsed = parseJson(text);
      const body = parsed.ok && isRecord(parsed.value) ? parsed.value : null;
      const d = body && body.success && isRecord(body.data) ? body.data : null;
      if (!d || typeof d.accessToken !== "string" || !d.accessToken) {
        lastTransientCode[mode] = "NETWORK_ERROR";
        return "transient";
      }
      const nextRefresh = typeof d.refreshToken === "string" && d.refreshToken ? d.refreshToken : refreshToken;
      // Only overwrite the stored user when the answer carries a full one (with roles).
      const user = isRecord(d.user) && Array.isArray(d.user.roles) ? toSessionUser(d.user) : null;
      await storeSession(mode, d.accessToken, nextRefresh, user ?? undefined);
      return "ok";
    } catch {
      lastTransientCode[mode] = "NETWORK_ERROR";
      return "transient";
    } finally {
      setTimeout(() => {
        refreshInFlight[mode] = null;
      }, 0);
    }
  })();
  refreshInFlight[mode] = p;
  return p;
}

/** Set by AuthProvider — called when the session is unrecoverable (refresh rejected). */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn;
}

type Envelope = { data: unknown; meta: unknown };

async function requestEnvelope(mode: PortalMode, path: string, options: RequestOptions, retried: boolean): Promise<Envelope> {
  const token = await store.get(keysFor(mode).access);
  const { headers, ...rest } = options;

  const { res, text } = await send(`${API_URL}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headersToRecord(headers),
    },
  });

  if (res.status === 401 && !retried) {
    const outcome = await tryRefresh(mode);
    if (outcome === "ok") return requestEnvelope(mode, path, options, true);
    if (outcome === "transient") {
      const code = lastTransientCode[mode] ?? "NETWORK_ERROR";
      throw new ApiError(code === "TIMEOUT" ? MSG.timeout : MSG.network, code);
    }
    await clearSession(mode);
    if (mode === (await getMode())) onSessionExpired?.();
    const err = new ApiError("Session expired. Please sign in again.", "UNAUTHORIZED");
    err.status = 401;
    throw err;
  }

  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    const err =
      res.status >= 500
        ? new ApiError("The server returned an error. Please try again.", "SERVER_ERROR")
        : new ApiError(`Unexpected server response (status ${res.status}).`, "NON_JSON_RESPONSE");
    err.status = res.status;
    throw err;
  }

  const body = parsed.value;
  if (!body.success) throw errorFromBody(body, res, `Request failed (status ${res.status}).`);
  return { data: body.data, meta: body.meta };
}

// `T = any` is kept deliberately: ~60 untouched screens call apiFetch without a type
// argument and read fields off the result. New code should pass an explicit T.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiFetch<T = any>(path: string, options: RequestOptions = {}, _retried = false): Promise<T> {
  return apiFetchFor<T>(await getMode(), path, options, _retried);
}

/**
 * apiFetch with an explicit portal session — e.g. Pipeline, which only accepts HR tokens, is
 * reachable from the admin portal when the person also has an HR session. A failed refresh of
 * a session that is NOT the active one never signs the user out of the active portal.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function apiFetchFor<T = any>(
  mode: PortalMode,
  path: string,
  options: RequestOptions = {},
  _retried = false,
): Promise<T> {
  const env = await requestEnvelope(mode, path, options, _retried);
  return env.data as T;
}

function toPageMeta(meta: unknown): PageMeta {
  if (!isRecord(meta)) return { has_more: false };
  const out: PageMeta = { has_more: meta.has_more === true || meta.hasMore === true };
  if (typeof meta.cursor === "string" || meta.cursor === null) out.cursor = meta.cursor;
  else if (typeof meta.nextCursor === "string" || meta.nextCursor === null) out.cursor = meta.nextCursor;
  if (typeof meta.limit === "number") out.limit = meta.limit;
  return out;
}

/** GET a cursor-paginated list: `{ items: envelope.data, meta: envelope.meta ?? { has_more: false } }`. */
export async function apiFetchPage<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<{ items: T[]; meta: PageMeta }> {
  const env = await requestEnvelope(await getMode(), path, options, false);
  const data = env.data;
  const items = Array.isArray(data)
    ? (data as T[])
    : isRecord(data) && Array.isArray(data.items)
      ? (data.items as T[])
      : [];
  return { items, meta: toPageMeta(env.meta) };
}

/** Append query params, skipping null / undefined / "". */
export function withQuery(path: string, q: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = [];
  Object.keys(q).forEach((k) => {
    const v = q[k];
    if (v === null || v === undefined || v === "") return;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  });
  if (parts.length === 0) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

// ---- Error helpers ----
export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function errorMessage(e: unknown, fallback = "Something went wrong. Please try again."): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return fallback;
}

export function errorStatus(e: unknown): number | null {
  return isApiError(e) && typeof e.status === "number" ? e.status : null;
}

/** True when the request never got an answer (offline / timed out). */
export function isNetworkError(e: unknown): boolean {
  return isApiError(e) && (e.code === "NETWORK_ERROR" || e.code === "TIMEOUT");
}

export function fieldErrors(e: unknown): Array<{ field: string; message: string }> {
  return isApiError(e) && Array.isArray(e.details) ? e.details : [];
}

/** `{ "links.0.platform": "Required" }` — first message per field. */
export function fieldErrorMap(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  fieldErrors(e).forEach((d) => {
    if (!(d.field in out)) out[d.field] = d.message;
  });
  return out;
}

/** Per-row errors of an array field: `rowErrors(e, "links")` maps "links.0.platform" → `{ 0: "…" }`. */
export function rowErrors(e: unknown, prefix: string): Record<number, string> {
  const out: Record<number, string> = {};
  fieldErrors(e).forEach((d) => {
    const parts = d.field.split(".");
    if (parts.length < 2 || parts[0] !== prefix || parts[1] === "") return;
    const idx = Number(parts[1]);
    if (!Number.isInteger(idx) || idx < 0) return;
    if (out[idx] === undefined) out[idx] = d.message;
  });
  return out;
}

function isIndex(p: string): boolean {
  return p !== "" && Number.isInteger(Number(p)) && Number(p) >= 0;
}

function detailLabel(field: string): string {
  const parts = field.split(".").filter(Boolean);
  const named = parts.filter((p) => !isIndex(p));
  const idx = parts.find(isIndex);
  const last = named.length > 0 ? named[named.length - 1] : "";
  if (!last) return "";
  return idx !== undefined ? `${last} (row ${Number(idx) + 1})` : last;
}

/** One readable sentence: message + up to two field details; rate limits say how long to wait. */
export function describeError(e: unknown, fallback = "Something went wrong. Please try again."): string {
  if (isApiError(e)) {
    const limited =
      e.status === 429 || e.code === "RATE_LIMIT" || e.code === "RATE_LIMITED" || e.code === "TOO_MANY_REQUESTS";
    if (limited && typeof e.retryAfterSec === "number" && e.retryAfterSec > 0) {
      return `Too many attempts — try again in ${Math.ceil(e.retryAfterSec)}s`;
    }
    const base = e.message || fallback;
    const extra = fieldErrors(e)
      .filter((d) => d.message !== base)
      .slice(0, 2)
      .map((d) => {
        const label = detailLabel(d.field);
        return label ? `${label}: ${d.message}` : d.message;
      });
    return extra.length > 0 ? `${base} — ${extra.join("; ")}` : base;
  }
  return errorMessage(e, fallback);
}

// ---- Auth calls ----
export async function loginWithPassword(mode: PortalMode, identifier: string, password: string) {
  const endpoint = mode === "admin" ? "/auth/login" : "/hr/auth/login";
  const body = mode === "admin" ? { email: identifier, password } : { identifier, password };
  return postLogin(mode, endpoint, body, "Invalid credentials");
}

/**
 * Sign in with a Google ID token (from the iOS app's own Google client). The API verifies it
 * with Google and signs in the account with that verified email: /auth/google never creates an
 * admin-portal account; /hr/auth/google creates an employee account for a new email, exactly as
 * the HR website does.
 */
export async function loginWithGoogle(mode: PortalMode, credential: string) {
  const endpoint = mode === "admin" ? "/auth/google" : "/hr/auth/google";
  return postLogin(mode, endpoint, { credential }, "Google sign-in failed");
}

async function postLogin(mode: PortalMode, endpoint: string, body: Record<string, unknown>, fallback: string) {
  const { res, text } = await send(`${API_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = parseJson(text);
  const json = parsed.ok && isRecord(parsed.value) ? parsed.value : null;

  if (res.status === 429) {
    const e = json && isRecord(json.error) ? json.error : null;
    const err = new ApiError(
      e && typeof e.message === "string" && e.message ? e.message : "Too many sign-in attempts. Wait a moment and try again.",
      "RATE_LIMIT",
      e ? parseDetails(e.details) : undefined,
    );
    err.status = 429;
    err.retryAfterSec = e && typeof e.retryAfterSec === "number" ? e.retryAfterSec : retryAfterHeader(res);
    throw err;
  }
  if (!json) {
    const err = new ApiError(MSG.unexpected, "NON_JSON_RESPONSE");
    err.status = res.status;
    throw err;
  }
  if (!json.success) throw errorFromBody(json, res, fallback);

  const d = isRecord(json.data) ? json.data : null;
  const sessionUser = d ? toSessionUser(d.user) : null;
  if (!d || typeof d.accessToken !== "string" || typeof d.refreshToken !== "string" || !sessionUser) {
    const err = new ApiError(MSG.unexpected, "NON_JSON_RESPONSE");
    err.status = res.status;
    throw err;
  }
  await storeSession(mode, d.accessToken, d.refreshToken, sessionUser);
  await setMode(mode);
  return sessionUser;
}

// ---- Date helpers (IST — matches server-side todayIST) ----
// All formatting is done by hand from UTC parts shifted to IST, so the output does not
// depend on the device time zone or on the JS engine's Intl support.
const IST_OFFSET_MIN = 330;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86400000;

type DayParts = { y: number; m: number; d: number; wd: number; h: number; min: number; dateOnly: boolean };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function ymdOf(p: { y: number; m: number; d: number }): string {
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

function istParts(date: Date): DayParts {
  const t = new Date(date.getTime() + IST_OFFSET_MIN * 60000);
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth() + 1,
    d: t.getUTCDate(),
    wd: t.getUTCDay(),
    h: t.getUTCHours(),
    min: t.getUTCMinutes(),
    dateOnly: false,
  };
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isISODate(s: string): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** A bare YYYY-MM-DD is split (never parsed as an instant); anything else is an instant shown in IST. */
function parseDay(input: string | null | undefined): DayParts | null {
  if (!input) return null;
  const s = String(input).trim();
  if (isISODate(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return { y, m, d, wd: new Date(Date.UTC(y, m - 1, d)).getUTCDay(), h: 0, min: 0, dateOnly: true };
  }
  const t = new Date(s);
  if (isNaN(t.getTime())) return null;
  return istParts(t);
}

function utcDayNumber(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

export function todayIST(): string {
  return ymdOf(istParts(new Date()));
}

/** N days before today (IST), as YYYY-MM-DD */
export function daysAgoIST(n: number): string {
  return addDaysISO(todayIST(), -n);
}

/** The IST calendar day (YYYY-MM-DD) of a date or instant; null when unparseable. */
export function istDateOf(input: string | null | undefined): string | null {
  const p = parseDay(input);
  return p ? ymdOf(p) : null;
}

/** YYYY-MM-DD shifted by n calendar days. Returns the input unchanged when it is not a valid date. */
export function addDaysISO(ymd: string, n: number): string {
  if (!isISODate(ymd)) return ymd;
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return ymdOf({ y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() });
}

/** Working days from start to end inclusive; Sundays are excluded (company rule). */
export function workingDaysBetween(start: string, end: string): number {
  if (!isISODate(start) || !isISODate(end)) return 0;
  const a = utcDayNumber(start);
  const b = utcDayNumber(end);
  if (b < a) return 0;
  let n = 0;
  for (let day = a; day <= b; day += 1) {
    if (new Date(day * DAY_MS).getUTCDay() !== 0) n += 1;
  }
  return n;
}

/** "29 Oct 2026" (IST). */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const p = parseDay(iso);
  if (!p) return String(iso).slice(0, 10);
  return `${p.d} ${MON[p.m - 1]} ${p.y}`;
}

/** "9:47 am" (IST). */
export function fmtTime(iso: string | null | undefined): string {
  const p = parseDay(iso);
  if (!p || p.dateOnly) return "—";
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h12}:${pad2(p.min)} ${p.h < 12 ? "am" : "pm"}`;
}

/** "29 Oct, 9:47 am" (IST). */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const p = parseDay(iso);
  if (!p) return String(iso);
  if (p.dateOnly) return `${p.d} ${MON[p.m - 1]}`;
  return `${p.d} ${MON[p.m - 1]}, ${fmtTime(iso)}`;
}

/** "Wed 29 Oct" (weekday on by default, year off by default). */
export function fmtDay(input: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const { weekday = true, year = false } = opts;
  const p = parseDay(input);
  if (!p) return input || "—";
  return `${weekday ? `${WD[p.wd]} ` : ""}${p.d} ${MON[p.m - 1]}${year ? ` ${p.y}` : ""}`;
}

/** "3 Nov", "3–4 Nov", "29 Oct – 2 Nov", "29 Dec 2026 – 2 Jan 2027". */
export function fmtRange(start: string, end?: string | null): string {
  const a = parseDay(start);
  if (!a) return start || "—";
  const b = end ? parseDay(end) : null;
  if (!b || (a.y === b.y && a.m === b.m && a.d === b.d)) return `${a.d} ${MON[a.m - 1]}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MON[a.m - 1]}`;
  if (a.y === b.y) return `${a.d} ${MON[a.m - 1]} – ${b.d} ${MON[b.m - 1]}`;
  return `${a.d} ${MON[a.m - 1]} ${a.y} – ${b.d} ${MON[b.m - 1]} ${b.y}`;
}

/** "Just now", "2 min ago", "3 hr ago", "Yesterday", "4 days ago", then a date. */
export function timeAgo(iso: string): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (isNaN(t.getTime())) return "—";
  const diffMs = Date.now() - t.getTime();
  if (diffMs < -60000) return fmtDateTime(iso);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  const days = utcDayNumber(todayIST()) - utcDayNumber(ymdOf(istParts(t)));
  if (days <= 0 || hours < 6) return `${hours} hr ago`;
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return fmtDay(iso, { weekday: false, year: istParts(t).y !== istParts(new Date()).y });
}

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return "₹" + n.toLocaleString("en-IN");
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "b";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "m";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

/** US-dollar amount from cents: "$840", "$12.4k". The single copy used by every screen. */
export function fmtUsdCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const dollars = Math.round(Math.abs(cents) / 100);
  const sign = cents < 0 && dollars > 0 ? "-" : "";
  return `${sign}$${dollars >= 1000 ? fmtCompact(dollars) : String(dollars)}`;
}
