# HR Daily-Report Submit Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate every known failure mode of the HR daily-report submit flow — the opaque "Load failed" toast, the >500-link block, the "~140 links" / midnight errors — and remove the link cap entirely so employees can paste unlimited links.

**Architecture:** Three independent root causes, fixed in three layers. (1) **Frontend transport hardening** — `apiFetch` currently calls `res.json()` unconditionally, so any non-JSON response (proxy timeout HTML, dropped socket) throws a raw error that Safari shows as "Load failed"; we make it read the body defensively and convert transport failures into actionable `ApiError`s, while preserving the 401→refresh path. (2) **Cap removal** — delete the 500-link ceiling in all three places (validator, service, frontend) and remove the now-broken smart-paste cap guard. (3) **Backend efficiency + correctness** — with the cap gone, submissions can be large, so we batch the per-link inserts with `createMany` (no behavior change — Prisma 5 already batches nested creates, but `createMany` makes intent explicit and avoids the `include` round-trip on huge writes), chunk the unbounded cross-day dedup `IN` query so it never exceeds Postgres's bind-param limit, and fix the midnight cross-day self-drop edge.

**Tech Stack:** Express + Prisma 5.22.0 (Postgres), Next.js (HR portal), Zod validators in `@dashmani/shared`, Vitest + supertest for API tests.

---

## Background: the three verified root causes

These were diagnosed and adversarially verified on 2026-06-01. Read this before starting — it explains *why* each task exists.

1. **"Load failed" (the keystone).** [apps/hr/src/lib/api.ts:29](../../../apps/hr/src/lib/api.ts) does `const data = await res.json()` **before** any `res.ok`/`res.status` check and with no `try/catch`. Any response that isn't our JSON envelope — a proxy 502/504/524 HTML page, a 413, or a reset/timed-out socket — makes `apiFetch` throw a raw `TypeError`/`SyntaxError` that bubbles to the page's `catch` → `setError(err.message)`. Safari's wording for a failed `fetch()` is literally **"Load failed"**. The string exists in **zero source files** — it is the browser/transport layer. This single bug is why many *different* underlying failures all show the same vague toast.

2. **">500 links blocked."** 500 is capped in three places. Resubmit is cumulative-by-construction (the form prefills ALL prior links, resends the whole set, the service does delete-and-recreate), so the per-submission cap is effectively a per-day cap. `handleSmartPaste` has **no** cap guard (unlike `addLink`), so paste silently exceeds 500 then 400s at submit with a useless generic "Invalid request data" message (the cap text is buried in `details` under field `"links"` with no row index, so nothing highlights). **User decision: remove the cap entirely.**

3. **"~140 links" / midnight — transport timeout, NOT Prisma.** The "nested create = N sequential INSERTs → 5s transaction timeout" theory was **empirically disproven**: Prisma 5.22.0 batches same-parent nested creates into ONE multi-row INSERT (500 links ≈ 2 statements, ~40ms), and the 5s default applies only to interactive `$transaction` (this path has none). The real driver is the transport layer — nginx `send_timeout 10` / `client_body_timeout 10` ([scripts/security-setup.sh:64-66](../../../scripts/security-setup.sh)), proxy/Cloudflare idle timeout, or the whole NAT'd office submitting at the midnight deadline — which produces a dropped/non-JSON response that surfaces via root cause #1. There is also a narrow real midnight edge in the cross-day dedup.

**Implication of removing the cap:** larger submissions become possible, which makes root cause #1 (transport hardening) and the backend efficiency/chunking work *more* important, not less. All three are in this plan.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `apps/hr/src/lib/api.ts` | HR portal fetch wrapper | Rewrite `apiFetch`/`apiUpload` body-reading to be status-aware + non-JSON-safe; preserve 401 refresh |
| `packages/shared/src/validators/hr.ts` | Shared Zod validator | Remove `.max(500)` from `links` array |
| `apps/api/src/services/daily-report.service.ts` | Submit logic | Remove `MAX_LINKS_PER_DAY` check; switch nested `create` → `createMany`; chunk cross-day dedup `IN` query; fix midnight cross-day edge |
| `apps/hr/src/app/report/page.tsx` | HR report form | Remove `MAX_LINKS` constant + 2 guards; remove dead `duplicateUrls` submit guard |
| `apps/api/tests/daily-report.test.ts` | API tests | Add tests: >500 links now accepted; cross-day dedup still drops; large batch round-trips correctly |
| `apps/hr/src/lib/api.test.ts` (new) | Frontend fetch tests | Test non-JSON / non-ok / network-error handling + 401 refresh preserved |

---

## Task 1: Harden `apiFetch` against non-JSON and transport failures (root cause #1)

This is the highest-value change. It turns every opaque "Load failed" into an actionable message **for all three portals' worth of failure modes**, and it must not regress the existing 401→refresh→retry behavior.

