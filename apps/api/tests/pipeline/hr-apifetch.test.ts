import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * P1 — HR portal `apiFetch` / `apiUpload` hardening, tested against the REAL module
 * (apps/hr/src/lib/api.ts) with a mocked fetch, localStorage, window and navigator.
 *
 * apps/hr has no test harness of its own; this suite runs in the apps/api vitest run
 * (CI included). The module is re-imported per test so its single-flight refresh
 * state never leaks between cases.
 */

const API = "http://localhost:4000/v1";
const REFRESH_URL = `${API}/hr/auth/refresh`;

// ── Fakes ──────────────────────────────────────────────────────────────────────

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return Array.from(this.m.keys())[i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  keys() { return Array.from(this.m.keys()); }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function html(status: number): Response {
  return new Response("<html><body><h1>502 Bad Gateway</h1></body></html>", {
    status, headers: { "Content-Type": "text/html" },
  });
}
const ok = (data: unknown) => json(200, { success: true, data });
const unauthorized = () => json(401, { success: false, error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } });
const refreshed = (n: number) => ok({ accessToken: `access-${n}`, refreshToken: `refresh-${n}` });

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

let storage: MemoryStorage;
let win: { location: { pathname: string; search: string; href: string } };
let fetchMock: ReturnType<typeof vi.fn>;
let calls: Array<{ url: string; init: RequestInit | undefined }>;

/**
 * Installs a fetch that dispatches to `handler`. A hard ceiling turns an infinite
 * 401 → refresh → retry loop (the pre-P1 behaviour) into a loud failure instead of
 * a hung test.
 */
