# Jobs Portal SEO Fix + Google Search Console Setup

**Date:** 2026-06-06
**Why the jobs portal wasn't showing on Google:** the public pages were `"use client"` and fetched
jobs in the browser, so Googlebot received an empty `0 positions / Loading…` shell with no job
content in the HTML. Google indexed the empty shell and decided there was nothing to rank. The
domain was also (almost certainly) never verified in Google Search Console, so Google had no fast
signal to crawl it.

This doc covers (A) the code fix that shipped, and (B) the step-by-step Search Console setup you
still need to do by hand (it's an account/DNS action, not code).

---

## A. Code fix (shipped in this branch)

All changes are in `apps/jobs`. The principle: **the jobs portal is our only public, SEO-dependent
surface, so its data must render on the server** (the internal/hr/client portals are correctly the
opposite — auth-gated SPAs where SEO is irrelevant).

| File | Change |
|------|--------|
| `src/lib/jobs.ts` (new) | Server-side `getJobs()` / `getJob()` (ISR, revalidate 3600s, degrade to empty on API failure), `buildJobPostingSchema()` (schema.org JobPosting per role), and `safeJsonLd()` (escapes `<` → `<` so a job description can't break out of a `<script>` JSON-LD block). |
| `src/app/page.tsx` (new) | **Server Component** wrapper. Fetches jobs server-side, emits an `ItemList` of `JobPosting` JSON-LD, and passes `initialJobs` to the client UI. |
| `src/app/JobsClient.tsx` (was `page.tsx`) | The existing interactive homepage, now seeded via SWR `fallbackData` so the **first render** (what Googlebot sees) already contains every role as real HTML. `coldLoad` flag ensures no "Loading…" placeholder text is ever in the prerendered HTML. |
| `src/app/[id]/page.tsx` (new) | **Server Component** wrapper for each job. Adds `generateMetadata` (unique title/description/**self-canonical** per role), `generateStaticParams` (prerenders every open role), per-job `JobPosting` JSON-LD, `notFound()` for bad IDs (real 404, not a soft-404 200), and a Suspense boundary with a content-bearing fallback. |
| `src/app/[id]/JobDetailClient.tsx` (was `page.tsx`) | The existing interactive detail page, now seeded with `initialJob`. |
| `src/app/layout.tsx` | **Removed the hardcoded `<link rel="canonical" href={SITE_URL}>`** — it was overriding every job page's own canonical, telling Google every role was a duplicate of the homepage. Canonicals now come per-page from metadata. JSON-LD hardened via `safeJsonLd`. |
| `src/app/internship/layout.tsx` | JobPosting schema enriched (`identifier`, `url`, `logo`) + hardened via `safeJsonLd`. |

**Verified against production data (25/25 checks):** all 3 live roles prerender with full
title/description/responsibilities/requirements/benefits as real HTML; each job page self-
canonicalizes; unique `<title>` per role; `JobPosting` + `ItemList` structured data present; no
visible "Loading…" text anywhere; build is clean (`tsc` + `next build`).

**No `db:push` needed.** Frontend-only. Deploys via the normal push-to-`main` pipeline.

### After deploy — confirm the fix is live
```bash
# Job content must now be in the server HTML (not an empty shell):
curl -s https://jobs.digitalsukoon.com/ | grep -c "Revenue Head\|Video Editor"   # > 0
# Each job page must self-canonicalize:
curl -s https://jobs.digitalsukoon.com/<job-id> | grep -o 'rel="canonical" href="[^"]*"'
# JobPosting structured data present:
curl -s https://jobs.digitalsukoon.com/<job-id> | grep -c '"@type":"JobPosting"'   # > 0
```

---

## B. Google Search Console setup (DO THIS BY HAND)

> **Status check first:** the domain showed no `google-site-verification` footprint, so it's almost
> certainly not verified. Confirm by opening https://search.google.com/search-console — if
> `digitalsukoon.com` (or `jobs.digitalsukoon.com`) is **not** in the property dropdown (top-left),
> it's not set up. Use the Google account you want to own the property (e.g. a company Google
> account, not a personal one you might lose access to).

### B1. Add a property — use a **Domain property** (recommended)

Two property types exist:
- **Domain property** (`digitalsukoon.com`) — covers `http`+`https`, **all subdomains** (jobs, portal,
  client, hr, api) and all paths, with **one** verification. Verified via **DNS only**.
- **URL-prefix property** (`https://jobs.digitalsukoon.com`) — covers just that one origin. Verified
  via DNS, HTML file, HTML meta tag, Google Analytics, or Tag Manager.

**Pick Domain property `digitalsukoon.com`.** One DNS record verifies your entire platform, needs no
code change, and survives redeploys.

Steps:
1. Go to https://search.google.com/search-console
2. Click the property dropdown (top-left) → **Add property**.
3. Choose the **Domain** option (left column) → type `digitalsukoon.com` → **Continue**.
4. Google shows a **TXT record** like `google-site-verification=<long-string>`. Copy it.

### B2. Add the TXT record in Cloudflare (your DNS is on Cloudflare)

1. Log in to Cloudflare → select the `digitalsukoon.com` zone.
2. **DNS** → **Records** → **Add record**.
3. Set:
   - **Type:** `TXT`
   - **Name:** `@`  (this means the root `digitalsukoon.com`)
   - **Content:** paste the full `google-site-verification=<...>` string exactly.
   - **TTL:** Auto.
   - **Proxy status:** N/A for TXT (no orange cloud).
4. **Save.**
5. Back in Search Console, click **Verify**. DNS can take minutes to ~a couple hours to propagate;
   if it fails immediately, wait and retry. (You can confirm the record is live at
   https://toolbox.googleapps.com/apps/dig/#TXT/ → enter `digitalsukoon.com`.)

> **Fallback if you can't touch DNS:** use a **URL-prefix property** for
> `https://jobs.digitalsukoon.com` with the **HTML meta tag** method. That requires a one-line code
> change — add `verification: { google: "<token>" }` to the `metadata` export in
> `apps/jobs/src/app/layout.tsx` — then redeploy. The DNS/Domain route is preferred because it needs
> no code and covers every subdomain.

### B3. Submit the sitemap

Once the property is **Verified**:
1. In Search Console, with the property selected, open **Sitemaps** (left nav, under "Indexing").
2. Under "Add a new sitemap", enter: `sitemap.xml`  (the full URL field will read
   `https://jobs.digitalsukoon.com/sitemap.xml`).

   > If you verified the **Domain** property `digitalsukoon.com`, the sitemaps UI may default to the
   > apex. Enter the full path `https://jobs.digitalsukoon.com/sitemap.xml`. If the UI won't accept a
   > subdomain path under the domain property, also add a **URL-prefix property** for
   > `https://jobs.digitalsukoon.com` (it auto-verifies under the domain property, no new DNS needed)
   > and submit the sitemap there — that's the cleaner home for jobs-portal reports anyway.
3. Click **Submit**. Status should become **Success** within a day. (`Couldn't fetch` = the URL is
   unreachable or blocked; `Sitemap had X errors` = parse problems — click in for details.)

Our sitemap already lists the homepage, `/internship`, and every open role (verified returning
valid XML, HTTP 200). It revalidates hourly, so new jobs appear automatically.

### B4. Force the first crawl with URL Inspection (fastest signal)

Don't wait for Google to discover the site organically — kick it:
1. In Search Console, click the **search bar at the top** ("Inspect any URL").
2. Paste `https://jobs.digitalsukoon.com/` → **Enter**.
3. If it says "URL is not on Google", click **Request indexing**. Google runs a live test and queues
   a crawl (usually hours to a few days).
4. Repeat **Request indexing** for `https://jobs.digitalsukoon.com/internship` and for each job URL
   you most want indexed (there's a daily quota, so prioritise the homepage + top roles).

### B5. Validate the structured data (Google Jobs eligibility)

Each role now emits `JobPosting` structured data, which makes it eligible for the **Google Jobs**
rich result (the boxed job widget in Search). Validate:
1. **Rich Results Test:** https://search.google.com/test/rich-results → enter a job URL →
   confirm it detects **Job posting** with no errors. (Warnings like missing `baseSalary` are
   optional — fine to ignore, or add salary later for a richer card.)
2. In Search Console, the **Job postings** enhancement report (appears under "Enhancements" once
   Google has crawled the structured data) will track valid/invalid postings over time.

---

## C. What to expect & ongoing

- **Timeline:** verification is instant once DNS propagates. First indexing of the homepage typically
  lands within a few days of "Request indexing"; full coverage of all job pages can take 1–2 weeks.
  A brand-new subdomain with low authority is always slower the first time — this is normal.
- **It's not instant and not guaranteed per-page.** Google still decides what to index. Good signals
  now in place: real server-rendered content, unique titles, self-canonicals, a sitemap, internal
  links (nav links every page to `/` and `/internship`), and JobPosting schema.
- **Monitor:** Search Console → **Pages** (Indexing) report shows indexed vs. excluded URLs and the
  reason for each exclusion. Check it weekly for the first month.
- **Link from the main site:** add a "Careers" link from `digitalsukoon.com` to
  `jobs.digitalsukoon.com` if one doesn't exist — an inbound link from your established apex is one
  of the strongest "please crawl this" signals for a new subdomain.
- **Bing too (optional, 5 min):** Bing Webmaster Tools can import directly from Search Console, and
  also feeds DuckDuckPro/ChatGPT search. Worth doing once GSC is set up.