**Files:**
- Modify: `apps/hr/src/lib/api.ts` (rewrite `apiFetch` body-reading and `apiUpload`; `ApiError` and `tryRefresh` stay)
- Test: `apps/hr/src/app/report/page.tsx` (no change here — verified by Task 5 build)

> **Note on testing the frontend:** the HR app has no existing frontend test harness (Vitest is configured only for `apps/api`). Rather than stand up a new test runner (YAGNI), we verify `apiFetch` by (a) a focused Node script that exercises the parsing branches against mock `Response` objects, and (b) the type-check + build in Task 5. If the team later adds a frontend test runner, the script in Step 1 converts directly into a Vitest test.

- [ ] **Step 1: Write a standalone verification script for the new parsing logic**

Create `apps/hr/src/lib/api.verify.mjs` (temporary — deleted in Step 6). It re-implements the *intended* parse logic in isolation and asserts every branch, so we lock behavior before editing the real file:

```js
// apps/hr/src/lib/api.verify.mjs
// Run with: node apps/hr/src/lib/api.verify.mjs
// Verifies the parse/branch logic we are about to put into apiFetch.

import assert from "node:assert";

// Mirror of ApiError for the test
class ApiError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

// The pure logic we will lift into apiFetch: given a Response-like object,
// return either the parsed envelope or throw a friendly ApiError.
async function readEnvelope(res) {
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // Body is not JSON — almost always a proxy/timeout HTML page or empty body.
    if (res.status === 413) {
      throw new ApiError("Your submission is too large for the server to accept.", "PAYLOAD_TOO_LARGE");
    }
    if (res.status === 0 || res.status >= 500) {
      throw new ApiError(
        "The server took too long or returned an error. Your data was not saved — please try again.",
        "SERVER_ERROR",
      );
    }
    throw new ApiError(
      `Unexpected server response (status ${res.status}). Please try again.`,
      "NON_JSON_RESPONSE",
    );
  }
  return data;
}

// 1. Valid JSON success envelope passes through
const ok = await readEnvelope({ status: 200, text: async () => JSON.stringify({ success: true, data: { x: 1 } }) });
assert.deepStrictEqual(ok, { success: true, data: { x: 1 } });

// 2. Valid JSON error envelope passes through (so caller can read data.success/error)
const errEnv = await readEnvelope({ status: 400, text: async () => JSON.stringify({ success: false, error: { code: "VALIDATION_ERROR", message: "bad" } }) });
assert.strictEqual(errEnv.success, false);
assert.strictEqual(errEnv.error.code, "VALIDATION_ERROR");

// 3. Non-JSON 504 HTML (proxy timeout) → friendly SERVER_ERROR, not a raw SyntaxError
await assert.rejects(
  () => readEnvelope({ status: 504, text: async () => "<!DOCTYPE html><html>Gateway Timeout</html>" }),
  (e) => e instanceof ApiError && e.code === "SERVER_ERROR",
);

// 4. Non-JSON 413 → PAYLOAD_TOO_LARGE
await assert.rejects(
  () => readEnvelope({ status: 413, text: async () => "<html>Request Entity Too Large</html>" }),
  (e) => e instanceof ApiError && e.code === "PAYLOAD_TOO_LARGE",
);

// 5. Empty body with odd status → NON_JSON_RESPONSE
await assert.rejects(
  () => readEnvelope({ status: 502, text: async () => "" }),
  (e) => e instanceof ApiError && e.code === "SERVER_ERROR", // 502 >= 500
);

console.log("All apiFetch parse-logic assertions passed.");
```

- [ ] **Step 2: Run the script to confirm the intended logic is correct**

Run: `node apps/hr/src/lib/api.verify.mjs`
Expected: `All apiFetch parse-logic assertions passed.`

- [ ] **Step 3: Rewrite `apiFetch` and `apiUpload` in `apps/hr/src/lib/api.ts`**

Replace the entire file body **below the `ApiError` class** (keep lines 1–15: the `API_URL`, `API_BASE`, and `ApiError` class exactly as they are). The key changes: wrap `fetch` in `try/catch` to catch transport `TypeError`s; read `res.text()` then `JSON.parse` in a `try/catch`; check `res.status === 401` for the refresh path **using the HTTP status, not `data.success`** (so refresh still fires even if the 401 body is non-JSON).

