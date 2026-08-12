# Snapchat Spotlight Insights (Top Links) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Snapchat Spotlight engagement (views, comments, shares) + captions to the existing Top Links / Link Search pipeline, using a token-free public-web scraper — no Snapchat API, no allowlisting, no OAuth.

**Architecture:** Mirror the proven Facebook scraper pattern exactly. A submitted `snapchat.com/t/<code>` share link is redirect-resolved (once at submit time, and in the cron for the backlog) into a clean `snapchat.com/spotlight/<id>` URL when — and only when — it points at a Spotlight. A new `snapchat-scraper.ts` fetches that spotlight page (Googlebot UA), parses the embedded `__NEXT_DATA__` JSON, and reads `spotlightStories[0].metadata.engagementStats`. A new `snapchat.provider.ts` plugs into the existing registry + 6h cron. Adding `"snapchat"` to `SUPPORTED_INSIGHT_PLATFORMS` makes the DYNAMIC surfaces (InsightBadge, `getInsightsSummary`, HR `/report` panel, analytics) light up automatically. The HARDCODED surfaces (Top Links panel, per-platform leaderboards backend+UI, dashboard tiles, Link Search coverage, and the one HR panel subtitle string) each need Snapchat added explicitly — Tasks 8–13 do exactly that, so Snapchat appears **everywhere IG/FB do**. Snapchat ranks by **views** (like YouTube/Facebook) — it exposes views + comments + shares but **no likes** (never fabricate a likes value). Links that resolve to ephemeral Stories (`viewCount:"-1"`) are recorded `not_found` and surfaced honestly in the coverage note.

**Parity principle (why Tasks 8–13 exist):** A complete inventory (2026-07-14) found the codebase splits into DYNAMIC surfaces (keyed off data / `SUPPORTED_INSIGHT_PLATFORMS` — Snapchat auto-appears once metrics flow) and HARDCODED surfaces (literal `["youtube","instagram","facebook"]` lists that silently omit Snapchat). The dynamic ones need no work. Every hardcoded one is enumerated and fixed below so there is no surface where IG/FB show and a Snapchat panel is missing. Surfaces confirmed already-dynamic (NO task needed): both `insight-badge.tsx` copies (switch on `isPlatformInsightSupported` — once `"snapchat"` is in `SUPPORTED_INSIGHT_PLATFORMS`, a Snapchat link renders real metrics, not the "Insights soon" placeholder), the HR `/report` "Your link insights" panel's *rendering/filter* (platform-agnostic — Snapchat rows flow through automatically), `social-insights.service.ts` `getInsightsSummary`/`byPlatform`, `analytics.service.ts`, `daily-report.service.ts` breakdowns, `account-growth.service.ts` `topMoversByPlatform` (Snapchat already present), `follower-sync.service.ts` (already syncs Snapchat), `accounts/growth` page, HR dashboard pills, `platform-icon.tsx` (Snapchat SVG already mapped), and the `reports/[employeeId]` + `employees/[id]/performance` color maps (already list `snapchat`). The HR leaderboard is a single platform-agnostic board (no per-platform boards) — nothing to add there. **⚠️ EXCEPTION found by adversarial review: the HR `/report` panel's dynamic *filter* is fine, but its hardcoded *subtitle string* names only "YouTube, Instagram and Facebook" — Task 13 fixes that one string. The panel is otherwise untouched.** Also verified (validation-safety agent): there is NO Prisma enum, Zod whitelist, or DB constraint on `platform` that rejects `"snapchat"` (all `String`/free), and the `Platform` table already has a Snapchat row seeded — so a `platform="snapchat"` write/read never throws or is dropped anywhere beyond the hardcoded display surfaces Tasks 8–13 fix.

**Tech Stack:** TypeScript, Node/Express (`apps/api`), Prisma (`link_metrics`/`link_content`/`report_links`), Vitest, the existing `social-insights` provider architecture, `@dashmani/shared` canonicalKey/extractors, Next.js internal portal (`apps/internal`).

---

## Background — the live-verified facts this plan is built on

All verified from the **Linode production IP** on 2026-07-14 (read-only probes; see memory `project_snapchat_spotlight_scraper_viable`):

1. **`https://www.snapchat.com/spotlight/<id>` returns 200 + ~500KB HTML** to a logged-out Googlebot-UA GET, from the Linode datacenter IP. No login wall.
2. The HTML embeds `<script id="__NEXT_DATA__">…</script>` (~245KB JSON). Parse with `JSON.parse`.
3. **The target spotlight is `props.pageProps.spotlightFeed.spotlightStories[0]`** — always index 0. Indices 1..24 are *recommended-feed neighbors* (different creators). Confirmed: the URL's spotlight id appears inside `spotlightStories[0]`, not a neighbor. **NEVER first-match `viewCount` across the page** (30 distinct values = 30 neighbors, same trap as FB `play_count`).
4. `spotlightStories[0].metadata.engagementStats` = `{ viewCount, shareCount, commentCount, boostCount, recommendCount }` — all **strings**. Live example: `{viewCount:"10651854", shareCount:"69071", commentCount:"11289", boostCount:"194573", recommendCount:"10066"}`. **Stable across refetches** (unlike FB play_count).
5. `spotlightStories[0].metadata.videoMetadata.embeddedTextCaption` (and `.description`) is the **caption** → feeds Link Search.
6. **Prod `report_links` has 124 Snapchat links, ALL `snapchat.com/t/<code>` shares** (0 native `/spotlight/`). Resolving a sample of 8 via 302-follow: **3 → `.../p/<uuid>/spotlight/W7_…` (scrapeable)**, **5 → `.../p/<uuid>/<storyId>?chapterid=…` (Story — `viewCount:"-1"` sentinel, no public stats, permanent dead-end)**.
7. Both `https://www.snapchat.com/spotlight/<id>` AND `.../p/<uuid>/spotlight/<id>` return byte-identical stats → the clean `/spotlight/<id>` form is the canonical one.
8. The `/t/` share redirect is followable with a plain `redirect:"follow"` GET (Googlebot UA), landing on the final `/p/<uuid>/…` URL.

**Design decisions (confirmed with product owner 2026-07-14):**
- Resolution happens **submit-time + cron** (mirrors the FB `/share/` resolver), with a **one-time backfill** for the 124 existing links.
- Story links (the ~2/3 remainder) are recorded `not_found` and explained in an **honest coverage note** — matching the IG/FB convention.

---

## File Structure

**Create:**
- `apps/api/src/services/social-insights/snapchat-scraper.ts` — pure `parseSnapchatSpotlightHtml(html)` + fail-open `scrapeSnapchatSpotlightEngagement(spotlightId)`. Mirrors `facebook-scraper.ts`.
- `apps/api/src/services/social-insights/snapchat.provider.ts` — `InsightProvider` for slug `"snapchat"`; `extractTargetId` reads a spotlight id out of a resolved URL; `fetchBatch` scrapes; `harvestContent` returns captions; plus the submit-time `resolveSnapchatShareUrl` resolver (mirrors `resolveFacebookShareUrl`).
- `apps/api/tests/snapchat-scraper.test.ts` — unit tests for the parser (fixture-based) + fail-open scraper.
- `apps/api/tests/snapchat.provider.test.ts` — provider fetchBatch + resolver tests (injected fetch, no network).
- `packages/shared/src/utils/snapchat.ts` — `extractSnapchatSpotlightId(url)` (pure, mirrors `extractFacebookPostId`).
- `apps/api/tests/snapchat.test.ts` — extractor + canonicalKey `sc:` branch tests.
- `scripts/resolve-snapchat-links.ts` — one-time backfill: resolve the 124 `/t/` links → clean `/spotlight/<id>` where they point at a spotlight. Dry-run default; `--apply --confirm-prod`.

**Modify:**
- `packages/shared/src/utils/canonical-url.ts` — add a `sc:<spotlightId>` branch (replaces the current "intentionally NOT canonicalized" comment block).
- `packages/shared/src/index.ts` — re-export the new `snapchat.ts` (add `export * from "./utils/snapchat";`).
- `packages/shared/src/utils/social-insights.ts` — add `"snapchat"` to `SUPPORTED_INSIGHT_PLATFORMS`.
- `apps/api/src/services/social-insights/registry.ts` — register `snapchatProvider` (LAST — cheapest/most-reliable first; Snapchat is a small 124-link scrape, safe anywhere, but put it last to protect the big providers' budgets).
- `apps/api/src/services/daily-report.service.ts` — extend the submit-time opaque-resolve pass to also resolve `snapchat.com/t/` links.
- `apps/api/src/services/social-insights/index.ts` — export the provider (barrel re-exports each provider).
- `apps/internal/src/app/reports/page.tsx` — add a `snapchat` entry to the Top Links platform list + color tokens (`showViews: true`). [Task 8]
- `apps/api/src/services/leaderboard.service.ts` — add `"snapchat"` to `platformOfUrl`, the Map type signatures, `PlatformBoardKey`, and the `getPlatformLeaderboards` return (ranked by views). [Task 10]
- `apps/internal/src/app/reports/leaderboard/page.tsx` — add a `snapchat` entry (`rankBy:"Views", showViews:true`) to the per-platform boards render array. [Task 11]
- `apps/internal/src/app/dashboard/page.tsx` — add `snapchat` to `PERF_METRICS`, `TOP_LINK_PLATFORMS`, and the perf-metric `if` branch. [Task 12]
- `apps/api/src/services/link-search.service.ts` — add `sc:` to `idPartFor` + the `buildCoverage` SQL CTEs so Snapchat coverage is computed. [Task 9]
- `apps/api/src/services/link-content.service.ts` — `platformFromCanonicalKey`: add `sc:` → `snapchat`. [Task 9]
- `apps/internal/src/app/reports/link-search/page.tsx` — add `snapchat` to the coverage `ORDER` + `LABEL`, plus the honest Story note. [Task 9]
- `apps/internal/src/app/analytics/content/page.tsx` — add `snapchat` to `PLATFORM_COLORS` (cosmetic — it already falls back to grey, but add for consistency). [Task 12]

---

## Task 1: `extractSnapchatSpotlightId` shared extractor

**Files:**
- Create: `packages/shared/src/utils/snapchat.ts`
- Test: `apps/api/tests/snapchat.test.ts`
- Modify: `packages/shared/src/index.ts:32` (add re-export after the canonical-url line)

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/snapchat.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractSnapchatSpotlightId } from "@dashmani/shared";

