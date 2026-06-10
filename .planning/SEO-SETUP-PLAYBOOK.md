# SEO Setup Playbook (Deploy Playbook addendum)

**Scope:** how SEO works on this platform, what to do when you ship public-facing pages, and the
deploy-time checks that keep the jobs portal indexable. This is the *deploy playbook* companion to the
one-time setup record in [JOBS-SEO-AND-GSC-GUIDE.md](JOBS-SEO-AND-GSC-GUIDE.md).

> **A generalized, project-agnostic version of this knowledge** (for porting to other Claude projects)
> lives at `~/Desktop/SEO-SETUP-GUIDE-FOR-CLAUDE-PROJECTS.md`.

---

## 0. The one rule for this monorepo

**`apps/jobs` is the ONLY public, SEO-dependent portal.** The other four (`internal`, `client`, `hr`,
plus the `api`) are auth-gated SPAs where client-side fetching is correct and indexing is irrelevant
(they should never be indexed). The jobs portal is the **opposite**: its public pages **must
server-render their data**, or Googlebot gets an empty `0 positions / Loading…` shell and the portal
goes invisible on Google.

> See **Key Conventions** in [/CLAUDE.md](../CLAUDE.md) — the `apps/jobs is the ONLY public
> SEO-dependent portal` rule (currently rules 1–6) is the canonical, must-preserve spec. This file is
> the operational playbook around it.

---

## 1. How the jobs portal achieves SEO (the architecture to preserve)

Shipped in PR #29 (commit `3720554`, 2026-06-06). The files and their jobs:

| File | Role |
|------|------|
| [apps/jobs/src/lib/jobs.ts](../apps/jobs/src/lib/jobs.ts) | Server-side `getJobs()`/`getJob()` (ISR, `revalidate: 3600`, degrade to `[]`/`null` on API failure), `buildJobPostingSchema()` (schema.org JobPosting per role), `safeJsonLd()` (escapes `<` → `<`). |
| [apps/jobs/src/app/page.tsx](../apps/jobs/src/app/page.tsx) | **Server Component**. Fetches jobs, emits `ItemList` of `JobPosting` JSON-LD, seeds `<JobsClient initialJobs>`. |
| `apps/jobs/src/app/JobsClient.tsx` | The interactive homepage (client). Seeded via SWR `fallbackData` so the first HTML render already has every role. |
| [apps/jobs/src/app/[id]/page.tsx](../apps/jobs/src/app/[id]/page.tsx) | **Server Component**. `generateMetadata` (unique title + **self-canonical** per role), `generateStaticParams`, per-job `JobPosting` JSON-LD, `notFound()` for bad IDs, Suspense fallback that renders the full role text. |
| `apps/jobs/src/app/[id]/JobDetailClient.tsx` | The interactive detail page (client). Seeded with `initialJob`. |
| [apps/jobs/src/app/layout.tsx](../apps/jobs/src/app/layout.tsx) | Root metadata: homepage `<title>` (`metadata.title.default`), Organization JSON-LD, footer. **No hardcoded `<link rel="canonical">`** (it would make every job a homepage duplicate). |
| [apps/jobs/src/app/sitemap.ts](../apps/jobs/src/app/sitemap.ts) | Dynamic sitemap — homepage, `/internship`, + every open role from the live API. Revalidates hourly. |

**Non-negotiables (re-breaking any of these makes the portal invisible):**
1. Public `page.tsx` files are **Server Components** (no `"use client"`). Never convert them back to client-fetch SPAs.
2. Each job page **self-canonicalizes** via `generateMetadata → alternates.canonical`. Never add a hardcoded canonical to `layout.tsx`.
3. All JSON-LD goes through `safeJsonLd()` (the correct fix for the `dangerouslySetInnerHTML` security-hook warning — *not* DOMPurify).
4. Bad IDs → `notFound()` (real 404, not a soft-404 200).
5. Loading placeholders gated on `isLoading && jobs.length === 0`, never bare `isLoading` (or "Loading…" leaks into prerendered HTML).
6. **The homepage `<title>` is brand-only** (`"Careers at Digital Sukoon — Jobs & Internships"`). See §3.

---

## 2. Branding in metadata — what's visible vs. what's structural (PR #31, 2026-06-10)

Google crawls the `<title>` **verbatim** — it's the exact text shown as the result link. The brand is
**Digital Sukoon**; the registered legal entity is **Dashmani Media Private Limited** (the parent
company). The rule:

| Field | File / location | Value | Why |
|---|---|---|---|
| `<title>` default | `layout.tsx` `metadata.title.default` | "Careers at Digital Sukoon — Jobs & Internships" | Visible search-result title — brand only |
| OpenGraph / Twitter title | `layout.tsx` `openGraph.title`, `twitter.title` | same | Social share-card preview — brand only |
| Footer copyright | `layout.tsx` footer JSX | "© {year} Digital Sukoon" | Visible on every page — brand only |
| JSON-LD `legalName` | `layout.tsx` Organization schema | "Dashmani Media Private Limited" | **Keep** — schema.org `legalName` = registered entity behind the brand; Google Jobs uses it to verify the employer |
| JSON-LD `publisher` | `layout.tsx` WebSite/Org schema | "Dashmani Media Private Limited" | **Keep** — structural, not rendered |
| `keywords` / `description` meta | `layout.tsx`, `internship/layout.tsx` | mention "Dashmani Media" | **Keep** — hidden; help rank for "Dashmani Media jobs" searches |