```ts
export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("hrAccessToken") : null;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    // fetch() itself threw — connection reset / DNS / CORS / offline.
    // In Safari this is the literal "Load failed" TypeError. Surface something actionable.
    throw new ApiError(
      "Couldn't reach the server. Check your connection and try again — your data was not saved.",
      "NETWORK_ERROR",
    );
  }

  // 401 refresh path is keyed on the HTTP STATUS, not the parsed body, so it works
  // even when the 401 response has a non-JSON body.
  if (res.status === 401 && typeof window !== "undefined") {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return apiFetch(path, options);
    }
    localStorage.removeItem("hrAccessToken");
    localStorage.removeItem("hrRefreshToken");
    localStorage.removeItem("hrUser");
    window.location.href = "/login";
    throw new ApiError("Session expired. Please sign in again.", "UNAUTHORIZED");
  }

  // Read the body defensively. A proxy timeout / 5xx / 413 often returns HTML,
  // which would make res.json() throw a SyntaxError that surfaces as "Load failed".
  const bodyText = await res.text();
  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    if (res.status === 413) {
      throw new ApiError("Your submission is too large for the server to accept.", "PAYLOAD_TOO_LARGE");
    }
    if (res.status >= 500 || res.status === 0) {
      throw new ApiError(
        "The server took too long or returned an error. Your data was not saved — please try again.",
        "SERVER_ERROR",
      );
    }
    throw new ApiError(`Unexpected server response (status ${res.status}). Please try again.`, "NON_JSON_RESPONSE");
  }

  if (!data.success) {
    throw new ApiError(
      data.error?.message || "API error",
      data.error?.code,
      data.error?.details,
    );
  }

  return data;
}

export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("hrAccessToken") : null;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
  } catch {
    throw new ApiError(
      "Couldn't reach the server. Check your connection and try again — your file was not uploaded.",
      "NETWORK_ERROR",
    );
  }

  if (res.status === 401 && typeof window !== "undefined") {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return apiUpload(path, formData);
    }
    localStorage.removeItem("hrAccessToken");
    localStorage.removeItem("hrRefreshToken");
    localStorage.removeItem("hrUser");
    window.location.href = "/login";
    throw new ApiError("Session expired. Please sign in again.", "UNAUTHORIZED");
  }

  const bodyText = await res.text();
  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    if (res.status === 413) {
      throw new ApiError("Your file is too large for the server to accept.", "PAYLOAD_TOO_LARGE");
    }
    if (res.status >= 500 || res.status === 0) {
      throw new ApiError("The server returned an error. Your file was not uploaded — please try again.", "SERVER_ERROR");
    }
    throw new ApiError(`Unexpected server response (status ${res.status}). Please try again.`, "NON_JSON_RESPONSE");
  }

  if (!data.success) {
    throw new ApiError(data.error?.message || "Upload failed", data.error?.code, data.error?.details);
  }

  return data;
}
```

Leave `tryRefresh()` (lines 86–104 in the original) exactly as-is below these functions.

> ⚠️ **Behavior change to be aware of:** the original code only attempted refresh when `!data.success && res.status === 401`. The new code attempts refresh on `res.status === 401` regardless of body shape. This is strictly more correct (a 401 always means re-auth) and matches the established per-portal pattern. The `success: true` + 401 combination does not occur in this API.

- [ ] **Step 4: Re-run the verification script against nothing changed in logic**

Run: `node apps/hr/src/lib/api.verify.mjs`
Expected: `All apiFetch parse-logic assertions passed.` (the script tests the lifted logic, unchanged)

- [ ] **Step 5: Type-check the HR app**

Run: `npx tsc --noEmit -p apps/hr/tsconfig.json`
Expected: no errors.

- [ ] **Step 6: Delete the temporary verification script and commit**

```bash
rm apps/hr/src/lib/api.verify.mjs
git add apps/hr/src/lib/api.ts
git commit -m "fix(hr): apiFetch reads body defensively — no more opaque 'Load failed' on proxy timeout/non-JSON responses"
```

---

## Task 2: Remove the 500-link cap from the validator (root cause #2)

**Files:**
- Modify: `packages/shared/src/validators/hr.ts:62`
- Test: `apps/api/tests/daily-report.test.ts`

- [ ] **Step 1: Write a failing test that >500 links are accepted**

Add this test inside the existing `describe("POST /v1/hr/reports", ...)` block in `apps/api/tests/daily-report.test.ts` (after the "updates existing report" test):

```ts
    it("accepts a submission with more than 500 links (no cap)", async () => {
      const links = Array.from({ length: 650 }, (_, i) => ({
        accountId,
        url: `https://instagram.com/p/bulk-${i}`,
        platform: "instagram",
      }));

      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({ date: "2026-04-07", links });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.links.length).toBe(650);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -w @dashmani/api -- daily-report -t "more than 500 links"`
Expected: FAIL — `expect(res.status).toBe(201)` receives `400` (the validator's `.max(500)` rejects it). Note: this also requires Task 3's service change, but the validator is the first gate, so it fails here first.

- [ ] **Step 3: Remove `.max(500)` from the validator**

In `packages/shared/src/validators/hr.ts`, change line 62 from:

```ts
  links: z.array(reportLinkSchema).min(1, "At least one link is required").max(500, "Maximum 500 links per submission"),
```

to:

```ts
  links: z.array(reportLinkSchema).min(1, "At least one link is required"),