describe("extractSnapchatSpotlightId", () => {
  it("extracts id from a clean /spotlight/<id> url", () => {
    expect(
      extractSnapchatSpotlightId(
        "https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYa3JhbHR0Y3BpAZ6MCwRbAZ6MBHi6AAAAAQ"
      )
    ).toBe("W7_EDlXWTBiXAEEniNoMPwAAYa3JhbHR0Y3BpAZ6MCwRbAZ6MBHi6AAAAAQ");
  });

  it("extracts id from a /p/<uuid>/spotlight/<id> resolved url (with query)", () => {
    expect(
      extractSnapchatSpotlightId(
        "https://www.snapchat.com/p/4fcb9c20-b0da-45ec-abd7-0106bb9f21ec/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYZm10eXVpYXNuAZ6OrSwoAZ6Oq1abAAAAAQ?locale=en_US&sid=abc"
      )
    ).toBe("W7_EDlXWTBiXAEEniNoMPwAAYZm10eXVpYXNuAZ6OrSwoAZ6Oq1abAAAAAQ");
  });

  it("strips m./www. host prefixes", () => {
    expect(
      extractSnapchatSpotlightId("https://m.snapchat.com/spotlight/W7_ABCdefGHIjklMNOpqrsAAAAAQ")
    ).toBe("W7_ABCdefGHIjklMNOpqrsAAAAAQ");
  });

  it("returns null for a /t/<code> share link (unresolved — no spotlight id yet)", () => {
    expect(extractSnapchatSpotlightId("https://snapchat.com/t/rfm4p1Y7")).toBeNull();
  });

  it("returns null for a /p/<uuid>/<storyId> story url (not a spotlight)", () => {
    expect(
      extractSnapchatSpotlightId(
        "https://www.snapchat.com/p/4fcb9c20-b0da-45ec-abd7-0106bb9f21ec/3137385781778432?chapterid=3137385781778433"
      )
    ).toBeNull();
  });

  it("returns null for a non-snapchat host", () => {
    expect(extractSnapchatSpotlightId("https://www.youtube.com/spotlight/abc")).toBeNull();
  });

  it("returns null for null/empty/garbage", () => {
    expect(extractSnapchatSpotlightId(null)).toBeNull();
    expect(extractSnapchatSpotlightId("")).toBeNull();
    expect(extractSnapchatSpotlightId("not a url")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/tests/snapchat.test.ts`
Expected: FAIL — "Cannot find module '../snapchat'".

- [ ] **Step 3: Write the extractor**

Create `packages/shared/src/utils/snapchat.ts`:

```typescript
// Snapchat Spotlight id extraction.
//
// Mirrors `extractFacebookPostId` (./facebook.ts) and the `sc:` branch of
// canonicalKey: parse with `new URL` in a try/catch, validate the host, and
// extract ONLY a spotlight id from a /spotlight/<id> path segment.
//
// WHY SPOTLIGHT-ONLY:
// Submitted Snapchat links are `snapchat.com/t/<code>` SHARE redirects. Their code
// is a tracking token, not a content id, so this returns null for them (they must
// be redirect-resolved first — see resolveSnapchatShareUrl in snapchat.provider.ts).
// After resolution a share link becomes EITHER `.../spotlight/<id>` (a Spotlight —
// we extract the id) OR `.../p/<uuid>/<storyId>` (an ephemeral Story — no public
// stats; we return null so the cron skips it, exactly like an opaque FB /share/).
//
// The spotlight id is the `W7_...`-style opaque base64url token in the /spotlight/
// path segment. It is CASE-SENSITIVE (like IG shortcodes / YT video ids) → never
// lowercased. Both `.../spotlight/<id>` and `.../p/<uuid>/spotlight/<id>` forms
// carry it; we match the last `/spotlight/<id>` segment in either shape.
//
// GUARANTEES (kept in lock-step with canonicalKey's `sc:` branch):
//  - `/spotlight/<id>` (with or without a `/p/<uuid>` prefix, with or without query)
//    → the id.
//  - `/t/<code>` share, `/p/<uuid>/<storyId>` story, `/add/<h>`, `/@<h>` → null.
//  - Non-URL or non-Snapchat host → null.

const SNAPCHAT_HOST = "snapchat.com";

export function extractSnapchatSpotlightId(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, "");
  if (host !== SNAPCHAT_HOST && !host.endsWith("." + SNAPCHAT_HOST)) return null;

  // Match a /spotlight/<id> segment anywhere in the path (covers both the clean
  // /spotlight/<id> form and the resolved /p/<uuid>/spotlight/<id> form).
  const m = url.pathname.match(/\/spotlight\/([A-Za-z0-9_-]{8,})/);
  return m && m[1] ? m[1] : null; // case-sensitive — never lowercase
}
```

- [ ] **Step 4: Add the re-export**

In `packages/shared/src/index.ts`, after line 32 (`export * from "./utils/canonical-url";`), add:

```typescript
export * from "./utils/snapchat";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/api/tests/snapchat.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/utils/snapchat.ts apps/api/tests/snapchat.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add extractSnapchatSpotlightId extractor"
```

---

## Task 2: `canonicalKey` `sc:` branch

**Files:**
- Modify: `packages/shared/src/utils/canonical-url.ts:1` (import) and `:77-85` (replace the "intentionally NOT canonicalized" comment block with a real branch)
- Test: `apps/api/tests/snapchat.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to the existing file)**

Append to `apps/api/tests/snapchat.test.ts`:

```typescript
import { canonicalKey } from "@dashmani/shared";

describe("canonicalKey — Snapchat sc: branch", () => {
  it("keys a clean /spotlight/<id> to sc:<id>", () => {
    expect(
      canonicalKey("https://www.snapchat.com/spotlight/W7_EDlXWTBiXAEEniNoMPwAAYa3JhbHR0Y3BpAZ6MCwRbAZ6MBHi6AAAAAQ")
    ).toBe("sc:W7_EDlXWTBiXAEEniNoMPwAAYa3JhbHR0Y3BpAZ6MCwRbAZ6MBHi6AAAAAQ");
  });

  it("keys a resolved /p/<uuid>/spotlight/<id> to the same sc:<id>", () => {
    expect(
      canonicalKey("https://www.snapchat.com/p/4fcb9c20-b0da-45ec-abd7-0106bb9f21ec/spotlight/W7_XYZ12345678?locale=en_US")
    ).toBe("sc:W7_XYZ12345678");
  });

  it("keeps the spotlight id case-sensitive (never lowercased)", () => {
    expect(canonicalKey("https://www.snapchat.com/spotlight/W7_AbCdEfGh12345")).toBe("sc:W7_AbCdEfGh12345");
  });

  it("lets a /t/<code> share link FALL THROUGH to the full-url fallback (no sc: key)", () => {
    // Unresolved shares have no stable content id — collapsing distinct /t/ codes
    // would merge unrelated posts. Must behave exactly like the old fallback.
    expect(canonicalKey("https://snapchat.com/t/rfm4p1Y7")).toBe("https://snapchat.com/t/rfm4p1y7");
  });

  it("lets a /p/<uuid>/<storyId> story url FALL THROUGH (no sc: key — it's a Story, not a Spotlight)", () => {
    const storyUrl = "https://www.snapchat.com/p/4fcb9c20-b0da-45ec-abd7-0106bb9f21ec/3137385781778432";
    expect(canonicalKey(storyUrl)).toBe(storyUrl.toLowerCase());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/tests/snapchat.test.ts`
Expected: FAIL — the `sc:` assertions get the lowercased full-URL fallback instead of `sc:<id>`.

- [ ] **Step 3: Add the import**

In `packages/shared/src/utils/canonical-url.ts`, change line 1 from:

```typescript
import { extractYouTubeVideoId } from "./youtube";
```

to:

```typescript
import { extractYouTubeVideoId } from "./youtube";
import { extractSnapchatSpotlightId } from "./snapchat";
```

- [ ] **Step 4: Replace the Snapchat comment block with a real branch**

In `packages/shared/src/utils/canonical-url.ts`, replace the entire block at lines 77-85 (the `// ── Snapchat: intentionally NOT canonicalized ──` comment) with:

```typescript
  // ── Snapchat (Spotlight only) ──────────────────────────────────────────────
  // A RESOLVED spotlight url (clean /spotlight/<id> or /p/<uuid>/spotlight/<id>)
  // has a stable content id → key it sc:<id>. Case-sensitive (opaque base64url).
  // Unresolved /t/<code> shares AND /p/<uuid>/<storyId> STORY urls have no stable
  // spotlight id (extractSnapchatSpotlightId returns null) → they FALL THROUGH to
  // the full-URL fallback below, exactly like opaque FB /share/ links. This is
  // correct: a /t/ share is resolved to its clean spotlight url at submit time
  // (resolveSnapchatShareUrl) so future links come in already keyable; the
  // historical /t/ tail stays on the raw-url fallback (never over-collapsed).
  if (host === "snapchat.com" || host.endsWith(".snapchat.com")) {
    const id = extractSnapchatSpotlightId(s);
    if (id) return `sc:${id}`; // spotlight id kept case-sensitive
    // /t/ share + /p/<uuid>/<storyId> story → fall through (no stable key).
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/api/tests/snapchat.test.ts`
Expected: PASS (all 12 tests).

- [ ] **Step 6: Run the full canonical-url test suite to confirm no regressions**

Run: `npx vitest run packages/shared`
Expected: PASS — all existing IG/YT/FB canonicalKey tests still green (the sc: branch only fires on snapchat.com hosts, which previously fell through).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/utils/canonical-url.ts apps/api/tests/snapchat.test.ts
git commit -m "feat(shared): canonicalKey sc:<spotlightId> for resolved Snapchat Spotlights"
```

---

## Task 3: Snapchat scraper (parse + fetch)

**Files:**
- Create: `apps/api/src/services/social-insights/snapchat-scraper.ts`
- Test: `apps/api/tests/snapchat-scraper.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/snapchat-scraper.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  parseSnapchatSpotlightHtml,
  scrapeSnapchatSpotlightEngagement,
} from "../src/services/social-insights/snapchat-scraper";

// Minimal __NEXT_DATA__ fixture mirroring the real shape (spotlightStories[0] = target).
function fixture(stats: Record<string, string>, caption = "a fun clip", extra: object = {}) {
  const nextData = {
    props: {
      pageProps: {
        spotlightFeed: {
          spotlightStories: [
            {
              story: { snapList: [{ snapUrls: { mediaUrl: "https://x" } }] },
              metadata: {
                engagementStats: stats,
                videoMetadata: { embeddedTextCaption: caption, description: caption },
                ...extra,
              },
            },
            // a neighbor with DIFFERENT numbers — must be ignored
            {
              story: {},
              metadata: {
                engagementStats: { viewCount: "999", shareCount: "9", commentCount: "9", boostCount: "9", recommendCount: "9" },
                videoMetadata: { embeddedTextCaption: "neighbor caption" },
              },
            },
          ],
        },
      },
    },
  };
  // Pad to exceed MIN length so the parser accepts it.
  const pad = " ".repeat(60_000);
  return `<html><head></head><body>${pad}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></body></html>`;
}

describe("parseSnapchatSpotlightHtml", () => {
  it("reads engagementStats from spotlightStories[0] (the target, NOT a neighbor)", () => {
    const html = fixture({ viewCount: "10651854", shareCount: "69071", commentCount: "11289", boostCount: "194573", recommendCount: "10066" });
    const r = parseSnapchatSpotlightHtml(html);
    expect(r.views).toBe(10651854);
    expect(r.shares).toBe(69071);
    expect(r.comments).toBe(11289);
    expect(r.caption).toBe("a fun clip");
  });

  it("returns all-null for html shorter than the minimum", () => {
    const r = parseSnapchatSpotlightHtml("<html>short</html>");
    expect(r).toEqual({ views: null, likes: null, comments: null, shares: null, caption: null });
  });

  it("returns all-null when __NEXT_DATA__ is missing", () => {
    const r = parseSnapchatSpotlightHtml("x".repeat(60_000));
    expect(r.views).toBeNull();
    expect(r.caption).toBeNull();
  });

  it("treats viewCount -1 as null (ephemeral Story sentinel, not a real count)", () => {
    const html = fixture({ viewCount: "-1", shareCount: "0", commentCount: "0", boostCount: "0", recommendCount: "0" });
    const r = parseSnapchatSpotlightHtml(html);
    expect(r.views).toBeNull();
  });

  it("likes is always null (Snapchat exposes no like metric for Spotlight)", () => {
    const html = fixture({ viewCount: "100", shareCount: "1", commentCount: "1", boostCount: "1", recommendCount: "1" });
    expect(parseSnapchatSpotlightHtml(html).likes).toBeNull();
  });

  it("falls back to description when embeddedTextCaption is absent", () => {
    const nextData = {
      props: { pageProps: { spotlightFeed: { spotlightStories: [
        { story: {}, metadata: { engagementStats: { viewCount: "5" }, videoMetadata: { description: "desc only" } } },
      ] } } },
    };
    const html = `<html>${" ".repeat(60_000)}<script id="__NEXT_DATA__">${JSON.stringify(nextData)}</script></html>`;
    expect(parseSnapchatSpotlightHtml(html).caption).toBe("desc only");
  });
});

describe("scrapeSnapchatSpotlightEngagement (fail-open)", () => {
  it("returns all-null for an empty spotlight id (no fetch)", async () => {
    const r = await scrapeSnapchatSpotlightEngagement("", vi.fn());
    expect(r).toEqual({ views: null, likes: null, comments: null, shares: null, caption: null });
  });

  it("returns walled on a non-200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, url: "https://www.snapchat.com/spotlight/x", text: async () => "" });
    const r = await scrapeSnapchatSpotlightEngagement("W7_abc12345", fetchImpl as unknown as typeof fetch);
    expect(r.walled).toBe(true);
    expect(r.views).toBeNull();
  });

  it("returns walled on a login redirect", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, url: "https://accounts.snapchat.com/accounts/login", text: async () => "x".repeat(60_000) });
    const r = await scrapeSnapchatSpotlightEngagement("W7_abc12345", fetchImpl as unknown as typeof fetch);
    expect(r.walled).toBe(true);
  });

  it("parses a good 200 response", async () => {
    const html = `<html>${" ".repeat(60_000)}<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { spotlightFeed: { spotlightStories: [ { story: {}, metadata: { engagementStats: { viewCount: "42" }, videoMetadata: { embeddedTextCaption: "hi" } } } ] } } } })}</script></html>`;
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, url: "https://www.snapchat.com/spotlight/W7_abc12345", text: async () => html });
    const r = await scrapeSnapchatSpotlightEngagement("W7_abc12345", fetchImpl as unknown as typeof fetch);
    expect(r.views).toBe(42);
    expect(r.caption).toBe("hi");
    expect(r.walled).toBeFalsy();
  });

  it("returns walled on a thrown/timeout", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("timeout"));
    const r = await scrapeSnapchatSpotlightEngagement("W7_abc12345", fetchImpl as unknown as typeof fetch);
    expect(r.walled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/tests/snapchat-scraper.test.ts`
Expected: FAIL — "Cannot find module '../snapchat-scraper'".

- [ ] **Step 3: Write the scraper**

Create `apps/api/src/services/social-insights/snapchat-scraper.ts`:

```typescript
// ── Snapchat public Spotlight engagement scraper ─────────────────────────────
//
// A logged-out GET of a public Spotlight page (with a Googlebot User-Agent)
// returns the full page HTML — NO login wall — with engagement embedded in a
// Next.js `__NEXT_DATA__` JSON blob. This is the SAME technique the Facebook reel
// scraper uses (facebook-scraper.ts). It reads only public data, no credentials.
//
// VERIFIED LIVE FROM THE LINODE DATACENTER IP (2026-07-14):
//   • https://www.snapchat.com/spotlight/<id> → HTTP 200, ~500KB HTML, no wall.
//   • __NEXT_DATA__.props.pageProps.spotlightFeed.spotlightStories[0] IS the
//     spotlight in the URL (verified: the URL's id appears in stories[0]). The
//     other ~24 stories are RECOMMENDED-FEED NEIGHBORS (different creators). So
//     we read stories[0] ONLY — never first-match viewCount across the page
//     (that gives a neighbor's number, the same trap as FB play_count).
//   • stories[0].metadata.engagementStats = { viewCount, shareCount, commentCount,
//     boostCount, recommendCount } (all STRINGS). STABLE across refetches.
//   • Ephemeral STORY pages (from /t/ shares that aren't spotlights) serve
//     viewCount:"-1" — a sentinel, NOT a real count. We map -1 → null.
//   • Snapchat exposes NO like metric for Spotlight → `likes` is ALWAYS null.
//   • caption = videoMetadata.embeddedTextCaption (fallback: .description).
//
// FAIL-OPEN by contract: any non-200, login redirect, short body, missing blob,
// parse error, or timeout returns nulls — the caller keeps whatever it had.

import { recordApiUsage } from "../api-usage.service";

// Googlebot UA — verified to return the server-rendered HTML with __NEXT_DATA__.
const SCRAPER_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const SCRAPER_TIMEOUT_MS = 12_000;
// A real spotlight page is ~300-540KB. A login wall / error shell is far shorter.
const MIN_SPOTLIGHT_HTML_LEN = 50_000;

export interface ScrapedSnapEngagement {
  views: number | null;
  likes: number | null;     // ALWAYS null — Snapchat has no public Spotlight like metric.
  comments: number | null;
  shares: number | null;
  caption: string | null;
  // True when we were BLOCKED (login/checkpoint redirect or non-200), NOT "no data".
  // The provider counts consecutive walls to trip its per-run short-circuit.
  walled?: boolean;
}

const EMPTY: ScrapedSnapEngagement = { views: null, likes: null, comments: null, shares: null, caption: null };

export type FetchFn = typeof fetch;

// Parse a string stat → a positive integer, mapping the -1 Story sentinel and any
// non-positive / non-numeric value to null.
function toCount(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null; // -1 sentinel → null
  return n;
}

// Pull the __NEXT_DATA__ JSON blob and read spotlightStories[0]. Pure + synchronous.
// Exported for unit tests with captured fixtures.
export function parseSnapchatSpotlightHtml(html: string): ScrapedSnapEngagement {
  if (!html || html.length < MIN_SPOTLIGHT_HTML_LEN) return { ...EMPTY };

  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m || !m[1]) return { ...EMPTY };

  let data: any;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return { ...EMPTY };
  }

  const stories = data?.props?.pageProps?.spotlightFeed?.spotlightStories;
  if (!Array.isArray(stories) || stories.length === 0) return { ...EMPTY };

  // TARGET IS ALWAYS index 0 (the URL's spotlight). Never scan neighbors.
  const meta = stories[0]?.metadata ?? {};
  const stats = meta.engagementStats ?? {};
  const vmeta = meta.videoMetadata ?? {};

  const caption =
    (typeof vmeta.embeddedTextCaption === "string" && vmeta.embeddedTextCaption.trim()) ||
    (typeof vmeta.description === "string" && vmeta.description.trim()) ||
    null;

  return {
    views: toCount(stats.viewCount),
    likes: null, // Snapchat has no public Spotlight like metric — honest null.
    comments: toCount(stats.commentCount),
    shares: toCount(stats.shareCount),
    caption: caption || null,
  };
}