function installFetch(handler: Handler) {
  calls = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (calls.length > 25) throw new Error("LOOP DETECTED: more than 25 fetch calls");
    return handler(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function authHeader(init: RequestInit | undefined): string | undefined {
  const h = (init?.headers ?? {}) as Record<string, string>;
  return h.Authorization;
}

async function loadApi() {
  vi.resetModules();
  return import("../../../hr/src/lib/api");
}

beforeEach(() => {
  storage = new MemoryStorage();
  storage.setItem("hrAccessToken", "access-0");
  storage.setItem("hrRefreshToken", "refresh-0");
  storage.setItem("hrUser", JSON.stringify({ id: "u1", name: "Test" }));
  storage.setItem("pl:v1:u1:outbox", "[]");
  storage.setItem("pl:v1:u1:draft:p1", "hello");
  storage.setItem("unrelated-pref", "keep-me");
  win = { location: { pathname: "/pipeline/p1", search: "?view=board", href: "http://localhost:3002/pipeline/p1?view=board" } };
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("navigator", {}); // no Web Locks → per-tab single flight
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function expectSignedIn() {
  expect(storage.getItem("hrAccessToken")).not.toBeNull();
  expect(storage.getItem("hrRefreshToken")).not.toBeNull();
  expect(storage.getItem("hrUser")).not.toBeNull();
  expect(win.location.href).toBe("http://localhost:3002/pipeline/p1?view=board"); // no redirect
}

function expectSignedOutWithReturnPath() {
  expect(storage.getItem("hrAccessToken")).toBeNull();
  expect(storage.getItem("hrRefreshToken")).toBeNull();
  expect(storage.getItem("hrUser")).toBeNull();
  // every pl: key is purged, nothing else is touched
  expect(storage.keys().filter((k) => k.startsWith("pl:"))).toEqual([]);
  expect(storage.getItem("unrelated-pref")).toBe("keep-me");
  expect(win.location.href).toBe("/login?next=" + encodeURIComponent("/pipeline/p1?view=board"));
}

// ── Success paths are unchanged ────────────────────────────────────────────────

describe("apiFetch — success path unchanged", () => {
  it("returns the envelope and sends the bearer token, in exactly one request", async () => {
    installFetch(() => ok({ hello: "world" }));
    const { apiFetch } = await loadApi();
    const res = await apiFetch<{ success: boolean; data: { hello: string } }>("/hr/profile");
    expect(res).toEqual({ success: true, data: { hello: "world" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API}/hr/profile`);
    expect(authHeader(calls[0].init)).toBe("Bearer access-0");
  });

  it("never leaks the internal retry flag into the fetch init", async () => {
    let n = 0;
    installFetch((url) => {
      if (url === REFRESH_URL) return refreshed(1);
      return ++n === 1 ? unauthorized() : ok({});
    });
    const { apiFetch } = await loadApi();
    await apiFetch("/hr/profile", { method: "GET" });
    for (const c of calls) expect(c.init && "_retried" in c.init).toBeFalsy();
  });
});

// ── ApiError carries status + retryAfterSec ───────────────────────────────────

describe("ApiError — status and retryAfterSec (additive)", () => {
  it("a JSON 403 carries status 403 and keeps code / message / details", async () => {
    installFetch(() => json(403, { success: false, error: { code: "FORBIDDEN", message: "HR access only" } }));
    const { apiFetch, ApiError } = await loadApi();
    const err = await apiFetch("/hr/x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
    expect(err.message).toBe("HR access only");
    expect(err.retryAfterSec).toBeUndefined();
  });

  it("a JSON 400 keeps per-field details (report page relies on them)", async () => {
    const details = [{ field: "links.3.url", message: "Invalid URL" }];
    installFetch(() => json(400, { success: false, error: { code: "VALIDATION_ERROR", message: "Bad", details } }));
    const { apiFetch } = await loadApi();
    const err = await apiFetch("/hr/reports").catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.details).toEqual(details);
  });

  it("a 429 carries retryAfterSec read from body.error.retryAfterSec", async () => {
    installFetch(() => json(429, { success: false, error: { code: "PIPELINE_RATE_LIMIT", message: "Slow down", retryAfterSec: 42 } }));
    const { apiFetch } = await loadApi();
    const err = await apiFetch("/pipeline/sync").catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.code).toBe("PIPELINE_RATE_LIMIT");
    expect(err.retryAfterSec).toBe(42);
  });

  it("ignores a retryAfterSec that is not a finite, non-negative number", async () => {
    for (const bad of ["42", -1, null, Number.NaN]) {
      installFetch(() => json(429, { success: false, error: { code: "RATE_LIMIT", message: "x", retryAfterSec: bad } }));
      const { apiFetch } = await loadApi();
      const err = await apiFetch("/x").catch((e) => e);
      expect(err.retryAfterSec).toBeUndefined();
    }
  });

  it("a network error (fetch threw) carries status 0", async () => {
    installFetch(() => { throw new TypeError("Load failed"); });
    const { apiFetch, ApiError } = await loadApi();
    const err = await apiFetch("/hr/x").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe("NETWORK_ERROR");
  });

  it("an HTML 502 carries status 502, an HTML 413 carries 413, other non-JSON keep their status", async () => {
    installFetch(() => html(502));
    let api = await loadApi();
    let err = await api.apiFetch("/x").catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.code).toBe("SERVER_ERROR");

    installFetch(() => html(413));
    api = await loadApi();
    err = await api.apiFetch("/x").catch((e) => e);
    expect(err.status).toBe(413);
    expect(err.code).toBe("PAYLOAD_TOO_LARGE");

    installFetch(() => html(404));
    api = await loadApi();
    err = await api.apiFetch("/x").catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.code).toBe("NON_JSON_RESPONSE");
  });
});

// ── 401 → refresh: ok, capped, rejected, transient ─────────────────────────────

describe("apiFetch — 401 handling", () => {
  it("expired token: refreshes once, stores the new pair, retries with the new token", async () => {
    installFetch((url, init) => {
      if (url === REFRESH_URL) return refreshed(1);
      return authHeader(init) === "Bearer access-1" ? ok({ v: 1 }) : unauthorized();
    });
    const { apiFetch } = await loadApi();
    const res = await apiFetch<{ data: { v: number } }>("/hr/profile");
    expect(res.data.v).toBe(1);
    expect(calls.map((c) => c.url)).toEqual([`${API}/hr/profile`, REFRESH_URL, `${API}/hr/profile`]);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ refreshToken: "refresh-0" });
    expect(storage.getItem("hrAccessToken")).toBe("access-1");
    expect(storage.getItem("hrRefreshToken")).toBe("refresh-1");
    expectSignedIn();
  });

  it("CAP: a second consecutive 401 after a successful refresh goes to login instead of looping", async () => {
    let refreshes = 0;
    installFetch((url) => {
      if (url === REFRESH_URL) return refreshed(++refreshes);
      return unauthorized(); // this endpoint 401s no matter which token is sent
    });
    const { apiFetch, ApiError } = await loadApi();
    const err = await apiFetch("/hr/profile").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
    // original + ONE refresh + ONE retry — never a second refresh
    expect(calls).toHaveLength(3);
    expect(refreshes).toBe(1);
    expectSignedOutWithReturnPath();
  });

  it("REJECTED: the refresh endpoint answers a JSON 401 → tokens and pl: keys cleared, /login?next=", async () => {
    installFetch((url) => (url === REFRESH_URL
      ? json(401, { success: false, error: { code: "INVALID_TOKEN", message: "Refresh token already used" } })
      : unauthorized()));
    const { apiFetch } = await loadApi();
    const err = await apiFetch("/hr/profile").catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
    expect(calls).toHaveLength(2); // no retry after a rejected refresh
    expectSignedOutWithReturnPath();
  });

  it("REJECTED: a JSON 400 from the refresh endpoint also ends the session", async () => {
    installFetch((url) => (url === REFRESH_URL
      ? json(400, { success: false, error: { code: "VALIDATION_ERROR", message: "refreshToken is required" } })
      : unauthorized()));
    const { apiFetch } = await loadApi();
    await apiFetch("/hr/profile").catch(() => undefined);
    expectSignedOutWithReturnPath();
  });

  it("REJECTED: no refresh token stored → session over, without calling the refresh endpoint", async () => {
    storage.removeItem("hrRefreshToken");
    installFetch(() => unauthorized());
    const { apiFetch } = await loadApi();
    const err = await apiFetch("/hr/profile").catch((e) => e);
    expect(err.status).toBe(401);
    expect(calls.map((c) => c.url)).toEqual([`${API}/hr/profile`]);
    expectSignedOutWithReturnPath();
  });

  const transientCases: Array<[string, Handler]> = [
    ["the refresh fetch threw (offline)", () => { throw new TypeError("Load failed"); }],
    ["the refresh returned an HTML 502", () => html(502)],
    ["the refresh returned a 429", () => json(429, { success: false, error: { code: "RATE_LIMIT", message: "Too many" } })],
    ["the refresh returned a JSON 500 (DB struggling)", () => json(500, { success: false, error: { code: "INTERNAL_ERROR", message: "x" } })],
    ["the refresh returned a 503", () => json(503, { success: false, error: { code: "REPORTS_BUSY", message: "x" } })],
    ["the refresh returned a 200 JSON without tokens", () => ok({})],
    ["the refresh returned a non-JSON 200", () => new Response("<html>captive portal</html>", { status: 200 })],
  ];

  for (const [label, refreshHandler] of transientCases) {
    it(`TRANSIENT: ${label} → stays signed in and throws a retryable 503 NETWORK_RETRY`, async () => {
      installFetch((url, init) => (url === REFRESH_URL ? refreshHandler(url, init) : unauthorized()));
      const { apiFetch, ApiError } = await loadApi();
      const err = await apiFetch("/hr/profile").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(503);
      expect(err.code).toBe("NETWORK_RETRY");
      // Thrown for GETs too, so it must not claim anything about saving; and it carries
      // no trailing period because /report appends its own sentence after it.
      expect(err.message).not.toMatch(/saved/i);
      expect(err.message.endsWith(".")).toBe(false);
      expect(calls).toHaveLength(2); // no retry of the original request, no loop
      expectSignedIn();
      // tokens are byte-unchanged (not rotated, not cleared)
      expect(storage.getItem("hrAccessToken")).toBe("access-0");
      expect(storage.getItem("hrRefreshToken")).toBe("refresh-0");
      expect(storage.keys().filter((k) => k.startsWith("pl:"))).toHaveLength(2);
    });
  }

  it("parallel 401s share ONE refresh (single-use token) and all succeed", async () => {
    let refreshes = 0;
    installFetch(async (url, init) => {
      if (url === REFRESH_URL) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return refreshed(refreshes);
      }
      return authHeader(init) === "Bearer access-1" ? ok({ url }) : unauthorized();
    });
    const { apiFetch } = await loadApi();
    const results = await Promise.all(["/a", "/b", "/c"].map((p) => apiFetch<{ data: { url: string } }>(p)));
    expect(results.map((r) => r.data.url)).toEqual([`${API}/a`, `${API}/b`, `${API}/c`]);
    expect(refreshes).toBe(1);
    expectSignedIn();
  });

  it("another tab already rotated the tokens (detected under the Web Lock) → no second refresh", async () => {
    vi.stubGlobal("navigator", {
      locks: {
        request: async (_name: string, cb: () => Promise<unknown>) => {
          // while we waited on the lock, another tab refreshed
          storage.setItem("hrAccessToken", "access-from-other-tab");
          storage.setItem("hrRefreshToken", "refresh-from-other-tab");
          return cb();
        },
      },
    });
    installFetch((url, init) => {
      if (url === REFRESH_URL) throw new Error("must not refresh again");
      return authHeader(init) === "Bearer access-from-other-tab" ? ok({ v: 2 }) : unauthorized();
    });
    const { apiFetch } = await loadApi();
    const res = await apiFetch<{ data: { v: number } }>("/hr/profile");
    expect(res.data.v).toBe(2);
    expect(calls.map((c) => c.url)).toEqual([`${API}/hr/profile`, `${API}/hr/profile`]);
  });

  it("LATE 401: a request sent with the old token whose 401 lands after the refresh finished retries with the new token — ONE refresh", async () => {
    let refreshCalls = 0;
    let releaseB!: () => void;
    const bGate = new Promise<void>((r) => { releaseB = r; });
    installFetch(async (url, init) => {
      if (url === REFRESH_URL) return refreshed(++refreshCalls);
      if (authHeader(init) === "Bearer access-1") return ok({ url });
      if (url === `${API}/b`) { await bGate; return unauthorized(); } // slow 401, sent with access-0
      return unauthorized();
    });
    const { apiFetch } = await loadApi();
    const pA = apiFetch<{ data: { url: string } }>("/a");
    const pB = apiFetch<{ data: { url: string } }>("/b"); // both sent with access-0
    const a = await pA; // refresh done, access-1 / refresh-1 stored
    expect(a.data.url).toBe(`${API}/a`);
    releaseB();
    const b = await pB;
    expect(b.data.url).toBe(`${API}/b`);
    // The single-use refresh-1 was NOT spent: /b simply retried with access-1.
    expect(refreshCalls).toBe(1);
    expect(storage.getItem("hrAccessToken")).toBe("access-1");
    expect(storage.getItem("hrRefreshToken")).toBe("refresh-1");
    expectSignedIn();
  });

  it("LOCK-FREE LOSER: the refresh endpoint rejects because another tab already rotated → keeps the winner's pair and retries", async () => {
    // navigator.locks is absent (beforeEach), so two tabs can race the same refresh-0.
    installFetch((url, init) => {
      if (url === REFRESH_URL) {
        // The other tab won: its fresh pair lands in shared localStorage, and our
        // attempt with the now-spent refresh-0 is refused.
        storage.setItem("hrAccessToken", "access-from-other-tab");
        storage.setItem("hrRefreshToken", "refresh-from-other-tab");
        return json(401, { success: false, error: { code: "INVALID_TOKEN", message: "Refresh token already used" } });
      }
      return authHeader(init) === "Bearer access-from-other-tab" ? ok({ v: 3 }) : unauthorized();
    });
    const { apiFetch } = await loadApi();
    const res = await apiFetch<{ data: { v: number } }>("/hr/profile");
    expect(res.data.v).toBe(3);
    expect(storage.getItem("hrAccessToken")).toBe("access-from-other-tab");
    expect(storage.getItem("hrRefreshToken")).toBe("refresh-from-other-tab");
    expect(storage.keys().filter((k) => k.startsWith("pl:"))).toHaveLength(2);
    expectSignedIn();
  });

  it("a later, unrelated 401 can refresh again (the cap is per request, not per page)", async () => {
    let refreshes = 0;
    installFetch((url, init) => {
      if (url === REFRESH_URL) return refreshed(++refreshes);
      return authHeader(init) === `Bearer access-${refreshes}` && refreshes > 0 ? ok({}) : unauthorized();
    });
    const { apiFetch } = await loadApi();
    await apiFetch("/one");
    storage.setItem("hrAccessToken", "expired-again");
    await apiFetch("/two");
    expect(refreshes).toBe(2);
    expectSignedIn();
  });
});

// ── Cooldown after a transient refresh ──────────────────────────────────────────
//
// A transient refresh no longer ends the session, so every SWR error-retry of every
// hook on the page would otherwise call /hr/auth/refresh again during an outage. That
// endpoint carries no verified token, so in production it is keyed on the Cloudflare
// edge IP and shares one bucket with every anonymous request behind that edge.

describe("apiFetch — cooldown after a transient refresh", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("401s within 5 s of a transient refresh do not call the refresh endpoint again; after 5 s they do", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let refreshCalls = 0;
    installFetch((url) => {
      if (url === REFRESH_URL) { refreshCalls++; throw new TypeError("Load failed"); }
      return unauthorized();
    });
    const { apiFetch } = await loadApi();

    const e1 = await apiFetch("/a").catch((e) => e);
    expect(e1.code).toBe("NETWORK_RETRY");
    expect(refreshCalls).toBe(1);

    now += 2_000;
    const e2 = await apiFetch("/b").catch((e) => e);
    expect(e2.code).toBe("NETWORK_RETRY");
    expect(e2.status).toBe(503);
    expect(refreshCalls).toBe(1); // throttled: no second refresh

    now += 3_001;
    const e3 = await apiFetch("/c").catch((e) => e);
    expect(e3.code).toBe("NETWORK_RETRY");
    expect(refreshCalls).toBe(2); // cooldown over: tried again

    expectSignedIn();
  });

  it("another tab refreshed during the cooldown: a request sent with the OLD token retries with the new one — no refresh at all", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let refreshCalls = 0;
    installFetch((url, init) => {
      if (url === REFRESH_URL) { refreshCalls++; throw new TypeError("Load failed"); }
      if (url === `${API}/b` && authHeader(init) === "Bearer access-0") {
        // another tab rotates the pair while this request is in flight
        storage.setItem("hrAccessToken", "access-from-other-tab");
        storage.setItem("hrRefreshToken", "refresh-from-other-tab");
        return unauthorized();
      }
      return authHeader(init) === "Bearer access-from-other-tab" ? ok({ v: 2 }) : unauthorized();
    });
    const { apiFetch } = await loadApi();

    await apiFetch("/a").catch(() => undefined); // transient, starts the cooldown
    expect(refreshCalls).toBe(1);

    now += 1_000;
    const res = await apiFetch<{ data: { v: number } }>("/b");
    expect(res.data.v).toBe(2);
    // The other tab's fresh refresh token is NOT spent a second time.
    expect(refreshCalls).toBe(1);
    expect(storage.getItem("hrRefreshToken")).toBe("refresh-from-other-tab");
    expectSignedIn();
  });

  it("a request sent with a NEW access token (another tab refreshed) bypasses the cooldown and refreshes normally", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let refreshCalls = 0;
    let failRefresh = true;
    installFetch((url, init) => {
      if (url === REFRESH_URL) {
        refreshCalls++;
        if (failRefresh) throw new TypeError("Load failed");
        return refreshed(2);
      }
      return authHeader(init) === "Bearer access-2" ? ok({ v: 2 }) : unauthorized();
    });
    const { apiFetch } = await loadApi();

    await apiFetch("/a").catch(() => undefined); // transient, starts the cooldown
    expect(refreshCalls).toBe(1);

    // another tab rotated the pair; this request is SENT with the new token and 401s
    storage.setItem("hrAccessToken", "access-from-other-tab");
    storage.setItem("hrRefreshToken", "refresh-from-other-tab");
    failRefresh = false;
    now += 1_000;
    const res = await apiFetch<{ data: { v: number } }>("/b");
    expect(res.data.v).toBe(2);
    expect(refreshCalls).toBe(2);
    expectSignedIn();
  });

  it("a successful refresh is never throttled", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let refreshes = 0;
    installFetch((url, init) => {
      if (url === REFRESH_URL) return refreshed(++refreshes);
      return authHeader(init) === `Bearer access-${refreshes}` && refreshes > 0 ? ok({}) : unauthorized();
    });
    const { apiFetch } = await loadApi();
    await apiFetch("/one");
    storage.setItem("hrAccessToken", "expired-again");
    now += 100;
    await apiFetch("/two");
    expect(refreshes).toBe(2);
  });
});

// ── apiUpload gets the same treatment ───────────────────────────────────────────

describe("apiUpload — same P1 rules", () => {
  const form = () => { const f = new FormData(); f.append("file", new Blob(["x"]), "a.txt"); return f; };

  it("carries status on errors", async () => {
    installFetch(() => json(413, { success: false, error: { code: "FILE_TOO_LARGE", message: "Too big" } }));
    const { apiUpload } = await loadApi();
    const err = await apiUpload("/hr/documents", form()).catch((e) => e);
    expect(err.status).toBe(413);
    expect(err.code).toBe("FILE_TOO_LARGE");
  });

  it("a network error carries status 0", async () => {
    installFetch(() => { throw new TypeError("Load failed"); });
    const { apiUpload } = await loadApi();
    const err = await apiUpload("/hr/documents", form()).catch((e) => e);
    expect(err.status).toBe(0);
    expect(err.code).toBe("NETWORK_ERROR");
  });

  it("TRANSIENT refresh keeps the session", async () => {
    installFetch((url) => (url === REFRESH_URL ? html(502) : unauthorized()));
    const { apiUpload } = await loadApi();
    const err = await apiUpload("/hr/documents", form()).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.code).toBe("NETWORK_RETRY");
    expectSignedIn();
  });

  it("CAP: second consecutive 401 goes to login, no loop", async () => {
    let refreshes = 0;
    installFetch((url) => (url === REFRESH_URL ? refreshed(++refreshes) : unauthorized()));
    const { apiUpload } = await loadApi();
    const err = await apiUpload("/hr/documents", form()).catch((e) => e);
    expect(err.status).toBe(401);
    expect(calls).toHaveLength(3);
    expectSignedOutWithReturnPath();
  });

  it("another tab rotated the pair while the upload was in flight → retried with the new token, no refresh", async () => {
    installFetch((url, init) => {
      if (url === REFRESH_URL) throw new Error("must not refresh");
      if (authHeader(init) === "Bearer access-0") {
        storage.setItem("hrAccessToken", "access-from-other-tab");
        storage.setItem("hrRefreshToken", "refresh-from-other-tab");
        return unauthorized();
      }
      return authHeader(init) === "Bearer access-from-other-tab" ? ok({ uploaded: true }) : unauthorized();
    });
    const { apiUpload } = await loadApi();
    const res = await apiUpload<{ data: { uploaded: boolean } }>("/hr/documents", form());
    expect(res.data.uploaded).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([`${API}/hr/documents`, `${API}/hr/documents`]);
    expectSignedIn();
  });

  it("refresh ok → retried upload succeeds with the new token", async () => {
    installFetch((url, init) => {
      if (url === REFRESH_URL) return refreshed(1);
      return authHeader(init) === "Bearer access-1" ? ok({ uploaded: true }) : unauthorized();
    });
    const { apiUpload } = await loadApi();
    const res = await apiUpload<{ data: { uploaded: boolean } }>("/hr/documents", form());
    expect(res.data.uploaded).toBe(true);
    expectSignedIn();
  });
});