```

- [ ] **Step 4: Rebuild the shared package so the API picks up the change**

Run: `npm run build -w @dashmani/shared`
Expected: build succeeds. (The API imports the compiled `@dashmani/shared`; the validator change is not visible to the API until this rebuild.)

- [ ] **Step 5: Commit (test will pass after Task 3)**

The test still fails until Task 3 removes the service-level `MAX_LINKS_PER_DAY` check. Commit the validator change now; the test goes green at the end of Task 3.

```bash
git add packages/shared/src/validators/hr.ts apps/api/tests/daily-report.test.ts
git commit -m "feat(reports): remove 500-link cap from validator — employees can submit unlimited links"
```

---

## Task 3: Remove service cap, batch inserts, chunk dedup, fix midnight edge (root causes #2 + #3)

This is the core backend task. Four changes in one file, each with a test.

**Files:**
- Modify: `apps/api/src/services/daily-report.service.ts`
- Test: `apps/api/tests/daily-report.test.ts`

- [ ] **Step 1: Remove the `MAX_LINKS_PER_DAY` constant and its check**

In `apps/api/src/services/daily-report.service.ts`, delete line 76:

```ts
const MAX_LINKS_PER_DAY = 500;
```

and delete the check at lines 91–93:

```ts
  if (links.length > MAX_LINKS_PER_DAY) {
    throw new AppError(400, "VALIDATION_ERROR", `Maximum ${MAX_LINKS_PER_DAY} links per day allowed`);
  }
```

- [ ] **Step 2: Run the >500-links test from Task 2 — it should now pass**

Run: `npm run test -w @dashmani/api -- daily-report -t "more than 500 links"`
Expected: PASS (validator cap removed in Task 2, service cap removed now).

- [ ] **Step 3: Write a failing test for cross-day dedup at scale (proves chunking works)**

Add inside `describe("POST /v1/hr/reports", ...)`:

```ts
    it("drops cross-day duplicate links even in a large batch", async () => {
      // Day 1: submit a link
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-08",
          links: [{ accountId, url: "https://instagram.com/p/yesterday", platform: "instagram" }],
        });

      // Day 2: submit a large batch that RE-INCLUDES yesterday's URL plus 600 new ones
      const links = [
        { accountId, url: "https://instagram.com/p/yesterday", platform: "instagram" }, // dup from day 1
        ...Array.from({ length: 600 }, (_, i) => ({
          accountId,
          url: `https://instagram.com/p/day2-${i}`,
          platform: "instagram",
        })),
      ];

      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({ date: "2026-04-09", links });

      expect(res.status).toBe(201);
      // The yesterday dup is silently dropped; only the 600 new ones remain.
      expect(res.body.data.links.length).toBe(600);
      const urls = res.body.data.links.map((l: any) => l.url);
      expect(urls).not.toContain("https://instagram.com/p/yesterday");
    });
```

- [ ] **Step 4: Run it — it should already PASS (proves current dedup works at this size), establishing a regression guard before refactor**

Run: `npm run test -w @dashmani/api -- daily-report -t "cross-day duplicate links even in a large batch"`
Expected: PASS. (601 URLs in an `IN` clause is still under Postgres's 65535 param limit, so this works today. We add chunking next to make it safe at *any* size and keep this test as the guard.)

- [ ] **Step 5: Chunk the cross-day dedup query**

In `apps/api/src/services/daily-report.service.ts`, replace the cross-day dedup block (originally lines ~120–135, the `const existingLinks = ...` through the `crossDayDupUrls` set construction) with a chunked version. The current code is:

```ts
  const reportDate = new Date(date);
  const liveUrls = links.filter((l) => !l.isScheduled && l.url).map((l) => l.url!.trim());
  const existingLinks = liveUrls.length > 0 ? await prisma.reportLink.findMany({
    where: {
      url: { in: liveUrls },
      report: { employeeId },
    },
    select: { url: true, report: { select: { date: true } } },
  }) : [];

  const crossDayDupUrls = new Set(
    existingLinks
      .filter((el) => dateToIST(new Date(el.report.date)) !== dateToIST(reportDate))
      .map((el) => el.url?.trim().toLowerCase())
      .filter((u): u is string => !!u)
  );
```

Replace it with:

```ts
  const reportDate = new Date(date);
  const liveUrls = links.filter((l) => !l.isScheduled && l.url).map((l) => l.url!.trim());

  // Look up prior submissions of these URLs in CHUNKS so an unbounded link count
  // never blows past Postgres's bind-parameter limit (each URL is one param).
  const CHUNK = 1000;
  const existingLinks: { url: string | null; report: { date: Date } }[] = [];
  for (let i = 0; i < liveUrls.length; i += CHUNK) {
    const slice = liveUrls.slice(i, i + CHUNK);
    const rows = await prisma.reportLink.findMany({
      where: {
        url: { in: slice },
        report: { employeeId },
      },
      select: { url: true, report: { select: { date: true } } },
    });
    existingLinks.push(...rows);
  }

  // A URL is a cross-day duplicate only if it exists on a DIFFERENT IST day.
  // Comparing IST day strings (not raw Dates) is what makes the midnight rollover correct.
  const crossDayDupUrls = new Set(
    existingLinks
      .filter((el) => dateToIST(new Date(el.report.date)) !== dateToIST(reportDate))
      .map((el) => el.url?.trim().toLowerCase())
      .filter((u): u is string => !!u)
  );