// Fetch + parse one public Spotlight's engagement by its spotlight id. Fail-open:
// returns all-null (walled:true on a block/error) on any non-200, login redirect,
// short body, missing blob, parse miss, or timeout.
export async function scrapeSnapchatSpotlightEngagement(
  spotlightId: string,
  fetchImpl: FetchFn = fetch
): Promise<ScrapedSnapEngagement> {
  if (!spotlightId || !/^[A-Za-z0-9_-]{8,}$/.test(spotlightId)) return { ...EMPTY };

  // Cost Sheet: count each scrape attempt (free public fetch; $0). Fire-and-forget.
  recordApiUsage({ provider: "meta", operation: "snap-spotlight-scraper", calls: 1, units: 1 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://www.snapchat.com/spotlight/${spotlightId}`, {
      headers: { "User-Agent": SCRAPER_UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { ...EMPTY, walled: true };
    if (/accounts\.snapchat\.com|\/login|\/checkpoint/i.test(res.url)) return { ...EMPTY, walled: true };
    const html = await res.text();
    return parseSnapchatSpotlightHtml(html);
  } catch {
    return { ...EMPTY, walled: true };
  } finally {
    clearTimeout(timer);
  }
}
```

> **Note on `recordApiUsage`:** confirm the `provider` union in `apps/api/src/services/api-usage.service.ts` accepts `"meta"` (the FB scraper already passes it). If the service types `provider` as a closed union WITHOUT a Snapchat value, keep `"meta"` (it groups the scrape under the Meta/scraper bucket exactly like the FB scraper does) — do NOT invent a new provider enum value that the Cost Sheet UI doesn't know how to render.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/api/tests/snapchat-scraper.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/social-insights/snapchat-scraper.ts apps/api/tests/snapchat-scraper.test.ts
git commit -m "feat(api): Snapchat Spotlight engagement scraper (token-free, fail-open)"
```

---

## Task 4: Snapchat provider + share-URL resolver

**Files:**
- Create: `apps/api/src/services/social-insights/snapchat.provider.ts`
- Test: `apps/api/tests/snapchat.provider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/snapchat.provider.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  snapchatProvider,
  resolveSnapchatShareUrl,
  __setScraperFetchForTesting,
  __resetSnapchatStateForTesting,
} from "../src/services/social-insights/snapchat.provider";
import type { InsightTarget } from "../src/services/social-insights/types";

function target(linkId: string, url: string, targetId: string): InsightTarget {
  return { linkId, url, urlNormalized: url.toLowerCase(), targetId, employeeId: "e1", reportDate: new Date("2026-07-01") };
}

const goodHtml = (views: string, caption = "hi") =>
  `<html>${" ".repeat(60_000)}<script id="__NEXT_DATA__">${JSON.stringify({
    props: { pageProps: { spotlightFeed: { spotlightStories: [
      { story: {}, metadata: { engagementStats: { viewCount: views, shareCount: "3", commentCount: "2" }, videoMetadata: { embeddedTextCaption: caption } } },
    ] } } },
  })}</script></html>`;

beforeEach(() => {
  __resetSnapchatStateForTesting();
  __setScraperFetchForTesting(null);
});

describe("snapchatProvider", () => {
  it("slug is snapchat and isSupported is true (scraper needs no token)", () => {
    expect(snapchatProvider.slug).toBe("snapchat");
    expect(snapchatProvider.isSupported()).toBe(true);
  });

  it("extractTargetId returns the spotlight id from a resolved url, null for /t/ + story", () => {
    expect(snapchatProvider.extractTargetId("https://www.snapchat.com/spotlight/W7_abc12345")).toBe("W7_abc12345");
    expect(snapchatProvider.extractTargetId("https://snapchat.com/t/rfm4p1Y7")).toBeNull();
    expect(snapchatProvider.extractTargetId("https://www.snapchat.com/p/uuid/3137385781778432")).toBeNull();
  });

  it("fetchBatch scrapes a spotlight → ok with views/comments/shares/caption, likes null", async () => {
    __setScraperFetchForTesting(
      vi.fn().mockResolvedValue({ ok: true, url: "https://www.snapchat.com/spotlight/W7_abc12345", text: async () => goodHtml("500000") }) as unknown as typeof fetch
    );
    const res = await snapchatProvider.fetchBatch([target("l1", "https://www.snapchat.com/spotlight/W7_abc12345", "W7_abc12345")]);
    const r = res.get("l1")!;
    expect(r.status).toBe("ok");
    expect(r.views).toBe(500000);
    expect(r.comments).toBe(2);
    expect(r.shares).toBe(3);
    expect(r.likes).toBeNull();
    expect(r.caption).toBe("hi");
  });

  it("fetchBatch → not_found when the scrape yields no real signal", async () => {
    __setScraperFetchForTesting(
      vi.fn().mockResolvedValue({ ok: true, url: "https://www.snapchat.com/spotlight/W7_x", text: async () => "x".repeat(60_000) }) as unknown as typeof fetch
    );
    const res = await snapchatProvider.fetchBatch([target("l1", "https://www.snapchat.com/spotlight/W7_x", "W7_x")]);
    expect(res.get("l1")!.status).toBe("not_found");
  });

  it("fetchBatch short-circuits after N consecutive walls (block detection)", async () => {
    const walled = vi.fn().mockResolvedValue({ ok: false, url: "https://www.snapchat.com/spotlight/x", text: async () => "" });
    __setScraperFetchForTesting(walled as unknown as typeof fetch);
    const targets = Array.from({ length: 10 }, (_, i) => target(`l${i}`, `https://www.snapchat.com/spotlight/W7_id${i}0000`, `W7_id${i}0000`));
    await snapchatProvider.fetchBatch(targets);
    // wall limit default 5 → after 5 walls it stops calling fetch for the rest.
    expect(walled.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("harvestContent returns captions keyed sc:<id> for scraped spotlights", async () => {
    __setScraperFetchForTesting(
      vi.fn().mockResolvedValue({ ok: true, url: "https://www.snapchat.com/spotlight/W7_abc12345", text: async () => goodHtml("10", "caption text") }) as unknown as typeof fetch
    );
    await snapchatProvider.fetchBatch([target("l1", "https://www.snapchat.com/spotlight/W7_abc12345", "W7_abc12345")]);
    const harvested = snapchatProvider.harvestContent!();
    expect(harvested).toContainEqual({ canonicalKey: "sc:W7_abc12345", caption: "caption text", title: null });
  });
});

describe("resolveSnapchatShareUrl", () => {
  it("resolves a /t/ share that redirects to a /spotlight/ → clean spotlight url", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      url: "https://www.snapchat.com/p/uuid/spotlight/W7_resolved123?locale=en_US",
    });
    const clean = await resolveSnapchatShareUrl("https://snapchat.com/t/abc", fetchImpl as unknown as typeof fetch);
    expect(clean).toBe("https://www.snapchat.com/spotlight/W7_resolved123");
  });

  it("returns null when a /t/ share resolves to a /p/<uuid>/<storyId> STORY (no spotlight)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      url: "https://www.snapchat.com/p/uuid/3137385781778432?chapterid=1",
    });
    expect(await resolveSnapchatShareUrl("https://snapchat.com/t/abc", fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("returns null (fail-open) on a thrown fetch", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("net"));
    expect(await resolveSnapchatShareUrl("https://snapchat.com/t/abc", fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/tests/snapchat.provider.test.ts`
Expected: FAIL — "Cannot find module '../snapchat.provider'".

- [ ] **Step 3: Write the provider**

Create `apps/api/src/services/social-insights/snapchat.provider.ts`:

```typescript
import { extractSnapchatSpotlightId } from "@dashmani/shared";
import type { InsightProvider, InsightTarget, InsightFetchResult, HarvestedContent } from "./types";
import {
  scrapeSnapchatSpotlightEngagement,
  type FetchFn as ScraperFetchFn,
} from "./snapchat-scraper";

// ── Snapchat Spotlight insight provider (public-web scraper — no API/token) ─────
//
// Snapchat has NO usable public API for organic engagement (the Public Profile API
// is allowlist-gated + owned-content-only — see docs/SNAPCHAT-CONNECTION-STEPS.md).
// But a logged-out Googlebot-UA GET of a public /spotlight/<id> page returns real
// engagement in a __NEXT_DATA__ blob — verified live from the Linode IP 2026-07-14.
// This provider scrapes that (snapchat-scraper.ts) for every submitted link that
// resolves to a Spotlight. Links that are ephemeral Stories (or unresolved shares)
// have no scrapeable spotlight id → not_found (honest; surfaced in the coverage note).
//
// NO DARK SWITCH: the scraper needs no token, so isSupported() is always true. The
// only kill switch is SNAP_SCRAPER_ENABLED=0 (matches FB_SCRAPER_ENABLED).
//
// TARGET RESOLUTION: submitted links are `snapchat.com/t/<code>` shares. The cron's
// extractTargetId only succeeds on ALREADY-RESOLVED `/spotlight/<id>` urls. The
// submit path (daily-report.service.ts) resolves /t/ → clean /spotlight/ url via
// resolveSnapchatShareUrl (below) BEFORE storing, so forward links come in keyable;
// the 124-link historical tail is resolved once by scripts/resolve-snapchat-links.ts.

const SCRAPER_UA_TIMEOUT_NOTE = ""; // (timeout lives in the scraper)
const snapScraperEnabled = () => process.env.SNAP_SCRAPER_ENABLED !== "0";
const snapScraperDelayMs = () => Number(process.env.SNAP_SCRAPER_DELAY_MS) || 300;
const snapScraperWallLimit = () => Number(process.env.SNAP_SCRAPER_WALL_LIMIT) || 5;

// Per-run block short-circuit (reset each fetchBatch), mirrors the FB scraper.
let snapScraperBlocked = false;
let snapScraperConsecutiveWalls = 0;

// Injectable scraper fetch (tests pass a stub; real path uses global fetch).
let scraperFetchImpl: ScraperFetchFn | null = null;
export function __setScraperFetchForTesting(fn: ScraperFetchFn | null): void {
  scraperFetchImpl = fn;
}
export function __resetSnapchatStateForTesting(): void {
  snapScraperBlocked = false;
  snapScraperConsecutiveWalls = 0;
  lastHarvest = [];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Captions harvested this run, keyed sc:<id>, for harvestContent(). Reset each run.
let lastHarvest: HarvestedContent[] = [];

export const snapchatProvider: InsightProvider = {
  slug: "snapchat",

  isSupported() {
    return snapScraperEnabled();
  },

  extractTargetId(url: string): string | null {
    // Only a RESOLVED /spotlight/<id> url yields an id. /t/ shares + /p/<uuid>/<story>
    // return null → the cron skips them (share resolution happens at submit time /
    // in the backfill, not here).
    return extractSnapchatSpotlightId(url);
  },

  async fetchBatch(targets: InsightTarget[]): Promise<Map<string, InsightFetchResult>> {
    const results = new Map<string, InsightFetchResult>();
    snapScraperBlocked = false;
    snapScraperConsecutiveWalls = 0;
    lastHarvest = [];

    if (!snapScraperEnabled()) {
      for (const t of targets) results.set(t.linkId, { ok: false, status: "error", error: "SNAP_SCRAPER_ENABLED=0" });
      return results;
    }

    for (const t of targets) {
      if (snapScraperBlocked) {
        results.set(t.linkId, { ok: false, status: "rate_limited", error: "Snapchat scraper blocked this run" });
        continue;
      }
      await sleep(snapScraperDelayMs()); // polite spacing

      const m = scraperFetchImpl
        ? await scrapeSnapchatSpotlightEngagement(t.targetId, scraperFetchImpl)
        : await scrapeSnapchatSpotlightEngagement(t.targetId);

      if (m.walled) {
        snapScraperConsecutiveWalls++;
        if (snapScraperConsecutiveWalls >= snapScraperWallLimit()) {
          snapScraperBlocked = true;
          console.warn(
            `[social-insights/snapchat] scraper hit ${snapScraperConsecutiveWalls} consecutive walls — short-circuiting for the rest of this run`
          );
        }
        results.set(t.linkId, { ok: false, status: "not_found" });
        continue;
      }
      snapScraperConsecutiveWalls = 0;

      // A hit = at least one real signal (metric OR caption). All-null non-walled =
      // a real page with nothing parseable (or a Story with -1 → null) → not_found.
      if (m.views == null && m.comments == null && m.shares == null && m.caption == null) {
        results.set(t.linkId, { ok: false, status: "not_found" });
        continue;
      }

      results.set(t.linkId, {
        ok: true,
        status: "ok",
        views: m.views,
        likes: null, // Snapchat has no public Spotlight like metric.
        comments: m.comments,
        shares: m.shares,
        title: null,
        caption: m.caption,
      });

      // Harvest the caption for Link Search (keyed sc:<spotlightId>).
      if (m.caption) {
        lastHarvest.push({ canonicalKey: `sc:${t.targetId}`, caption: m.caption, title: null });
      }
    }

    return results;
  },

  harvestContent(): HarvestedContent[] {
    return lastHarvest;
  },
};

// ── Submit-time share resolver (mirrors resolveFacebookShareUrl) ───────────────
//
// Does ONE redirect:follow fetch of a `snapchat.com/t/<code>` share link and reads
// the final resolved URL. If it lands on a /spotlight/<id> (a Spotlight), returns a
// CLEAN `https://www.snapchat.com/spotlight/<id>` URL. If it lands on a
// /p/<uuid>/<storyId> STORY (no spotlight id) → returns null (GIVE UP; a Story has
// no public stats). FAIL-OPEN: any throw/timeout → null, caller keeps the original.
const RESOLVE_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const RESOLVE_TIMEOUT_MS = 10_000;

export async function resolveSnapchatShareUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
  externalSignal?: AbortSignal
): Promise<string | null> {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const res = await fetchImpl(url, {
      headers: { "User-Agent": RESOLVE_UA },
      redirect: "follow",
      signal: controller.signal,
    });
    const finalUrl = res.url || "";
    const id = extractSnapchatSpotlightId(finalUrl);
    return id ? `https://www.snapchat.com/spotlight/${id}` : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}
```

> Delete the unused `SCRAPER_UA_TIMEOUT_NOTE` const before committing — it's a leftover marker; do not ship dead code. (Left here only to flag that the timeout lives in the scraper, not the provider.)

- [ ] **Step 4: Remove the dead const**

In `snapchat.provider.ts`, delete the line:

```typescript
const SCRAPER_UA_TIMEOUT_NOTE = ""; // (timeout lives in the scraper)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run apps/api/tests/snapchat.provider.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/social-insights/snapchat.provider.ts apps/api/tests/snapchat.provider.test.ts
git commit -m "feat(api): Snapchat Spotlight insight provider + submit-time share resolver"
```

---

## Task 5: Register provider + flip the platform switch

**Files:**
- Modify: `apps/api/src/services/social-insights/registry.ts:1-26`
- Modify: `packages/shared/src/utils/social-insights.ts:1-4`

- [ ] **Step 1: Add `snapchat` to `SUPPORTED_INSIGHT_PLATFORMS`**

In `packages/shared/src/utils/social-insights.ts`, replace lines 1-4:

```typescript
// Snapchat is deliberately NOT here: it has no server-readable post captions/engagement
// (share-redirect links → client-rendered profile pages; no public organic API). Its
// follower counts + submission-count Top Links work without an insight provider.
export const SUPPORTED_INSIGHT_PLATFORMS = ["youtube", "instagram", "facebook"] as const;
```

with:

```typescript
// Snapchat added 2026-07-14: Spotlight engagement (views/comments/shares) + captions
// are scrapeable token-free from the public /spotlight/<id> page's __NEXT_DATA__ blob
// (snapchat-scraper.ts). Links that are ephemeral Stories have no public stats and
// show as not_found — surfaced honestly in the coverage note. See
// docs/superpowers/plans/2026-07-14-snapchat-spotlight-insights.md.
export const SUPPORTED_INSIGHT_PLATFORMS = ["youtube", "instagram", "facebook", "snapchat"] as const;
```

- [ ] **Step 2: Register the provider (LAST in the sweep order)**

In `apps/api/src/services/social-insights/registry.ts`, update the imports (after line 4) and the `providers` array + the NOTE block (lines 15-26). Replace the block from the `// NOTE: Snapchat has NO insight provider.` comment through the `providers` array with:

```typescript
import { snapchatProvider } from "./snapchat.provider";

// ⚠️ ORDER IS THE 6h-CRON METRIC-SWEEP ORDER (getSupportedSlugs is only consumed by
// social-insights.cron.ts). Priority: cheapest-and-most-reliable FIRST, slowest LAST.
//   1. youtube   — ~2k links, fast Data API.
//   2. facebook  — ~19k links via the public-reel scraper.
//   3. instagram — ~38k links, the slow/rate-limit-prone sweep.
//   4. snapchat  — ~124 links via the public Spotlight scraper. Small + polite
//      (300ms/link), so it's last; its budget can't starve the big providers.
// Do NOT move Instagram before Facebook — that re-starves it (2026-06-26 outage).
const providers: InsightProvider[] = [
  youTubeProvider,
  facebookProvider,
  instagramProvider,
  snapchatProvider,
];
```

(The `import { snapchatProvider }` line must go at the top with the other provider imports — move it up next to line 4 `import { facebookProvider } ...` rather than mid-file. Place it there.)

- [ ] **Step 3: Add the barrel export**

`apps/api/src/services/social-insights/index.ts` re-exports each provider (it has `export { youTubeProvider } from "./youtube.provider";`). Add, following that pattern:

```typescript
export { snapchatProvider } from "./snapchat.provider";
```

- [ ] **Step 4: Typecheck + run the provider/registry-adjacent tests**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: no errors.

Run: `npx vitest run apps/api/src/services/social-insights`
Expected: PASS — all provider tests green (youtube/instagram/facebook/snapchat).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/social-insights/registry.ts packages/shared/src/utils/social-insights.ts apps/api/src/services/social-insights/index.ts
git commit -m "feat: register Snapchat provider + add snapchat to SUPPORTED_INSIGHT_PLATFORMS"
```

---

## Task 6: Submit-time resolution of Snapchat /t/ links

**Files:**
- Modify: `apps/api/src/services/daily-report.service.ts:29` (regex), `:35-45` (resolver seam), `:51-102` (`resolveOpaqueShareLinks`)
- Test: extend the existing daily-report test file (find it: `apps/api/tests/daily-report.test.ts`)

The existing `resolveOpaqueShareLinks` only handles `facebook.com/share/`. Extend it to ALSO resolve `snapchat.com/t/` links via `resolveSnapchatShareUrl`. Both are fail-open, additive, outside the transaction — the exact same contract.

- [ ] **Step 1: Write the failing test (append to the daily-report test file)**

The tests live in `apps/api/tests/daily-report.test.ts` (repo convention: ALL API + shared tests are flat under `apps/api/tests/`, imported via `../src/...` or `@dashmani/shared` — NOT a `src/__tests__/` tree). Append a describe block. The existing file already imports `__setShareResolverForTesting` from `../src/services/daily-report.service`; add the Snapchat seam import (created in Step 3):

```typescript
import { __setSnapchatResolverForTesting } from "../src/services/daily-report.service";

describe("submit-time Snapchat /t/ resolution", () => {
  afterEach(() => {
    __setSnapchatResolverForTesting(null); // restore default
  });

  it("replaces a snapchat.com/t/ share with its resolved clean /spotlight/ url", async () => {
    __setSnapchatResolverForTesting(async () => "https://www.snapchat.com/spotlight/W7_resolved123");
    // Use the same harness the FB /share/ resolution test uses to submit a report with
    // a single snapchat.com/t/abc link, then assert the stored url is the clean one.
    // (Mirror the existing FB test's arrange/act/assert exactly — same submitDailyReport
    // call, same employee/report fixtures.)
    // EXPECT: the persisted link url === "https://www.snapchat.com/spotlight/W7_resolved123"
  });

  it("keeps the original /t/ url when it resolves to a Story (resolver returns null)", async () => {
    __setSnapchatResolverForTesting(async () => null);
    // EXPECT: the persisted link url === the original "https://snapchat.com/t/abc"
  });
});
```

> **For the implementer:** open the existing FB `/share/` resolution test in this file and copy its exact submit harness (fixtures, `submitDailyReport` call, how it reads back the stored link) into the two cases above — do not invent a new harness. The assertions are the only new part.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/tests/daily-report.test.ts` (adjust path to the real file)
Expected: FAIL — `__setSnapchatResolverForTesting` not exported.

- [ ] **Step 3: Add the Snapchat resolver seam + extend the resolve pass**

In `apps/api/src/services/daily-report.service.ts`:

(a) Add the import near the top (next to the existing `resolveFacebookShareUrl` import on line 6):

```typescript
import { resolveSnapchatShareUrl } from "./social-insights/snapchat.provider";
```

(b) Change the regex on line 29 from a single FB pattern to a matcher that recognizes BOTH opaque forms. Replace line 29:

```typescript
const SHARE_URL_RE = /facebook\.com\/share\//i;
```

with:

```typescript
const FB_SHARE_URL_RE = /facebook\.com\/share\//i;
const SNAP_SHARE_URL_RE = /snapchat\.com\/t\//i;
```

(c) Add the Snapchat resolver seam next to the FB one (after line 45):

```typescript
// Snapchat /t/ share resolver — same fail-open contract as the FB one. Resolves a
// share redirect to a clean /spotlight/<id> url (or null for a Story). Injectable.
type SnapResolver = (url: string, signal?: AbortSignal) => Promise<string | null>;
const defaultSnapResolver: SnapResolver = (url, signal) =>
  resolveSnapchatShareUrl(url, fetch, signal);
let resolveSnapUrlImpl: SnapResolver = defaultSnapResolver;
export function __setSnapchatResolverForTesting(fn: SnapResolver | null): void {
  resolveSnapUrlImpl = fn ?? defaultSnapResolver;
}
```

(d) In `resolveOpaqueShareLinks`, extend the target-collection loop and the resolution to handle both platforms. **Match by CONTENT, not line number** (the line numbers below are approximate and the file drifts): replace the contiguous span that begins at the comment `// Index only the de-dupable opaque /share/ links; cap how many we resolve.` and ends at the closing `}` of the `for (const settled of outcome) { ... }` loop (i.e. everything from that comment through `return links;` just after the settled-loop, but NOT the outer `try`/`catch`/`finally`). Read the current function first to confirm the exact boundaries. Replace that span with:

```typescript
    // Index every de-dupable opaque link (FB /share/ OR Snapchat /t/); cap the count.
    const targets: Array<{ idx: number; url: string; kind: "fb" | "snap" }> = [];
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      if (l.isScheduled || !l.url || !l.url.trim()) continue;
      if (targets.length >= MAX_OPAQUE_RESOLVES_PER_SUBMIT) break;
      if (FB_SHARE_URL_RE.test(l.url)) targets.push({ idx: i, url: l.url.trim(), kind: "fb" });
      else if (SNAP_SHARE_URL_RE.test(l.url)) targets.push({ idx: i, url: l.url.trim(), kind: "snap" });
    }
    if (targets.length === 0) return links;

    const deadline = new Promise<"timeout">((resolve) => {
      budgetTimer = setTimeout(() => {
        batchController.abort();
        resolve("timeout");
      }, OPAQUE_RESOLVE_BUDGET_MS);
    });
    const work = Promise.allSettled(
      targets.map((t) => {
        const resolver = t.kind === "fb" ? resolveShareUrlImpl : resolveSnapUrlImpl;
        return resolver(t.url, batchController.signal).then((clean) => ({ idx: t.idx, clean }));
      }),
    );
    const outcome = await Promise.race([work, deadline]);
    if (outcome === "timeout") return links;

    for (const settled of outcome) {
      if (settled.status === "fulfilled" && settled.value.clean) {
        links[settled.value.idx] = { ...links[settled.value.idx], url: settled.value.clean };
      }
    }
    return links;
```

- [ ] **Step 4: Fill in the two test-case bodies**

Now write the actual arrange/act/assert in the two cases from Step 1, copying the existing FB `/share/` test harness. Run:

Run: `npx vitest run apps/api/tests/daily-report.test.ts`
Expected: PASS — both Snapchat cases + all existing FB/dedupe/Anish canary tests still green.

- [ ] **Step 5: Run the full daily-report suite (regression guard)**

Run: `npx vitest run apps/api/tests/daily-report.test.ts`
Expected: PASS — the load-bearing dedupe / cross-day / Anish-scenario tests are untouched (we only added a second opaque-link kind to the pre-transaction resolve pass).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/daily-report.service.ts apps/api/tests/daily-report.test.ts
git commit -m "feat(api): resolve snapchat.com/t/ shares to clean Spotlight urls at submit time"
```

---

## Task 7: One-time backfill script for the 124 existing /t/ links

**Files:**
- Create: `scripts/resolve-snapchat-links.ts`

Mirrors `scripts/resolve-opaque-fb-links.ts`: dry-run by default, `--apply --confirm-prod` to write, polite concurrency, non-destructive (only updates `url`), idempotent.

- [ ] **Step 1: Write the script**

Create `scripts/resolve-snapchat-links.ts`:

```typescript
// One-time backfill: resolve historical `snapchat.com/t/<code>` share links in
// report_links to their clean `https://www.snapchat.com/spotlight/<id>` form when —
// and only when — they redirect to a Spotlight. Links that resolve to ephemeral
// Stories (/p/<uuid>/<storyId>) are LEFT UNTOUCHED (no spotlight id → no stats;
// resolver returns null). Non-destructive: only ever UPDATES `url`, never deletes.
//
// Dry-run by default. Pass --apply --confirm-prod to write. Idempotent: re-selects
// only the shrinking set of remaining /t/ links each run.
//
// Run from packages/db (so @dashmani/db loads packages/db/.env):
//   cd packages/db && npx tsx ../../scripts/resolve-snapchat-links.ts            # dry run
//   cd packages/db && npx tsx ../../scripts/resolve-snapchat-links.ts --apply --confirm-prod

import { prisma } from "@dashmani/db";
import { resolveSnapchatShareUrl } from "../apps/api/src/services/social-insights/snapchat.provider";

const APPLY = process.argv.includes("--apply");
const CONFIRM_PROD = process.argv.includes("--confirm-prod");
const CONCURRENCY = 3;
const DELAY_MS = 300;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  if (APPLY && !CONFIRM_PROD) {
    console.error("Refusing to write without --confirm-prod. Add it to apply.");
    process.exit(1);
  }

  const rows = await prisma.reportLink.findMany({
    where: { url: { contains: "snapchat.com/t/", mode: "insensitive" } },
    select: { id: true, url: true },
  });
  console.log(`Found ${rows.length} snapchat.com/t/ links.`);

  let resolvedSpotlight = 0;
  let story = 0;
  let updated = 0;

  // Simple concurrency pool.
  let idx = 0;
  async function worker() {
    while (idx < rows.length) {
      const row = rows[idx++];
      if (!row.url) continue;
      await sleep(DELAY_MS);
      let clean: string | null = null;
      try {
        clean = await resolveSnapchatShareUrl(row.url);
      } catch {
        clean = null;
      }
      if (clean) {
        resolvedSpotlight++;
        console.log(`  [spotlight] ${row.url} -> ${clean}`);
        if (APPLY) {
          try {
            await prisma.reportLink.update({ where: { id: row.id }, data: { url: clean } });
            updated++;
          } catch (e) {
            console.error(`    update failed for ${row.id}:`, e);
          }
        }
      } else {
        story++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(
    `\nResolved to Spotlight: ${resolvedSpotlight} | Story/unresolvable (left as-is): ${story}`
  );
  console.log(APPLY ? `Applied ${updated} url updates.` : `DRY RUN — no writes. Re-run with --apply --confirm-prod.`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck the script**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json` (the script imports from apps/api; if the script isn't in that tsconfig's include, verify it compiles standalone with `npx tsx --check scripts/resolve-snapchat-links.ts` or a local `tsc` — at minimum ensure the import path resolves).
Expected: no errors.

- [ ] **Step 3: Commit (do NOT run against prod yet — that's the deploy step)**

```bash
git add scripts/resolve-snapchat-links.ts
git commit -m "feat(scripts): one-time backfill to resolve snapchat /t/ shares to Spotlight urls"
```

---

## Task 8: Top Links UI — add the Snapchat panel

**Files:**
- Modify: `apps/internal/src/app/reports/page.tsx` — color tokens (`:15-28`), the `useTopLinks` calls (`:310-312`), the `PLATFORMS` list (`:588-630`).

The backend needs NO change: `getTopLinksByPlatform` keys purely on `link_metrics.platform === "snapchat"` + `status: "ok"`, and defaults non-YouTube platforms to `sortBy: "engagement"`. Once the cron writes `snapchat` metric rows, the panel populates automatically.

- [ ] **Step 1: Add Snapchat color tokens**

In `apps/internal/src/app/reports/page.tsx`, add a `snapchat` entry to the two color maps. After the `youtube` line in the first map (~line 19) add:

```typescript
  snapchat: "bg-yellow-100 text-yellow-800",
```

After the `facebook` line in the second (panel-style) map (~line 28) add:

```typescript
  snapchat:  { bg: "from-yellow-50 to-amber-50",  labelColor: "text-yellow-700", labelBg: "bg-yellow-100",  bar: "bg-yellow-400", border: "border-yellow-100" },
```

- [ ] **Step 2: Add the `useTopLinks("snapchat", …)` hook call**

After line 312 (`const { data: topFacebookData, ... } = useTopLinks("facebook", ...)`), add:

```typescript
  const { data: topSnapchatData, isLoading: topSnapchatLoading } = useTopLinks("snapchat", topWindowStart, topWindowEnd, 20);
```

- [ ] **Step 3: Add Snapchat to the `PLATFORMS` render list**

In the `PLATFORMS` array (~lines 588-630), after the `facebook` entry add a `snapchat` entry mirroring its shape. Use the exact field names the other entries use (verify against the file — the shape is `{ key, label, data, loading, showViews, ... }`):

```typescript
          {
            key: "snapchat" as const,
            label: "Snapchat",
            data: topSnapchatData?.data ?? [],
            loading: topSnapchatLoading,
            showViews: true, // Spotlight exposes views (comments+shares too; no likes)
          },
```

> ⚠️ Snapchat has **no likes** — ensure the panel's likes column renders `—`/hidden for a null value (the unified InsightBadge already renders "views if present + likes + comments"; a null likes shows nothing, which is correct). Do NOT add a fake likes value.

- [ ] **Step 4: Adjust the render filter if it hardcodes platforms**

Line ~630 has `const willRender = PLATFORMS.filter((p) => p.key === "facebook" || p.loading || p.data.length > 0);` — this keeps Facebook always visible. Snapchat should follow the DEFAULT rule (show only when it has data or is loading), so **do not** add `snapchat` to the always-visible clause. Leave the filter as-is; the new entry renders only when it has data. Verify this reads correctly after adding the entry.

- [ ] **Step 5: Typecheck + build the internal app**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

Run: `npm run build -w @dashmani/internal`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/internal/src/app/reports/page.tsx
git commit -m "feat(internal): add Top Snapchat Spotlights panel (views/comments/shares)"
```

---

## Task 9: Link Search — Snapchat coverage + caption search + honest Story note

**Files:**
- Modify: `apps/api/src/services/link-content.service.ts` — `platformFromCanonicalKey` (add `sc:` → `snapchat`).
- Modify: `apps/api/src/services/link-search.service.ts` — `idPartFor` (add `sc:` branch) + the THREE SQL `submitted_keys` CTEs + the `submittedByPlatform` CASE (add snapchat).
- Modify: `apps/internal/src/app/reports/link-search/page.tsx` — coverage `ORDER` + `LABEL` + the honest Story note.

Snapchat captions now land in `link_content` (via the provider's `harvestContent`, keyed `sc:<id>`). For them to be caption-searchable AND counted in coverage, four hardcoded `yt:/ig:/fb:` spots must learn `sc:`/snapchat.

- [ ] **Step 1: `platformFromCanonicalKey` — add `sc:` → `snapchat`**

In `apps/api/src/services/link-content.service.ts`, find `platformFromCanonicalKey` (it maps `yt:`→youtube, `ig:`→instagram, `fb:`→facebook, else `other`). Add the `sc:` case. Match the existing style; if it's an if-chain:

```typescript
  if (canonicalKeyValue.startsWith("sc:")) return "snapchat";
```

(Place it alongside the `fb:` line, before the `other` fallback.) This stamps `link_content.platform = "snapchat"` on Snapchat captions so they bucket correctly in coverage.

- [ ] **Step 2: `idPartFor` — add the `sc:` branch**

In `apps/api/src/services/link-search.service.ts`, replace the comment line at ~line 95 (`// (No sc: branch — Snapchat isn't canonicalized...`) inside `idPartFor`. The current function:

```typescript
function idPartFor(canonicalKeyValue: string): { contains?: string; equalsUrl?: string } {
  if (canonicalKeyValue.startsWith("yt:")) return { contains: canonicalKeyValue.slice(3) };
  if (canonicalKeyValue.startsWith("ig:")) return { contains: `/${canonicalKeyValue.slice(3)}` };
  if (canonicalKeyValue.startsWith("fb:")) return { contains: canonicalKeyValue.slice(3) };
  // (No sc: branch — Snapchat isn't canonicalized; canonicalKey() never emits an sc: key.)
  // Full-URL fallback key (already lowercased). Match the url exactly, case-insensitive.
  return { equalsUrl: canonicalKeyValue };
}
```

Change the `sc:` comment line to a real branch:

```typescript
function idPartFor(canonicalKeyValue: string): { contains?: string; equalsUrl?: string } {
  if (canonicalKeyValue.startsWith("yt:")) return { contains: canonicalKeyValue.slice(3) };
  if (canonicalKeyValue.startsWith("ig:")) return { contains: `/${canonicalKeyValue.slice(3)}` };
  if (canonicalKeyValue.startsWith("fb:")) return { contains: canonicalKeyValue.slice(3) };
  // Snapchat spotlight id lives in a /spotlight/<id> url path segment.
  if (canonicalKeyValue.startsWith("sc:")) return { contains: `/spotlight/${canonicalKeyValue.slice(3)}` };
  // Full-URL fallback key (already lowercased). Match the url exactly, case-insensitive.
  return { equalsUrl: canonicalKeyValue };
}
```

- [ ] **Step 3: Add the Snapchat branch to all THREE `submitted_keys` SQL CTEs**

In `apps/api/src/services/link-search.service.ts`, there are TWO `$queryRaw` blocks with an identical `submitted_keys` CTE (the `searchableByPlatform` query and the `pendingMatchedByPlatform` query). In EACH, add a snapchat `WHEN` clause after the facebook one, before `ELSE NULL`:

```sql
          WHEN url ~* 'snapchat\.com/spotlight/'
            THEN 'sc:' || substring(url from 'snapchat\.com/spotlight/([A-Za-z0-9_-]{8,})')
```

So each CTE's CASE reads (facebook line shown for placement):

```sql
          WHEN url ~* 'facebook\.com/reel/[0-9]'
            THEN 'fb:' || substring(url from 'facebook\.com/reel/([0-9]+)')
          WHEN url ~* 'snapchat\.com/spotlight/'
            THEN 'sc:' || substring(url from 'snapchat\.com/spotlight/([A-Za-z0-9_-]{8,})')
          ELSE NULL
```

- [ ] **Step 4: Add snapchat to the `submittedByPlatform` denominator CASE**

In the same file, the `submittedByPlatform` `$queryRaw` has a host→platform CASE. Add a snapchat clause before the `ELSE`:

```sql
        WHEN rl.url ~* 'facebook\.com|fb\.watch|fb\.me' THEN 'facebook'
        WHEN rl.url ~* 'snapchat\.com' THEN 'snapchat'
        ELSE lower(coalesce(rl.platform, 'other'))
```

This makes the Snapchat submitted-denominator (124) bucket as `snapchat`, matching the `searchable` numerator now keyed `sc:`. Without it, Snapchat submitted links fall in `other` and coverage shows a nonsense split.

- [ ] **Step 5: Add `snapchat` to the coverage UI ORDER + LABEL + Story note**

In `apps/internal/src/app/reports/link-search/page.tsx`, find `const ORDER = ["youtube","instagram","facebook"]` (~line 231) and its `LABEL` map. Add snapchat:

```typescript
const ORDER = ["youtube", "instagram", "facebook", "snapchat"];
```

Add to the `LABEL` map (match its shape, e.g. `{ youtube: "YouTube", ... }`):

```typescript
  snapchat: "Snapchat",
```

Then, where each coverage row renders its per-platform note (the existing IG/FB "since <date>" notes), add a Snapchat-only honest note. Read the surrounding row-render JSX and slot this in with the file's actual platform-key variable (shown here as `key`):

```tsx
{key === "snapchat" && (
  <span className="text-xs text-ink/50">
    {" "}· Only Spotlights expose engagement; ephemeral Stories have no public stats, so they can't be searched or ranked.
  </span>
)}
```

> The comment at lines 228-230 currently says Snapchat is intentionally excluded — update/remove it so it no longer contradicts the new `snapchat` entry.

- [ ] **Step 6: Typecheck both apps**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/link-content.service.ts apps/api/src/services/link-search.service.ts apps/internal/src/app/reports/link-search/page.tsx
git commit -m "feat: Snapchat Link Search coverage + caption search + honest Story note"
```

---

## Task 10: Per-platform leaderboard — backend (Snapchat, ranked by views)

**Files:**
- Modify: `apps/api/src/services/leaderboard.service.ts` — `platformOfUrl` (:70), the two Map type signatures (:84, :98), `PlatformBoardKey` (:412), `getPlatformLeaderboards` return (:449-453).
- Test: `apps/api/tests/leaderboard.test.ts` (create if absent; else append).

This is the leaderboard the product owner specifically asked about. Snapchat exposes views + comments + shares but **no likes** → rank it by **views**, exactly like YouTube and Facebook (Instagram is the odd one out, ranked by likes+comments because it has no views).

- [ ] **Step 1: Write the failing test**

Create/append `apps/api/tests/leaderboard.test.ts`. If the file exists, add this describe block; if creating it, include the prisma mock the sibling tests use (check `apps/api/tests/` for the existing mock setup pattern and copy it):

```typescript
import { describe, it, expect } from "vitest";
import { getPlatformLeaderboards } from "../src/services/leaderboard.service";

// This test asserts the SHAPE contract: getPlatformLeaderboards returns a snapchat
// board key. (If the suite uses a seeded/mock prisma, seed one snapchat link_metric
// row with views > 0 for an employee and assert that employee ranks on the snapchat
// board. Follow the existing youtube/facebook assertions in this suite as the model.)
describe("getPlatformLeaderboards — snapchat board", () => {
  it("returns a `snapchat` key in the result object", async () => {
    const boards = await getPlatformLeaderboards();
    expect(boards).toHaveProperty("snapchat");
    expect(Array.isArray(boards.snapchat)).toBe(true);
  });
});
```

> If there is NO existing leaderboard test + prisma-mock harness, keep this minimal shape test (it still fails on the missing `snapchat` key until the code is added) and note in the commit that a data-level test is deferred to the existing suite's harness. Do not build a new prisma-mock harness from scratch for this — the shape test is sufficient to lock the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/tests/leaderboard.test.ts`
Expected: FAIL — `boards` has no `snapchat` property.

- [ ] **Step 3: Add snapchat to `platformOfUrl`**

In `apps/api/src/services/leaderboard.service.ts`, replace lines 70-75:

```typescript
function platformOfUrl(url: string): "youtube" | "instagram" | "facebook" | null {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/facebook\.com|fb\.watch|fb\.me/i.test(url)) return "facebook";
  return null;
}
```

with:

```typescript
function platformOfUrl(url: string): "youtube" | "instagram" | "facebook" | "snapchat" | null {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/facebook\.com|fb\.watch|fb\.me/i.test(url)) return "facebook";
  if (/snapchat\.com/i.test(url)) return "snapchat";
  return null;
}
```

- [ ] **Step 4: Widen the two Map type signatures**

In the same file, update the return type at line 84 and the local at line 98 from:

```typescript
): Promise<Map<string, Map<"youtube" | "instagram" | "facebook", EngagementAgg>>> {
```
```typescript
  const byEmp = new Map<string, Map<"youtube" | "instagram" | "facebook", EngagementAgg>>();
```

to (add `| "snapchat"` in both):

```typescript
): Promise<Map<string, Map<"youtube" | "instagram" | "facebook" | "snapchat", EngagementAgg>>> {
```
```typescript
  const byEmp = new Map<string, Map<"youtube" | "instagram" | "facebook" | "snapchat", EngagementAgg>>();
```

- [ ] **Step 5: Add snapchat to `PlatformBoardKey` + the return object**

Update line 412:

```typescript
export type PlatformBoardKey = "youtube" | "facebook" | "instagram" | "snapchat";
```

Update the `getPlatformLeaderboards` return (lines 449-453) from:

```typescript
  return {
    youtube: build("youtube", (a) => a.views),
    facebook: build("facebook", (a) => a.views),
    instagram: build("instagram", (a) => a.likes + a.comments), // IG has no views
  };
```

to (Snapchat ranked by views, like YT/FB):

```typescript
  return {
    youtube: build("youtube", (a) => a.views),
    facebook: build("facebook", (a) => a.views),
    instagram: build("instagram", (a) => a.likes + a.comments), // IG has no views
    snapchat: build("snapchat", (a) => a.views), // Snapchat has views (no likes) — rank by views
  };
```

- [ ] **Step 6: Update the header comment block (accuracy)**

The comment at lines 406-409 lists only 3 platforms' ranking rules. Add a snapchat line after the facebook one so the doc matches the code:

```typescript
//   - snapchat → ranked by VIEWS (Spotlight exposes views + comments + shares; NO likes)
```

Also update line 17-21's "IG/FB … not counted" note if it names a fixed platform set — ensure it no longer implies Snapchat is excluded (Snapchat now has a board).

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run apps/api/tests/leaderboard.test.ts`
Expected: PASS — `boards.snapchat` exists.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: no errors (the widened unions propagate cleanly through `build`/`getEngagementByEmployeePlatform`).

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/leaderboard.service.ts apps/api/tests/leaderboard.test.ts
git commit -m "feat(api): add Snapchat per-platform leaderboard (ranked by views)"
```

---

## Task 11: Per-platform leaderboard — internal UI

**Files:**
- Modify: `apps/internal/src/app/reports/leaderboard/page.tsx:470-473` (the per-platform boards render array).

The frontend reads `platBoards[key]` from `/admin/reports/platform-leaderboards` (which Task 10 now returns a `snapchat` key for). Add a `snapchat` board card.

- [ ] **Step 1: Add the snapchat board entry**

In `apps/internal/src/app/reports/leaderboard/page.tsx`, find the per-platform boards array (~lines 470-473):

```typescript
        { key: "youtube", label: "YouTube", rankBy: "Views", showViews: true },
        { key: "facebook", label: "Facebook", rankBy: "Views", showViews: true },
        { key: "instagram", label: "Instagram", rankBy: "Likes + Comments", showViews: false },
```

Add a snapchat entry after facebook (ranked by Views, shows the Views column; Snapchat has no likes so the board's likes context column will render 0/blank — that's correct and honest):

```typescript
        { key: "youtube", label: "YouTube", rankBy: "Views", showViews: true },
        { key: "facebook", label: "Facebook", rankBy: "Views", showViews: true },
        { key: "instagram", label: "Instagram", rankBy: "Likes + Comments", showViews: false },
        { key: "snapchat", label: "Snapchat", rankBy: "Views", showViews: true },
```

> The board renders `board.length === 0` empty-state automatically (line ~485), so if Snapchat has no ranked employees yet the card shows the same "no data" state the others do — consistent, not broken. Verify the empty-state branch is keyed off the generic `board` variable (it is) and needs no per-platform change.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

Run: `npm run build -w @dashmani/internal`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/internal/src/app/reports/leaderboard/page.tsx
git commit -m "feat(internal): add Snapchat per-platform leaderboard board (by views)"
```

---

## Task 12: Dashboard tiles + content-analytics color

**Files:**
- Modify: `apps/internal/src/app/dashboard/page.tsx` — `PERF_METRICS` (:143), the perf-metric `if` branch (:177), `TOP_LINK_PLATFORMS` (:203).
- Modify: `apps/internal/src/app/analytics/content/page.tsx:21` — `PLATFORM_COLORS`.

The internal dashboard has a per-platform performance tab set and a Top Links pill row, both hardcoded to 3 platforms. Add Snapchat so the dashboard matches `/reports`.

- [ ] **Step 1: Read the exact shapes**

Run: `sed -n '140,210p' apps/internal/src/app/dashboard/page.tsx`

Note the exact object shape of `PERF_METRICS` entries and `TOP_LINK_PLATFORMS` entries (field names like `key`, `label`, `metric`, `Icon`, colors) and the `if (perfMetric === "youtube" || ...)` condition.

- [ ] **Step 2: Add snapchat to `PERF_METRICS`**

Add a `snapchat` entry to `PERF_METRICS` (~line 143) mirroring the `facebook` entry's shape exactly (same fields), with `key: "snapchat"`, `label: "Snapchat"`, and its metric set to `"views"` (Snapchat is ranked/summarized by views). Use the Snapchat brand color already used elsewhere (`bg-yellow-*`/`text-yellow-*`, matching Task 8's tokens).

- [ ] **Step 3: Add snapchat to the perf-metric branch**

At line ~177, the condition `if (perfMetric === "youtube" || perfMetric === "facebook" || perfMetric === "instagram")` gates per-platform rendering. Add `|| perfMetric === "snapchat"`:

```typescript
      if (perfMetric === "youtube" || perfMetric === "facebook" || perfMetric === "instagram" || perfMetric === "snapchat") {
```

(Match the exact existing expression — if it's a different shape like an array `.includes`, add `"snapchat"` to that array instead.)

- [ ] **Step 4: Add snapchat to `TOP_LINK_PLATFORMS`**

Add a `snapchat` entry to `TOP_LINK_PLATFORMS` (~line 203) mirroring the `facebook` entry, `metric` set to the views/engagement field the others use for FB.

- [ ] **Step 5: Add snapchat to content-analytics `PLATFORM_COLORS`**

In `apps/internal/src/app/analytics/content/page.tsx` (~line 21), add to the `PLATFORM_COLORS` map (match its shape and the yellow Snapchat tokens):

```typescript
  Snapchat: "bg-yellow-400",
```

> Check the map's KEY casing — if the other keys are Title-case (`Instagram`, `Facebook`), use `Snapchat`; if lowercase, use `snapchat`. Match exactly (the lookup uses `PLATFORM_COLORS[p]` where `p` comes from `content.byPlatform`). This is cosmetic (it already falls back to grey), but adds the brand color for consistency.

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

Run: `npm run build -w @dashmani/internal`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/internal/src/app/dashboard/page.tsx apps/internal/src/app/analytics/content/page.tsx
git commit -m "feat(internal): add Snapchat to dashboard perf tabs, Top Links pills, content colors"
```

---

## Task 13: HR `/report` insights-panel subtitle (the one non-dynamic HR string)

**Files:**
- Modify: `apps/hr/src/app/report/page.tsx` — the "Your link insights" panel subtitle (~line 1294) + the stale comment (~line 1279).

The panel's *rendering* is dynamic (it filters `l.latest` across all platforms and uses the dynamic `InsightBadge`), so Snapchat rows appear automatically. But the panel's **subtitle is a hardcoded string** naming only "YouTube, Instagram and Facebook" — a Snapchat creator would see their Spotlight stats under copy that says Snapchat isn't covered. This is the single gap that reaches a user. Found by adversarial review; make this ONE string dynamic (do not otherwise touch this file).

- [ ] **Step 1: Fix the subtitle string**

In `apps/hr/src/app/report/page.tsx`, find the panel subtitle (~line 1294):

```tsx
                <p className="text-[11px] text-[#7A7A7A] mt-0.5">
                  Views, likes &amp; comments for your YouTube, Instagram and Facebook links.
                </p>
```

Replace it with platform-agnostic copy that's also **accurate about Snapchat having no likes** (it exposes views + comments + shares, not likes):

```tsx
                <p className="text-[11px] text-[#7A7A7A] mt-0.5">
                  Engagement for your links across every supported platform.
                </p>
```

> Rationale for the wording: the old string enumerated platforms (now wrong for Snapchat) AND said "likes" (Snapchat has none). "Engagement … across every supported platform" is true for all four and needs no edit when a fifth is added later. Do NOT list platform names here — that's what made it stale.

- [ ] **Step 2: Fix the stale comment (same block, ~line 1279)**

Replace the comment:

```tsx
        // Show every link that has engagement metrics, across ALL supported
        // platforms (YouTube + Instagram + Facebook are all covered now).
```

with:

```tsx
        // Show every link that has engagement metrics, across ALL supported
        // platforms (YouTube, Instagram, Facebook, Snapchat — driven by
        // SUPPORTED_INSIGHT_PLATFORMS, so this list never needs manual edits).
```

- [ ] **Step 3: Typecheck + build the HR app**

Run: `npx tsc --noEmit -p apps/hr/tsconfig.json`
Expected: no errors.

Run: `npm run build -w @dashmani/hr`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/hr/src/app/report/page.tsx
git commit -m "fix(hr): make /report insights-panel subtitle platform-agnostic (covers Snapchat)"
```

---

## Task 14: Full verification + build gate

**Files:** none (verification only).

- [ ] **Step 1: Run the entire API test suite**

Run: `npm run test -w @dashmani/api`
Expected: PASS — all new Snapchat tests + all existing suites. (Note: the repo has ~36 pre-existing unrelated API test failures per memory `project_reports_extract_spreadsheet` — confirm the count is unchanged and NONE of the new failures are Snapchat/daily-report/canonical-url. If a previously-green suite newly fails, fix before proceeding.)

- [ ] **Step 2: Run the shared test suite**

Run: `npx vitest run packages/shared`
Expected: PASS — snapchat extractor + canonicalKey sc: branch + all existing IG/YT/FB tests.

- [ ] **Step 3: Full monorepo build (auth pages import shared; catch cross-app breakage)**

Run: `npm run build`
Expected: all apps build. (Do NOT run this while `npm run dev` servers are up — it poisons `.next` cache; see CLAUDE.md.)

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "chore: verification fixups for Snapchat insights" --allow-empty
```

---

## Task 15: Deploy + LIVE prod verification (the mandatory final gate)

**Files:** none (ops). This codebase's iron rule: a Graph/scraper/cron change is NOT done until verified LIVE on prod — build + tests green is not enough.

- [ ] **Step 1: Merge to main (triggers auto-deploy)**

Open a PR, get review, merge to `main`. GitHub Actions deploys in ~3 min. No `db:push` needed (no schema change — `link_metrics`/`link_content` already exist).

- [ ] **Step 2: Verify the API is up**

Run: `curl -s https://api.digitalsukoon.com/v1/health`
Expected: `{"success":true,...}`

- [ ] **Step 3: Run the backfill on prod (dry run FIRST)**

```bash
ssh linode
cd /opt/dashmani-platform/packages/db
npx tsx ../../scripts/resolve-snapchat-links.ts            # DRY RUN — read the spotlight/story split
```
Expected: prints "Found 124 …", a "[spotlight] …" line per resolvable link, and a final "Resolved to Spotlight: N | Story…: M" summary. Sanity-check N is roughly a third (matches the 3/8 probe).

- [ ] **Step 4: Apply the backfill**

```bash
npx tsx ../../scripts/resolve-snapchat-links.ts --apply --confirm-prod
```
Expected: "Applied N url updates."

- [ ] **Step 5: Trigger an insights refresh + watch the Snapchat summary**

The manual refresh runs harvest-only, so to exercise the metric sweep either wait for the 6h cron or (better) tail the logs after the next scheduled run. To force a full run, restart the API (the cron fires on boot per `index.ts`) OR wait for the schedule. Then:

```bash
ssh linode "pm2 logs api --lines 200 --nostream | grep -i snapchat"
```
Expected: a line like `[social-insights/snapchat] N links → N polled, X ok, Y not_found, 0 errors` with X > 0, and `harvested Z/Z feed-map captions`.

- [ ] **Step 6: Verify a real Snapchat metric row landed**

```bash
ssh linode "cd /opt/dashmani-platform && sudo -u postgres psql -d dashmani_prod -c \"SELECT platform, status, views, comments, shares, left(url,60) FROM link_metrics WHERE platform='snapchat' AND status='ok' ORDER BY created_at DESC LIMIT 5;\""
```
Expected: rows with real `views`/`comments`/`shares` and a `/spotlight/` url. If all rows are `not_found`, re-check the backfill actually rewrote urls to `/spotlight/` (Step 3-4) — the cron's `extractTargetId` needs the resolved form.

- [ ] **Step 7: Verify Snapchat appears on EVERY surface (full parity check)**

Logged in as admin on `https://portal.digitalsukoon.com`, confirm Snapchat now shows everywhere IG/FB do:
  1. `/reports` — a **"Snapchat" Top Links panel** appears with view counts (+ comments/shares; no likes column, or a blank one).
  2. `/reports/leaderboard` — a **"Snapchat Leaderboard"** per-platform board appears (ranked by Views), alongside YouTube/Facebook/Instagram.
  3. `/dashboard` — the **performance tab set** includes a Snapchat option, and the **Top Links pills** include Snapchat.
  4. `/reports/link-search` — the coverage banner lists a **Snapchat** row with the honest Story note, and searching a person's name returns Snapchat Spotlight posts (once captions are extracted — may lag a few hours per the extraction cron).
  5. `/analytics/content` — Snapchat renders with its brand color (not grey) if there's Snapchat content.
  6. Spot-check the **InsightBadge** on a Snapchat link in `/reports` or the HR `/report` panel — it shows real views/comments/shares, NOT "Insights soon" (confirms `SUPPORTED_INSIGHT_PLATFORMS` took effect).

  7. HR `/report` "Your link insights" panel — the subtitle reads "across every supported platform" (NOT "YouTube, Instagram and Facebook") — confirms Task 13.

If any surface is missing Snapchat, the corresponding Task (8/9/10/11/12/13) didn't land — fix before declaring done.

- [ ] **Step 8: Update the CLAUDE.md + memory with the shipped state**

Add a bullet to CLAUDE.md's insights section documenting the Snapchat Spotlight scraper (mirroring the FB scraper bullet), and update memory `project_snapchat_spotlight_scraper_viable` from "planned" to "SHIPPED (PR #NN, prod <sha>)" with the live-verified spotlight/story split count.

```bash
git add CLAUDE.md && git commit -m "docs: document shipped Snapchat Spotlight insights"
```

---

## Self-Review notes (for the implementer)

- **Likes:** Snapchat exposes NO like metric for Spotlight. `likes` is null everywhere by design — never fabricate. Two ranking paths, both correct with null likes: (1) the **Top Links panel** uses `getTopLinksByPlatform`, which sorts non-YouTube by `engagement` (views+likes+comments) — with likes null, Snapchat sorts by views+comments. (2) the **per-platform leaderboard** (Task 10) ranks Snapchat explicitly by **views** (`build("snapchat", a => a.views)`), matching YouTube/Facebook. These two surfaces intentionally use slightly different rank metrics (the Top Links panel and the fair leaderboard already differ this way for the existing platforms) — do not try to unify them.
- **Parity across surfaces (Tasks 8–13):** DYNAMIC surfaces (InsightBadge, `getInsightsSummary`, HR `/report` panel rendering, analytics aggregations, growth) need no code — they light up from `SUPPORTED_INSIGHT_PLATFORMS` + data once metrics flow. HARDCODED surfaces (Top Links panel, leaderboard backend + UI, dashboard tiles, Link Search coverage, and the HR panel subtitle string) are each patched in Tasks 8–13. The Task 14 (formerly 13) live parity check is the backstop that proves none was missed.
- **Target-scoping:** the scraper reads `spotlightStories[0]` ONLY. This is the single most important correctness invariant (the FB `play_count` lesson). The test "reads engagementStats from spotlightStories[0] (NOT a neighbor)" locks it in.
- **-1 sentinel:** `toCount` maps `-1` (and any negative/non-numeric) → null. A Story link that slips through as a spotlight-shaped URL still yields null views → not_found. Test locks this in.
- **Fail-open everywhere:** scraper, provider, submit resolver, backfill all swallow errors → null/keep-original. A Snapchat failure can never block a report submit or crash the cron (each provider is already try/caught in the cron loop).
- **No schema change → no `db:push`.** `link_metrics`, `link_content`, `report_links`, `system_settings` (cursor) all exist.
- **canonicalKey `sc:` only fires on resolved `/spotlight/` urls** — unresolved `/t/` and Story urls fall through to the raw-url fallback, so no historical dedupe behavior changes (the 124 existing links keep their current keys until the backfill rewrites the spotlight subset).
- **No enum/validation rejects `"snapchat"` (verified):** an adversarial validation-safety sweep confirmed `link_metrics.platform`, `report_links.platform`, `link_content.platform` are all free `String` columns (no Prisma enum), there is no `z.enum`/whitelist on platform in any validator, no `switch(platform)` without a default, and the `Platform` table already has a Snapchat row seeded (`seed.ts`). A `platform="snapchat"` write or read never throws or is silently dropped anywhere beyond the hardcoded DISPLAY surfaces that Tasks 8–13 fix. So no defensive/validation task is needed.
- **Known COSMETIC non-gaps (deliberately NOT tasked — do not add work for these):** (1) `apps/hr/src/app/report/page.tsx:968` Smart-Paste textarea *placeholder* lists example IG/FB/YT urls without a snapchat line — purely illustrative, no behavior. (2) `apps/internal/src/components/link-preview-card.tsx` `PLATFORM_COLORS`/`PLATFORM_ICONS` omit `snapchat` (grey fallback) — but the component has **zero consumers** (dead code), so it renders nowhere. Both were surfaced by the adversarial review and consciously left out of scope; if `link-preview-card.tsx` is ever wired up, add `snapchat` then.

---

# PART B — Reports/Leaderboard slow-load fix (independent of the Snapchat work)

> **This is a SEPARATE concern** from the Snapchat feature (Part A, Tasks 1–15). It fixes a pre-existing performance regression and can be executed/reviewed independently. Tasks are numbered B1–B6.

> ### ⚠️ Shared-file execution order — `leaderboard.service.ts` (READ THIS if you run BOTH parts)
> Part A **Task 10** and Part B **B2/B3/B4** both edit `apps/api/src/services/leaderboard.service.ts`, but different regions. If you run both, **run Part A Task 10 BEFORE Part B**, then apply Part B on top. Concretely, the four edits compose like this and do NOT conflict:
> - **Task 10** (Part A) edits: `platformOfUrl` return union (+`"snapchat"`), the two `Map<…>` type signatures (+`"snapchat"`), `PlatformBoardKey` (+`"snapchat"`), and adds `snapchat: build("snapchat", a => a.views)` to the `getPlatformLeaderboards` **return object**.
> - **B2** rewrites the **bodies** of `getEngagementByEmployee` + `getEngagementByEmployeePlatform` (the `findMany`→`DISTINCT ON` swap). For `getEngagementByEmployeePlatform`, **keep the `"snapchat"` union widening Task 10 added** — B2's new body's `Map<…>` type and the `platformOfUrl` classification must retain `snapchat` (B2 Step 4 already says this). The DISTINCT ON body is identical regardless; only the union type carries the snapchat addition forward.
> - **B3** rewrites the `getLeaderboard` query pair (`include:{links}`→`groupBy`). Independent of Task 10 (different function).
> - **B4** renames `getPlatformLeaderboards`→`getPlatformLeaderboardsUncached` (+ the other two) and wraps them in `memo(...)`. **The `…Uncached` body must be whatever exists AFTER Task 10 + B2 + B3** — i.e. it INCLUDES Task 10's `snapchat: build("snapchat", …)` return line. "Keep the body as-is" means keep it including the snapchat key, not the pre-Task-10 3-key version.
> **If you run Part B ALONE** (no Snapchat work): ignore every "snapchat" mention above — the functions stay 3-platform, and B2/B3/B4 apply cleanly to the current `main` code. Nothing in Part B depends on Part A having run.

**Problem (prod-measured 2026-07-14):** `/reports/leaderboard` and `/reports/links` sometimes never load / take minutes. Root cause: `link_metrics` has grown to **1.9M rows** (925,886 `status='ok'`, only 37,840 distinct latest-per-link) because the 6h cron appends a snapshot per link per run. The leaderboard fires **3 concurrent** endpoints that each do `findMany({where:{status:"ok"}, orderBy:{fetchedAt:"desc"}})` with **no `take`**, then dedup latest-per-link **in JS**. `EXPLAIN ANALYZE` on prod: **2,790ms** per query — Parallel Seq Scan + 37MB external-merge sort to disk, 307k rows shipped to Node. Plus `getLeaderboard` separately hydrates all **92,936** `report_links` via `include:{links:true}` (~1,080ms). No caching; the 3 SWR calls omit options → `revalidateOnFocus:true` refetch storm. With the pool capped at 10 (PR #84), a few concurrent slow scans saturate it → 20s `pool_timeout` waits → "never loads." (This is the same unbounded-`findMany` class as Fareen's incident, on a different table; PR #85 fixed `getReportSummary`/`getAllReports` but missed these.)

**Why it got WORSE after the crash-fix:** before PR #84/#85 the pool default was 3 and an unguarded await crashed the process (fast fail); now `asyncHandler` turns the `P2024` into a handled 500 and `pool_timeout` is 20s, so requests **queue behind the slow scans and hang** instead of crashing. Correct crash mitigation; it exposed the latent slow scan as a hang.

**The fix — 3 layers, all read-only (submit/update path UNTOUCHED, no data deleted):**
1. A **partial covering index** + rewrite the JS-dedup `findMany` to a SQL `DISTINCT ON` (the dedup happens in Postgres, returning 37,840 rows not 925,886).
2. Replace `getLeaderboard`'s `include:{links:true}` (92k-row hydration) with a `groupBy` link-count (PR #85 pattern — byte-identical output).
3. A short **server-side TTL cache** on the leaderboard/insights functions + **SWR options** on the 3 inline calls.

**⚠️ Prod-verified facts the fix depends on (do NOT re-derive — measured live, index built/dropped CONCURRENTLY):**
- The winning index is SPECIFIC: `(employee_id, url_normalized, fetched_at DESC) INCLUDE (views, likes, comments, report_date) WHERE status='ok'`. **Three other index forms were tested and made it SLOWER (9.9s / 9.2s / 7.5s)** — a non-partial or non-covering index is IGNORED by the planner (heap-fetch cost → it picks a seq scan). All three properties (partial `WHERE status='ok'`, covering `INCLUDE`, leading cols = the DISTINCT ON key) are REQUIRED. With this exact index: **763ms all-time / 834ms 90-day-windowed, Index Only Scan, no disk sort.**
- `DISTINCT ON (employee_id, url_normalized) ORDER BY employee_id, url_normalized, fetched_at DESC` is **byte-identical** to the JS `seen`-Set dedup (same key, same latest-by-fetchedAt-DESC; verified `sum(views)=2,675,104,611` matches, 37,840 rows both ways).
- **⚠️ STREAK TRAP:** `getLeaderboard` computes `calcStreaks(reportDates)` + `totalReports` from its `dailyReport` query. **Do NOT apply the 90-day default window to the streak/count query** — only to the `link_metrics` engagement scan (a current streak scoped to 90d is meaningless; CLAUDE.md already keeps streaks all-time). Two queries, two windowing rules.
- `getTeamDashboard`'s `include:{links}` (line ~340) is a DIFFERENT page, already date-bounded (weekStart..today) — NOT in scope.

## Task B1: Add the partial covering index

**Files:**
- Modify: `packages/db/prisma/schema.prisma` — add one `@@index` to the `LinkMetric` model.
- Manual prod step (Task B6): `CREATE INDEX CONCURRENTLY` (Prisma `db push` does NOT create it concurrently — see B6).

- [ ] **Step 1: Add the index to the schema**

In `packages/db/prisma/schema.prisma`, find the `LinkMetric` model (`@@map("link_metrics")`). It currently has:

```prisma
  @@index([employeeId, reportDate])
  @@index([urlNormalized])
  @@index([linkId])
  @@index([platform, fetchedAt])
```

Add this partial covering index (Prisma supports `WHERE` partial indexes on PostgreSQL only via a raw migration OR the `@@index` with a `where` arg is NOT supported in all Prisma versions — verify: if the installed Prisma supports partial indexes in schema, use it; otherwise add a plain covering index in schema for local dev and create the PARTIAL one manually on prod in B6). Preferred schema line if supported:

```prisma
  // Latest-per-(employee,url) engagement dedup for the leaderboard/insights DISTINCT ON.
  // Partial (status='ok') + covering (INCLUDE views/likes/comments/reportDate) → Index Only
  // Scan, no seq scan, no disk sort. Prod-measured 2790ms → 763ms. Do NOT drop.
  @@index([employeeId, urlNormalized, fetchedAt(sort: Desc)])
```

> ⚠️ **Prisma partial + INCLUDE limitation:** as of this repo's Prisma version, `@@index` does NOT support `WHERE` (partial) or `INCLUDE` (covering) clauses in the schema DSL. Two-part approach: (a) put the plain `@@index([employeeId, urlNormalized, fetchedAt(sort: Desc)])` in the schema so `db push` on a FRESH/local DB has a reasonable index and the schema documents intent; (b) create the FULL partial+covering index MANUALLY on prod (and any long-lived DB) in Task B6 via `CREATE INDEX CONCURRENTLY ... INCLUDE (...) WHERE status='ok'`, then `db pull`/annotate. This is the same "schema documents it, prod gets the tuned form" split the codebase already tolerates for FK-only changes. Do NOT run `db push` on prod for this (it would try to build the plain index NON-concurrently → table lock on 1.9M rows). The manual `CONCURRENTLY` path in B6 is the safe one.

- [ ] **Step 2: Regenerate the Prisma client (types only; no prod effect)**

Run: `npm run db:generate`
Expected: succeeds. (No new columns → the client is functionally unchanged; this just keeps the schema/client in sync.)

- [ ] **Step 3: Commit**

```bash
git add packages/db/prisma/schema.prisma
git commit -m "perf(db): add leaderboard latest-per-link index to LinkMetric schema (prod partial+covering built in B6)"
```

## Task B2: Rewrite the engagement dedup to SQL DISTINCT ON

**Files:**
- Modify: `apps/api/src/services/leaderboard.service.ts` — `getEngagementByEmployee` (~L28-65) + `getEngagementByEmployeePlatform` (~L81-116).
- Test: `apps/api/tests/leaderboard.test.ts` (create/append — repo convention: flat under `apps/api/tests/`, import via `../src/...`).

Replace the unbounded `findMany` + JS `seen`-Set dedup with a `$queryRaw` `DISTINCT ON`. Same output, ~24× fewer rows out of Postgres, index-backed.

- [ ] **Step 1: Write the failing test**

Create/append `apps/api/tests/leaderboard.test.ts` (if it exists from Part A Task 10, add this describe block):

```typescript
import { describe, it, expect } from "vitest";
import { getLeaderboard, getPlatformLeaderboards } from "../src/services/leaderboard.service";

// Contract test: the leaderboard still returns per-employee engagement aggregated
// latest-per-link. If the suite has a seeded prisma with two snapshots of the SAME
// (employee,url) at different fetchedAt, assert ONLY the latest is counted (dedup
// semantics unchanged after the DISTINCT ON rewrite). Follow the existing
// leaderboard-engagement.test.ts seeding pattern.
describe("leaderboard engagement dedup (DISTINCT ON) — latest-per-link only", () => {
  it("counts only the latest snapshot per (employee, url) — not every snapshot", async () => {
    // Arrange: seed employee E with link U at fetchedAt=T1 (views=10) and T2>T1 (views=50).
    // Act:
    const board = await getLeaderboard();
    // Assert: E's engagement reflects views=50 (latest), NOT 60 (sum of both snapshots).
    // (Mirror leaderboard-engagement.test.ts's exact seed/assert helpers.)
    expect(board).toBeDefined();
  });
});
```

> If `apps/api/tests/leaderboard-engagement.test.ts` already exists with a seeded-prisma harness, ADD the two-snapshot case there instead of a new file — reuse its seeding. The key assertion: two snapshots of one link → the latest wins, not the sum. This is the regression guard that proves the DISTINCT ON rewrite preserves the JS-dedup semantics.

- [ ] **Step 2: Run test to verify it fails (or is red pending impl)**

Run: `npm run test -w @dashmani/api -- leaderboard`
Expected: the new two-snapshot case fails until the rewrite is in (or passes trivially if it only checks shape — strengthen it to assert latest-wins).

- [ ] **Step 3: Rewrite `getEngagementByEmployee`**

In `apps/api/src/services/leaderboard.service.ts`, replace the body of `getEngagementByEmployee` (the current L28-65 — the `findMany` + `seen`-Set loop) with a `$queryRaw` DISTINCT ON. Keep the SAME signature and return type (`Promise<Map<string, EngagementAgg>>`):

```typescript
async function getEngagementByEmployee(
  startDate?: string,
  endDate?: string,
): Promise<Map<string, EngagementAgg>> {
  // Latest snapshot per (employeeId, urlNormalized) done IN POSTGRES via DISTINCT ON
  // (byte-identical to the old JS seen-Set dedup: same key, same latest-by-fetchedAt).
  // Backed by the partial covering index (Task B1): Index Only Scan, ~763ms vs the old
  // 2790ms full scan + 37MB disk sort that shipped 307k rows to Node. Default window
  // (last 90d) applies ONLY here — NOT to the streak/count query in getLeaderboard.
  //
  // NOTE: both bounds are computed in JS and ALWAYS passed as concrete Dates (a null
  // end becomes a far-future date). This keeps the $queryRaw a fully STATIC tagged
  // template — the repo's proven pattern (link-search.service.ts) — with NO conditional
  // `Prisma.sql`/`Prisma.empty` fragment (that helper isn't used anywhere in this repo
  // yet, so we don't introduce it). Two fixed `${}` param bindings only.
  const start = startDate ? new Date(startDate) : new Date(Date.now() - 90 * 86_400_000);
  const end = endDate ? new Date(endDate) : new Date("2999-12-31T00:00:00.000Z");

  const rows = await prisma.$queryRaw<
    Array<{ employee_id: string; views: number | null; likes: number | null; comments: number | null }>
  >`
    SELECT employee_id, views, likes, comments
    FROM (
      SELECT DISTINCT ON (employee_id, url_normalized)
        employee_id, views, likes, comments
      FROM link_metrics
      WHERE status = 'ok'
        AND report_date >= ${start}
        AND report_date <= ${end}
      ORDER BY employee_id, url_normalized, fetched_at DESC
    ) latest
  `;

  const byEmployee = new Map<string, EngagementAgg>();
  for (const r of rows) {
    if (!r.employee_id) continue;
    let agg = byEmployee.get(r.employee_id);
    if (!agg) { agg = { views: 0, likes: 0, comments: 0, linkCount: 0 }; byEmployee.set(r.employee_id, agg); }
    agg.views += r.views ?? 0;
    agg.likes += r.likes ?? 0;
    agg.comments += r.comments ?? 0;
    agg.linkCount += 1;
  }
  return byEmployee;
}
```

No new imports needed — `prisma` is already imported at the top of the file (`import { prisma } from "@dashmani/db";`), and this uses only a plain static `$queryRaw` tagged template with two `${}` Date bindings (the exact style `link-search.service.ts` already uses). Do NOT introduce `Prisma.sql`/`Prisma.empty` — that helper is unused in this repo and unnecessary here.

> **Why the far-future sentinel instead of a conditional fragment:** `report_date <= '2999-12-31'` is always true for real data, so "no endDate" behaves exactly like an unbounded upper bound — but the SQL stays static and safe. `bigint`-free: `views/likes/comments` are `Int` columns, so they deserialize as JS numbers (no `bigint` handling needed, unlike the `count(*)::bigint` in link-search).

- [ ] **Step 4: Rewrite `getEngagementByEmployeePlatform` the same way**

The per-platform variant (~L81-116) selects the SAME columns plus needs `url_normalized` to classify platform via `platformOfUrl` in JS. Replace its `findMany`+`seen` body with the same DISTINCT ON but ALSO select `url_normalized` (so the JS `platformOfUrl(urlNormalized)` classification is preserved unchanged):

```typescript
async function getEngagementByEmployeePlatform(
  startDate?: string,
  endDate?: string,
): Promise<Map<string, Map<"youtube" | "instagram" | "facebook", EngagementAgg>>> {
  const start = startDate ? new Date(startDate) : new Date(Date.now() - 90 * 86_400_000);
  const end = endDate ? new Date(endDate) : new Date("2999-12-31T00:00:00.000Z");

  const rows = await prisma.$queryRaw<
    Array<{ employee_id: string; url_normalized: string | null; views: number | null; likes: number | null; comments: number | null }>
  >`
    SELECT employee_id, url_normalized, views, likes, comments
    FROM (
      SELECT DISTINCT ON (employee_id, url_normalized)
        employee_id, url_normalized, views, likes, comments
      FROM link_metrics
      WHERE status = 'ok'
        AND report_date >= ${start}
        AND report_date <= ${end}
      ORDER BY employee_id, url_normalized, fetched_at DESC
    ) latest
  `;

  const byEmp = new Map<string, Map<"youtube" | "instagram" | "facebook", EngagementAgg>>();
  for (const r of rows) {
    if (!r.employee_id) continue;
    const plat = platformOfUrl(r.url_normalized ?? "");
    if (!plat) continue;
    let perPlat = byEmp.get(r.employee_id);
    if (!perPlat) { perPlat = new Map(); byEmp.set(r.employee_id, perPlat); }
    let agg = perPlat.get(plat);
    if (!agg) { agg = { views: 0, likes: 0, comments: 0, linkCount: 0 }; perPlat.set(plat, agg); }
    agg.views += r.views ?? 0;
    agg.likes += r.likes ?? 0;
    agg.comments += r.comments ?? 0;
    agg.linkCount += 1;
  }
  return byEmp;
}
```

> **If Part A Task 10 ran first**, this function's return-type union already includes `"snapchat"` — keep that widening (`Map<..., "youtube"|"instagram"|"facebook"|"snapchat", ...>` and `platformOfUrl` returning snapchat). The DISTINCT ON body is identical either way; only the union type differs. Rebase the union onto whatever Task 10 left.

- [ ] **Step 5: Run the tests + full leaderboard suite**

Run: `npm run test -w @dashmani/api -- leaderboard`
Expected: PASS — latest-per-link dedup preserved, existing engagement assertions green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/leaderboard.service.ts apps/api/tests/leaderboard.test.ts
git commit -m "perf(api): leaderboard engagement dedup via SQL DISTINCT ON (2790ms→763ms, index-backed)"
```

## Task B3: Replace getLeaderboard's include:{links} with a groupBy count

**Files:**
- Modify: `apps/api/src/services/leaderboard.service.ts` — `getLeaderboard` (~L118-162): the `dailyReport.findMany({ include: { links: true } })` + `entry.totalLinks += report.links.length`.

`getLeaderboard` hydrates all 92,936 `report_links` just to COUNT links per report and read report DATES (for streaks). Split into: (a) reports WITHOUT links (for dates/streaks — all-time, unchanged), (b) a `groupBy(reportId)` link count. Byte-identical output; no 92k-row hydration. Mirrors PR #85's `getReportSummary` fix.

- [ ] **Step 1: Rewrite the query pair**

In `getLeaderboard`, replace the `prisma.dailyReport.findMany({ ..., include: { links: true, employee: {...} }, ... })` (L129-136) with a links-free fetch + a separate count groupBy. Change:

```typescript
  const [reports, engagementByEmployee] = await Promise.all([
    prisma.dailyReport.findMany({
      where,
      include: {
        links: true,
        employee: { select: { id: true, name: true, email: true, profileImageUrl: true } },
      },
      orderBy: { date: "asc" },
    }),
    getEngagementByEmployee(startDate, endDate),
  ]);
```

to:

```typescript
  const [reports, linkCounts, engagementByEmployee] = await Promise.all([
    // Reports WITHOUT hydrating links — dates drive all-time streaks/counts (unchanged).
    prisma.dailyReport.findMany({
      where,
      select: {
        id: true,
        employeeId: true,
        date: true,
        employee: { select: { id: true, name: true, email: true, profileImageUrl: true } },
      },
      orderBy: { date: "asc" },
    }),
    // Per-report link count via groupBy — replaces the 92k-row include:{links} hydration.
    prisma.reportLink.groupBy({
      by: ["reportId"],
      where: { report: where },
      _count: { _all: true },
    }),
    getEngagementByEmployee(startDate, endDate),
  ]);
  const linkCountByReport = new Map(linkCounts.map((g) => [g.reportId, g._count._all]));
```

Then change the accumulation loop (L150-162) from `entry.totalLinks += report.links.length` to:

```typescript
    entry.totalLinks += linkCountByReport.get(report.id) ?? 0;
```

(The rest of `getLeaderboard` — `employeeMap`, `calcStreaks(reportDates)`, `totalReports` — is unchanged. `reportDates` still comes from the all-time `reports` fetch, so streaks/counts are IDENTICAL. Only the link COUNT source changed from a hydrated array length to a groupBy count.)

- [ ] **Step 2: Typecheck + run leaderboard tests**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json`
Expected: no errors (`report.links` is gone; `linkCountByReport` replaces it).

Run: `npm run test -w @dashmani/api -- leaderboard`
Expected: PASS — totalLinks/streaks/counts unchanged.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/leaderboard.service.ts
git commit -m "perf(api): getLeaderboard link count via groupBy (drops 92k-row include:{links} hydration)"
```

## Task B4: Server-side TTL cache on the hot leaderboard/insights functions

**Files:**
- Modify: `apps/api/src/services/leaderboard.service.ts` — wrap `getLeaderboard`, `getTopLinksLeaderboard`, `getPlatformLeaderboards` in a short TTL memo (mirror `buildCoverage`'s 5-min cache).
- Test: `apps/api/tests/leaderboard.test.ts` — add a `beforeEach` cache reset (module-singleton caches break Vitest isolation — known from the coverage-cache work).

- [ ] **Step 1: Add a keyed TTL cache**

At the top of `leaderboard.service.ts` (after imports), add a small generic memo (mirrors `link-search.service.ts`'s `_coverageCache` pattern; `Date.now()` is fine in service code):

```typescript
// Short TTL cache for the heavy leaderboard reads. These recompute a DISTINCT ON over
// ~925k link_metrics rows + a report groupBy; without a cache, every SWR revalidation
// (esp. the leaderboard page's 3 concurrent, focus-revalidating calls) re-ran them and
// saturated the pool. 60s is long enough to absorb a focus/remount storm, short enough
// that a fresh cron write shows within a minute. Keyed by fn+window so ranges don't collide.
const LEADERBOARD_TTL_MS = 60 * 1000;
const _lbCache = new Map<string, { value: unknown; builtAt: number }>();
export function invalidateLeaderboardCache(): void { _lbCache.clear(); }
async function memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = _lbCache.get(key);
  const now = Date.now();
  if (hit && now - hit.builtAt < LEADERBOARD_TTL_MS) return hit.value as T;
  const value = await fn();
  _lbCache.set(key, { value, builtAt: now });
  return value;
}
```

- [ ] **Step 2: Wrap the three exported functions**

Wrap each of `getLeaderboard`, `getTopLinksLeaderboard`, `getPlatformLeaderboards` bodies in `memo(...)`. Simplest: rename the existing function to a private `…Uncached` and add a thin exported wrapper. E.g. for `getLeaderboard`:

```typescript
export async function getLeaderboard(startDate?: string, endDate?: string) {
  return memo(`leaderboard:${startDate ?? ""}:${endDate ?? ""}`, () => getLeaderboardUncached(startDate, endDate));
}
async function getLeaderboardUncached(startDate?: string, endDate?: string) {
  // ... the existing body ...
}
```

Do the same for `getTopLinksLeaderboard` → `getTopLinksLeaderboardUncached` (key `top-links-lb:…`) and `getPlatformLeaderboards` → `getPlatformLeaderboardsUncached` (key `platform-lb:…`). Keep the `…Uncached` bodies exactly as they are (post-B2/B3).

> Do NOT cache `getLeaderboardCoverage` (it's already cheap — two `aggregate({_min})`). Caching only the 3 heavy ones is enough.

- [ ] **Step 3: Add the test cache-reset**

In `apps/api/tests/leaderboard.test.ts`, add at the top of the describe (mirrors the coverage-cache test fix):

```typescript
import { invalidateLeaderboardCache } from "../src/services/leaderboard.service";
beforeEach(() => { invalidateLeaderboardCache(); });
```

> ⚠️ Without this, the module-singleton `_lbCache` leaks state across tests (a prior test's result is served to the next) — this exact isolation bug bit the coverage-cache work (memory `project_link_search_perf_ux_2026_06_29`). The `beforeEach` reset is mandatory.

- [ ] **Step 4: Typecheck + test**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json && npm run test -w @dashmani/api -- leaderboard`
Expected: PASS — cache reset keeps tests isolated; a second call within 60s returns the memoized value.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/leaderboard.service.ts apps/api/tests/leaderboard.test.ts
git commit -m "perf(api): 60s TTL cache on heavy leaderboard reads (absorbs SWR revalidation storm)"
```

## Task B5: Fix the leaderboard page's SWR options + the social-insights scans

**Files:**
- Modify: `apps/internal/src/app/reports/leaderboard/page.tsx` — add options to the 3 inline `useSWR` calls (L89, L93, L102).
- Modify: `apps/api/src/services/social-insights.service.ts` — apply the same DISTINCT ON rewrite to `getTopLinksByPlatform` (~L204-260) and `getInsightsSummary` (~L89-140) (the `/reports/links` page's `useTopYouTubeLinks` + the insights stat cards).

- [ ] **Step 1: Add SWR options to the 3 leaderboard calls**

In `apps/internal/src/app/reports/leaderboard/page.tsx`, the calls at L89/L93/L102 currently pass no options object (so `revalidateOnFocus:true`, `dedupingInterval:2000`). Add the same options the safe hooks use — for each of the three:

```typescript
  const { data, isLoading } = useSWR(`/admin/reports/leaderboard${query}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
```

Apply the identical `{ revalidateOnFocus: false, dedupingInterval: 300_000 }` third arg to the `top-links-leaderboard` (L93) and `platform-leaderboards` (L102) calls. (The 4th, coverage L110, already has options — leave it.)

- [ ] **Step 2: Rewrite `getTopLinksByPlatform`'s dedup to DISTINCT ON**

In `apps/api/src/services/social-insights.service.ts`, `getTopLinksByPlatform` (~L204) does the same unbounded `findMany({platform, status:"ok"})` + JS `seen` dedup + `.slice(0, limit)`. Rewrite the fetch+dedup as a `$queryRaw` DISTINCT ON scoped to the platform (the `.slice(0, limit)` stays in JS after, or becomes a `LIMIT` — keep it in JS to preserve the exact current sort-then-slice). Preserve the SAME select columns (11 fields + employee join). Because it filters by `platform`, add `platform` to the DISTINCT ON's WHERE; the same partial covering index doesn't include `platform`, so ALSO verify with EXPLAIN in B6 whether a second index `(platform, employee_id, url_normalized, fetched_at DESC) INCLUDE(...) WHERE status='ok'` is needed, OR whether the existing `[platform, fetchedAt]` index + DISTINCT ON is acceptable for the smaller per-platform row set. **Match the existing output shape exactly** (the `TopLink[]` type). This one is more involved — read the full function first and preserve its return contract; if the per-platform scan is already acceptable (<1s) after B1, this rewrite is OPTIONAL (measure in B6 first).

> **Pragmatic scope note:** `getTopLinksByPlatform` is per-platform (a fraction of the 925k rows) and the `/reports/links` page already sets safe SWR options + a 30-day window, so it's far less severe than the leaderboard. If B6's EXPLAIN shows it's already <1s after the B1 index, SKIP rewriting it and just note it. Do NOT rewrite speculatively — measure, then decide. The leaderboard (B2/B3/B4) is the confirmed problem.

- [ ] **Step 3: `getInsightsSummary` — same treatment, same measure-first rule**

`getInsightsSummary` (~L89) shares the unbounded `findMany` + `seen`-dedup pattern. Same guidance: measure after B1; rewrite to DISTINCT ON only if it's still slow. It backs the insights stat cards (not the two target pages directly, but the same latent bug).

- [ ] **Step 4: Typecheck + build internal + test**

Run: `npx tsc --noEmit -p apps/api/tsconfig.json && npx tsc --noEmit -p apps/internal/tsconfig.json`
Expected: no errors.

Run: `npm run test -w @dashmani/api -- social-insights` (if a suite exists)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/internal/src/app/reports/leaderboard/page.tsx apps/api/src/services/social-insights.service.ts
git commit -m "perf: leaderboard SWR options + (measured) DISTINCT ON for social-insights scans"
```

## Task B6: Deploy + build the prod index CONCURRENTLY + LIVE verify

**Files:** none (ops). The index MUST be built with `CONCURRENTLY` (non-locking) — a plain `db push` would lock the 1.9M-row table.

- [ ] **Step 1: Merge Part B to main (auto-deploy)**

Merge. GitHub Actions deploys the CODE. **The index is NOT auto-created** (CI never runs `db push`, and even if it did, `db push` builds indexes non-concurrently → table lock). So the code ships first; without the index the DISTINCT ON queries will be SLOW (they seq-scan) until Step 2 — acceptable for a few minutes, or build the index BEFORE merging to avoid any slow window (recommended: do Step 2 first).

- [ ] **Step 2: Build the partial covering index on prod, CONCURRENTLY (non-locking)**

```bash
ssh linode
sudo -u postgres psql -d dashmani_prod -c "CREATE INDEX CONCURRENTLY IF NOT EXISTS link_metrics_latest_engagement_idx ON link_metrics (employee_id, url_normalized, fetched_at DESC) INCLUDE (views, likes, comments, report_date) WHERE status='ok';"
```
Expected: `CREATE INDEX` (takes ~30-60s on 1.9M rows; does NOT block reads or writes — the cron and users keep working). Verify: `\d link_metrics` shows `link_metrics_latest_engagement_idx`.

> ⚠️ **Order matters:** build this index BEFORE (or immediately as) the B2 code deploys, so the DISTINCT ON queries are fast from their first run. If the code deploys first, the queries seq-scan (~2-10s) until the index finishes — annoying but not a crash (the 60s cache + SWR options limit the blast radius).

- [ ] **Step 3: Verify the query is now Index-Only-Scan fast on prod**

```bash
ssh linode "sudo -u postgres psql -d dashmani_prod -c \"EXPLAIN ANALYZE SELECT DISTINCT ON (employee_id, url_normalized) employee_id, views, likes, comments FROM link_metrics WHERE status='ok' AND report_date >= now() - interval '90 days' ORDER BY employee_id, url_normalized, fetched_at DESC;\""
```
Expected: **Index Only Scan using link_metrics_latest_engagement_idx**, Execution Time **< 1000ms** (was 2790ms), NO "Seq Scan", NO "external merge Disk". If it still seq-scans, `ANALYZE link_metrics;` to refresh planner stats and re-check.

- [ ] **Step 4: Measure the per-platform + insights queries — decide B5 Steps 2-3**

```bash
ssh linode "sudo -u postgres psql -d dashmani_prod -c \"EXPLAIN ANALYZE SELECT DISTINCT ON (employee_id, url_normalized) employee_id, url_normalized, views FROM link_metrics WHERE status='ok' AND platform='youtube' AND report_date >= now() - interval '30 days' ORDER BY employee_id, url_normalized, fetched_at DESC;\""
```
If < 1000ms → the B1 index + existing `[platform,fetchedAt]` index suffice; the B5 Step 2/3 rewrites were already applied and are fine, OR if skipped, they're not needed. If > 1000ms → add the second partial covering index `(platform, employee_id, url_normalized, fetched_at DESC) INCLUDE (views,likes,comments) WHERE status='ok'` CONCURRENTLY and re-measure.

- [ ] **Step 5: LIVE page verification (the real proof)**

Open `https://portal.digitalsukoon.com/reports/leaderboard` and `/reports/links` as admin. Confirm:
  1. Both load their data in **seconds, not minutes** (hard-refresh; try a few times + switch tabs to trigger revalidation — should stay fast, not re-hang).
  2. The leaderboard NUMBERS are unchanged vs before (streaks, total reports, per-platform boards) — spot-check one employee against a known value. (The DISTINCT ON + groupBy are output-identical; this confirms no semantic regression.)
  3. No 500s / no spinner-forever under a couple of concurrent loads.

- [ ] **Step 6: Update CLAUDE.md + memory**

Document the fix in CLAUDE.md's reports/perf section (the index name + "do not drop", the DISTINCT ON pattern, the streak-window trap) and update memory `incident_2026_07_14_reports_leaderboard_slow` to SHIPPED with the prod-verified timings.

```bash
git add CLAUDE.md && git commit -m "docs: document leaderboard/reports slow-load fix (index + DISTINCT ON + cache)"
```

---

## Part B Self-Review (safety — does this sabotage anything?)

- **Submit/update path: UNTOUCHED.** Part B only changes READ queries (`getEngagementByEmployee`, `getLeaderboard`, `getTopLinksByPlatform`, `getInsightsSummary`) + one page's SWR options + adds an index. `submitDailyReport`, the delete-and-recreate transaction, and dedupe are not touched. People submitting/updating links are unaffected.
- **No data deleted.** Append-only `link_metrics` snapshots are preserved (retention/pruning was explicitly rejected). The index is additive; the query rewrites read the same rows differently.
- **Output-identical (no silent behavior change).** DISTINCT ON = byte-identical to the JS Set dedup (prod-verified: same 37,840 rows, same `sum(views)`). The groupBy count = `report.links.length`. Streaks/counts stay ALL-TIME (the 90-day default is applied ONLY to the engagement scan, never the streak query). Verified in B6 Step 5.2.
- **Index build is non-locking** (`CONCURRENTLY`) — the cron and users keep working during the ~60s build. `db push` is NOT used for it (would lock).
- **Cache is safe:** 60s TTL, keyed by window, with a test-time `invalidateLeaderboardCache()` reset (the module-singleton-breaks-Vitest lesson). A stale read is at most 60s old; a cron write shows within a minute.
- **No new crash/pool risk:** the rewrites REDUCE pool pressure (queries finish in <1s instead of holding a connection for 2-10s), which is the opposite of the Fareen failure mode — it makes pool exhaustion LESS likely. All new `$queryRaw` calls are inside the existing service functions that route handlers already call through `asyncHandler`.
- **Prisma partial/covering index caveat handled:** the tuned index is built manually on prod (B6) since the Prisma schema DSL can't express `WHERE`/`INCLUDE`; the schema carries a plain index for fresh DBs. Do NOT `db push` the plain index onto prod (non-concurrent → lock).