**Litmus test for any future edit:** *Does a logged-out visitor see this string on the page or in a
search result?* If yes → brand ("Digital Sukoon"). If it's hidden metadata or structured data → the
legal entity is fine and often correct.

**A `<title>`/footer string can never change the URL.** The URL is `jobs.digitalsukoon.com`, set by
DNS. (This was an actual user question — worth stating plainly.)

---

## 3. Deploy lifecycle for SEO changes

SEO changes on `apps/jobs` are **frontend-only → no `db:push`**. They flow through the normal pipeline:

```
branch → edit → npm run build -w @dashmani/jobs (verify) → PR → merge to main
  → GitHub Actions runs scripts/deploy.sh → turbo build → pm2 restart → live in ~3 min
```

### Pre-push verification (REQUIRED — the login/jobs pages are the most visible surface)
```bash
# Type-check + full build of the jobs app:
npx tsc --noEmit -p apps/jobs/tsconfig.json
npm run build -w @dashmani/jobs

# Confirm the built <title> and that content is in the raw HTML:
grep -oE "<title>[^<]*</title>" apps/jobs/.next/server/app/index.html
```

### Post-deploy verification (against LIVE prod, as Googlebot)
```bash
# 1. Job content is in the server HTML (not an empty shell):
curl -s https://jobs.digitalsukoon.com/ | grep -c "Revenue Head\|Video Editor"        # > 0
# 2. Title is brand-only (no "Dashmani Media"):
curl -s https://jobs.digitalsukoon.com/ | grep -oE "<title>[^<]*</title>"
# 3. Each job page self-canonicalizes:
curl -s https://jobs.digitalsukoon.com/<job-id> | grep -o 'rel="canonical" href="[^"]*"'
# 4. JobPosting structured data present:
curl -s https://jobs.digitalsukoon.com/<job-id> | grep -c '"@type":"JobPosting"'       # > 0
# 5. Sitemap is valid XML, HTTP 200:
curl -sI https://jobs.digitalsukoon.com/sitemap.xml | head -1
```

---

## 4. Google Search Console — already set up; what's left ongoing

**One-time setup is DONE (2026-06-06):** Domain property `digitalsukoon.com` verified via Cloudflare
DNS (covers all subdomains), sitemap `https://jobs.digitalsukoon.com/sitemap.xml` submitted, all 5
launch URLs Request-Indexed. Full step-by-step in [JOBS-SEO-AND-GSC-GUIDE.md](JOBS-SEO-AND-GSC-GUIDE.md).

**New jobs need NO repeat GSC work** — the sitemap auto-generates from live jobs (hourly revalidate),
so Google discovers new roles on its own. Per-job "Request Indexing" is *optional* (only to speed a
fresh role from ~days to ~1 day).

**When a visible change won't show up yet:** title/snippet edits (like PR #31) appear only after Google
**recrawls** the page — days to ~2 weeks. To nudge: GSC → top search bar (URL Inspection) → paste the
URL → **Request indexing**.

**Monitor:** GSC → **Pages** (Indexing) report for indexed-vs-excluded; **Enhancements → Job postings**
for structured-data validity. Check weekly for the first month after any structural change.

---

## 5. If you add a NEW public/SEO surface to this platform

(e.g. a public blog, a marketing page, a new public portal)

1. **Server-render its content** (Server Component fetching server-side), seed any interactive child — never a bare client-fetch.
2. Add **per-page `<title>` + description** (`metadata` or `generateMetadata`) and **self-canonical**.
3. Add appropriate **JSON-LD** (`Article`, `Product`, `Organization`, …) via `safeJsonLd()`.
4. Add the route(s) to a **dynamic `sitemap.ts`**.
5. If it's a new subdomain, the existing **Domain property** in GSC already covers it — just submit its
   sitemap and Request-Index the key pages.
6. Run the **Googlebot `curl` checks** (§3) against the live URL.
7. Conversely: any **auth-gated** new page should set `robots: { index: false }` — don't let private app
   pages get indexed.

---

## Changelog

- **PR #31 (2026-06-10):** Dropped parent-company name from the jobs homepage `<title>`, OG/Twitter
  titles, and footer (now brand-only "Digital Sukoon"); kept it in JSON-LD `legalName`/`publisher` +
  hidden keywords. See §2. Frontend-only, no `db:push`.
- **PR #29 (commit `3720554`, 2026-06-06):** Converted jobs portal public pages to Server Components for
  indexability; added `lib/jobs.ts`, JobPosting/ItemList JSON-LD, per-job self-canonicals, dynamic
  sitemap; removed the duplicate-causing hardcoded canonical. GSC Domain property verified + sitemap
  submitted. See §1 and [JOBS-SEO-AND-GSC-GUIDE.md](JOBS-SEO-AND-GSC-GUIDE.md).