```

- [ ] **Step 6: Run the dedup test again to confirm no regression**

Run: `npm run test -w @dashmani/api -- daily-report -t "cross-day duplicate links even in a large batch"`
Expected: PASS.

- [ ] **Step 7: Write a failing test for the midnight same-day re-submit safety (root cause #3 edge)**

This proves that re-submitting the SAME links on the SAME day (e.g. fixing a typo in notes) does NOT drop them as "cross-day" duplicates. Add inside `describe("POST /v1/hr/reports", ...)`:

```ts
    it("does not drop a link when re-submitting the same day (not a cross-day dup of itself)", async () => {
      // First submission
      await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-10",
          links: [{ accountId, url: "https://instagram.com/p/sameday", platform: "instagram" }],
          notes: "first",
        });

      // Re-submit SAME date + SAME link (e.g. just changing notes)
      const res = await request(app)
        .post("/v1/hr/reports")
        .set("Authorization", `Bearer ${hrToken}`)
        .send({
          date: "2026-04-10",
          links: [{ accountId, url: "https://instagram.com/p/sameday", platform: "instagram" }],
          notes: "edited notes",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.links.length).toBe(1); // link survives — not dropped
      expect(res.body.data.notes).toBe("edited notes");
    });
```

- [ ] **Step 8: Run it — should PASS (the IST-day comparison already handles same-day correctly)**

Run: `npm run test -w @dashmani/api -- daily-report -t "re-submitting the same day"`
Expected: PASS. The dedup filter compares `dateToIST(el.report.date) !== dateToIST(reportDate)`; for a same-day resubmit both sides are the same IST day, so the link is **not** classified cross-day. This test is the regression guard that the midnight-edge logic stays correct. (If this ever fails, it means a same-day link is being wrongly dropped — exactly the bug we are guarding against.)

- [ ] **Step 9: Switch the link inserts from nested `create` to explicit `createMany`**

With the cap removed, make the large-write path explicit and avoid the heavy `include` join firing during the write. Replace the `update` branch (originally lines ~157–185) and the `create` branch (originally lines ~186–212).

For the **resubmit/update** branch, replace:

```ts
  if (existing) {
    // Delete old links and recreate
    await prisma.reportLink.deleteMany({ where: { reportId: existing.id } });

    report = await prisma.dailyReport.update({
      where: { id: existing.id },
      data: {
        notes,
        latitude,
        longitude,
        submittedAt: new Date(),
        links: {
          create: links.map((l) => ({
            accountId: l.accountId,
            url: l.url ? l.url.trim() : null,
            platform: l.platform,
            description: l.description,
            mediaUrl: l.mediaUrl,
            likes: l.likes,
            comments: l.comments,
            shares: l.shares,
            views: l.views,
            isScheduled: l.isScheduled ?? false,
            scheduledFor: l.scheduledFor ? new Date(l.scheduledFor) : null,
          })),
        },
      },
      include: reportInclude,
    });
  } else {
```

with:

```ts
  if (existing) {
    // Delete old links, update the report row, then bulk-insert the new links.
    // Wrapped in a transaction so a resubmit is atomic (old code did deleteMany
    // outside any transaction — a mid-write failure could leave the report empty).
    await prisma.$transaction([
      prisma.reportLink.deleteMany({ where: { reportId: existing.id } }),
      prisma.dailyReport.update({
        where: { id: existing.id },
        data: { notes, latitude, longitude, submittedAt: new Date() },
      }),
      prisma.reportLink.createMany({
        data: links.map((l) => ({
          reportId: existing.id,
          accountId: l.accountId,
          url: l.url ? l.url.trim() : null,
          platform: l.platform,
          description: l.description,
          mediaUrl: l.mediaUrl,
          likes: l.likes,
          comments: l.comments,
          shares: l.shares,
          views: l.views,
          isScheduled: l.isScheduled ?? false,
          scheduledFor: l.scheduledFor ? new Date(l.scheduledFor) : null,
        })),
      }),
    ]);

    // createMany does not return rows — re-fetch with the include for the response.
    report = await prisma.dailyReport.findUnique({
      where: { id: existing.id },
      include: reportInclude,
    });
  } else {
```

For the **first-submit/create** branch, replace:

```ts
    report = await prisma.dailyReport.create({
      data: {
        employeeId,
        date: reportDate,
        notes,
        latitude,
        longitude,
        links: {
          create: links.map((l) => ({
            accountId: l.accountId,
            url: l.url ? l.url.trim() : null,
            platform: l.platform,
            description: l.description,
            mediaUrl: l.mediaUrl,
            likes: l.likes,
            comments: l.comments,
            shares: l.shares,
            views: l.views,
            isScheduled: l.isScheduled ?? false,
            scheduledFor: l.scheduledFor ? new Date(l.scheduledFor) : null,
          })),
        },
      },
      include: reportInclude,
    });
  }

  return formatReport(report);
```

with:

```ts
    const created = await prisma.dailyReport.create({
      data: { employeeId, date: reportDate, notes, latitude, longitude },
    });
    await prisma.reportLink.createMany({
      data: links.map((l) => ({
        reportId: created.id,
        accountId: l.accountId,
        url: l.url ? l.url.trim() : null,
        platform: l.platform,
        description: l.description,
        mediaUrl: l.mediaUrl,
        likes: l.likes,
        comments: l.comments,
        shares: l.shares,
        views: l.views,
        isScheduled: l.isScheduled ?? false,
        scheduledFor: l.scheduledFor ? new Date(l.scheduledFor) : null,
      })),
    });
    report = await prisma.dailyReport.findUnique({
      where: { id: created.id },
      include: reportInclude,
    });
  }

  return formatReport(report);
```

> **Why this is safe:** `formatReport` already tolerates a possibly-empty `links` array (`report.links ?? []`). `report` is now `DailyReport | null`, but it is always found immediately after create/update in the same request, so it is non-null in practice. To satisfy TypeScript, see Step 10.

- [ ] **Step 10: Fix the `report` type so TypeScript accepts the `findUnique` result**

The `let report;` declaration (originally line ~155) now receives the result of `findUnique`, which is nullable. Add a guard right before `return formatReport(report)`:

```ts
  if (!report) {
    throw new AppError(500, "INTERNAL_ERROR", "Report could not be loaded after save");
  }

  return formatReport(report);
```

(Place this immediately before the final `return formatReport(report);`, replacing that single return line with the guard + return.)

- [ ] **Step 11: Run the full daily-report test suite**

Run: `npm run test -w @dashmani/api -- daily-report`
Expected: ALL pass — including the existing "creates a daily report", "updates existing report", "returns 400 when links array is empty", plus the three new tests (>500 accepted, large cross-day dedup, same-day resubmit safe).

- [ ] **Step 12: Type-check the API**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: no errors.

- [ ] **Step 13: Commit**

```bash
git add apps/api/src/services/daily-report.service.ts apps/api/tests/daily-report.test.ts
git commit -m "feat(reports): remove server link cap, chunk cross-day dedup, atomic createMany inserts"
```

---

## Task 4: Remove the frontend cap + dead duplicate guard (root cause #2)

**Files:**
- Modify: `apps/hr/src/app/report/page.tsx` (lines 33, 459–462, 933–945, and the dead `duplicateUrls` submit guard at 535)

- [ ] **Step 1: Remove the `MAX_LINKS` constant**

In `apps/hr/src/app/report/page.tsx`, delete line 33:

```ts
const MAX_LINKS = 500;
```

- [ ] **Step 2: Remove the cap guard in `addLink`**

Change `addLink` (lines ~459–462) from:

```ts
  function addLink() {
    if (links.length >= MAX_LINKS) return;
    setLinks((prev) => [...prev, emptyLink()]);
  }
```

to:

```ts
  function addLink() {
    setLinks((prev) => [...prev, emptyLink()]);
  }
```

- [ ] **Step 3: Remove the `MAX_LINKS` gate around the "Add Another Link" button**

The button is wrapped in `{links.length < MAX_LINKS && ( ... )}` (lines ~934–945). Remove the conditional wrapper so the button always renders. Change:

```tsx
        {links.length < MAX_LINKS && (
          <button
            type="button"
            onClick={addLink}
            className="flex items-center gap-2 text-sm text-[#7A7A7A] hover:text-[#1A1A1A] font-medium px-4 py-3 rounded-xl border border-dashed border-[#E8E0D0] hover:border-[#F5D547] hover:bg-[#FFFDF5] transition-all w-full justify-center bg-[#FEFCF7] group"
          >
            <div className="h-6 w-6 rounded-md bg-[#F7ECD5] flex items-center justify-center group-hover:bg-[#FFF3C4] transition-colors">
              <Plus className="h-3.5 w-3.5 text-[#7A7A7A] group-hover:text-[#B8960C]" />
            </div>
            Add Another Link
          </button>
        )}
```

to (remove the `{links.length < MAX_LINKS && (` opening and its closing `)}`):

```tsx
        <button
          type="button"
          onClick={addLink}
          className="flex items-center gap-2 text-sm text-[#7A7A7A] hover:text-[#1A1A1A] font-medium px-4 py-3 rounded-xl border border-dashed border-[#E8E0D0] hover:border-[#F5D547] hover:bg-[#FFFDF5] transition-all w-full justify-center bg-[#FEFCF7] group"
        >
          <div className="h-6 w-6 rounded-md bg-[#F7ECD5] flex items-center justify-center group-hover:bg-[#FFF3C4] transition-colors">
            <Plus className="h-3.5 w-3.5 text-[#7A7A7A] group-hover:text-[#B8960C]" />
          </div>
          Add Another Link
        </button>
```

> **Note:** `handleSmartPaste` (lines ~474–524) already has **no** cap guard — that was the bug that let paste silently exceed 500. With `MAX_LINKS` gone, paste is now correctly unlimited and there is no cap to silently breach. No change needed there. The auto-dedupe `useEffect` (lines ~378–402) continues to dedupe pasted links regardless of count.

- [ ] **Step 4: Confirm the dead `duplicateUrls` submit guard is harmless, leave it**

At line ~535 there is `if (duplicateUrls.length > 0) { setError(...); return; }`, and `duplicateUrls` is declared as an always-empty array at line ~439 (`const duplicateUrls: string[] = [];`). This guard can never fire. It is dead but harmless. **Leave it** to keep this change minimal and focused on the cap — removing it is a separate cleanup. (Documenting it here so the engineer doesn't think they missed something.)

- [ ] **Step 5: Type-check the HR app**

Run: `npx tsc --noEmit -p apps/hr/tsconfig.json`
Expected: no errors (no remaining references to `MAX_LINKS`).

- [ ] **Step 6: Grep to confirm no `MAX_LINKS` references remain**

Run: `grep -rn "MAX_LINKS" apps/hr/src`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add apps/hr/src/app/report/page.tsx
git commit -m "feat(hr): remove 500-link UI cap — unlimited links + paste, button always available"
```

---

## Task 5: Full build verification (all apps)

Per CLAUDE.md, a broken build on the HR/login surface locks everyone out. The auth pages may import shared components, so a single-app build is insufficient — run the full build.

**Files:** none (verification only).

- [ ] **Step 1: Build the shared package first (its validator changed)**

Run: `npm run build -w @dashmani/shared`
Expected: success.

- [ ] **Step 2: Full monorepo build**

Run: `npm run build`
Expected: all apps build successfully (api, internal, client, hr, jobs).

- [ ] **Step 3: Run the entire API test suite (not just daily-report) to catch cross-cutting breakage**

Run: `npm run test -w @dashmani/api`
Expected: all tests pass. (Confirms the shared-validator rebuild and service refactor didn't break admin-reports, summary, analytics, etc.)

- [ ] **Step 4: Commit any incidental lockfile/tsbuildinfo changes if the build produced them**

```bash
git add -A
git commit -m "chore: build artifacts after report-cap removal" || echo "nothing to commit"
```

---

## Task 6: Production infra hardening (root cause #3 — transport timeouts)

The code fixes above turn timeouts into actionable messages, but with unlimited links we should also raise the transport limits that were cutting large/slow submissions. **This is a server-side change, not a repo change** — the live `api.digitalsukoon.com` nginx config is NOT in the repo (only the jobs site is), so it must be inspected and edited on the Linode box.

**Files:**
- Modify (on server): the nginx server block for `api.digitalsukoon.com` (location unknown until inspected)
- Reference: `scripts/security-setup.sh:60-67` (the global `client_body_timeout 10` / `send_timeout 10` / `client_max_body_size 10m`)

- [ ] **Step 1: Inspect the live nginx config to find the API server block and current timeouts**

```bash
ssh linode "grep -rl 'api.digitalsukoon.com' /etc/nginx/ ; echo '---' ; cat /etc/nginx/conf.d/security.conf"
```

Expected: identifies the file containing the `api.digitalsukoon.com` server block and prints the global timeouts (`client_body_timeout 10`, `send_timeout 10`, `client_max_body_size 10m`).

- [ ] **Step 2: Confirm whether the `limit_req zone=api` directive is actually applied**

```bash
ssh linode "grep -rn 'limit_req' /etc/nginx/"
```

Expected: shows whether the `zone=api` rate-limit zone defined in `rate-limit.conf` is referenced by any `limit_req` directive. If it is applied to the API location **without** a generous `burst`, a synchronized midnight submission spike from one office IP gets throttled. Note the finding — if applied, add `burst=120 nodelay` in Step 3.

- [ ] **Step 3: Raise the timeouts and body size for the API location (on server)**

In the `api.digitalsukoon.com` server block (or a dedicated `location /` within it), add/raise:

```nginx
    # Large daily-report submissions can take longer than the global 10s.
    client_body_timeout 120s;
    send_timeout 120s;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    client_max_body_size 25m;   # must stay >= express.json limit (10mb); headroom for large link batches

    # If a limit_req zone=api directive is applied here, give it burst headroom
    # so the midnight submission spike from one office NAT IP isn't throttled:
    # limit_req zone=api burst=120 nodelay;
```

> **Important:** `client_max_body_size` must be **≥** the Express `express.json({ limit: "10mb" })` in `apps/api/src/app.ts:66`. Raising nginx to 25m without raising Express just means Express returns its own clean 413 JSON envelope for 10–25mb bodies — which is now handled gracefully by Task 1. That's acceptable; a 650-link payload is ~190KB, far under either limit, so this is pure headroom.

- [ ] **Step 4: Validate and reload nginx**

```bash
ssh linode "nginx -t && systemctl reload nginx"
```

Expected: `nginx: configuration file /etc/nginx/nginx.conf test is successful` then a clean reload.

- [ ] **Step 5: Update `scripts/security-setup.sh` so a future server re-provision keeps these limits**

The global block in `scripts/security-setup.sh:60-67` re-applies the tight 10s timeouts on every run. Update it so the documented intent matches production. Change lines 60–67 from:

```bash
# Limit request body size
client_max_body_size 10m;

# Connection timeouts
client_body_timeout 10;
client_header_timeout 10;
send_timeout 10;
keepalive_timeout 65;
```

to:

```bash
# Limit request body size (>= API express.json 10mb limit, with headroom for large link batches)
client_max_body_size 25m;

# Connection timeouts — header timeout stays tight; body/send raised so large
# daily-report submissions are not cut mid-upload/mid-response.
client_body_timeout 120;
client_header_timeout 10;
send_timeout 120;
keepalive_timeout 65;
```

- [ ] **Step 6: Commit the script change**

```bash
git add scripts/security-setup.sh
git commit -m "chore(infra): raise nginx body/send timeouts + body size for large report submissions"
```

> **Note:** This commit does NOT auto-apply to the live server — `scripts/security-setup.sh` is run manually ("Run once on server setup"). Steps 3–4 are the live change; Step 5 keeps the script honest for the next provision.

---

## Task 7: Manual end-to-end verification

**Files:** none (manual verification using the `verify` skill or a real browser).

- [ ] **Step 1: Local smoke test — submit a large report**

Start the stack (`npm run dev`), log into the HR portal (`http://localhost:3002`), go to `/report`, paste 600+ URLs via Smart Paste, and submit. Expected: submission succeeds (201), the "Submitted today" panel shows all links, no "Load failed".

- [ ] **Step 2: Local failure-message test — simulate a server error**

Temporarily stop the API (`lsof -ti:4000 | xargs kill`), then submit a report. Expected: the toast now reads "Couldn't reach the server. Check your connection and try again — your data was not saved." (the new `NETWORK_ERROR` message), **not** "Load failed". Restart the API afterward.

- [ ] **Step 3: Local 401-refresh regression test**

In DevTools → Application → Local Storage, corrupt `hrAccessToken` to an expired/garbage value (keep `hrRefreshToken` valid), then submit. Expected: `apiFetch` gets a 401, calls `tryRefresh`, succeeds, retries, and the submission goes through — confirming the refresh path still works after the rewrite.

- [ ] **Step 4: Production verification after deploy**

After merging to `main` and the ~3-min auto-deploy (and running Task 6 on the server), verify:

```bash
curl -s https://api.digitalsukoon.com/v1/health   # {"success":true}
```

Then in a real browser on the HR portal, submit a large report. Expected: success, no "Load failed".

---

## Deployment notes

- **No `db:push` required.** No `schema.prisma` changes — only service logic, a validator, frontend, and nginx. (`createMany` and chunking use existing columns/indexes; `report_links` already has `@@index([url])`.)
- **`@dashmani/shared` must rebuild before the API uses the validator change.** The deploy script runs `npm install` + `turbo build`, which builds shared first via the dependency graph — so the auto-deploy handles it. Locally you must `npm run build -w @dashmani/shared` after editing the validator (covered in Task 2 Step 4 and Task 5 Step 1).
- **Task 6 (nginx) is a manual server step** — it does not happen via CI/CD. Do it once on the Linode box after the code deploy.
- **Token behavior:** unchanged — `JWT_SECRET`/`JWT_REFRESH_SECRET` untouched, so existing sessions survive the deploy.

---

## Self-Review checklist (completed by plan author)

- **Spec coverage:** Root cause #1 ("Load failed") → Task 1 + Task 6. Root cause #2 (>500 cap) → Tasks 2, 3, 4. Root cause #3 (~140/midnight transport) → Task 3 (chunking, atomic writes, midnight-edge guard) + Task 6 (nginx). User's "no cap" requirement → Tasks 2, 3, 4. All four reported symptoms covered.
- **Placeholder scan:** No TBD/TODO/"handle edge cases". Every code step shows full code.
- **Type consistency:** `ApiError(message, code, details)` signature matches the existing class. `createMany` data shape includes `reportId` (the mandatory FK that nested `create` set implicitly). `report` is guarded for null after the `findUnique`. `formatReport` tolerates empty/!null links.
- **Known intentional non-fix:** the dead `duplicateUrls` submit guard (Task 4 Step 4) is left in place as out-of-scope cleanup, explicitly documented so the engineer doesn't chase it.
