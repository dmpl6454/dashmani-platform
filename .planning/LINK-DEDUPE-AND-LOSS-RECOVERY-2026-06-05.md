# Link de-dupe canonicalization + incremental-loss recovery — 2026-06-05

**Status: SHIPPED (PR #23, branch `fix/link-dedupe-canonical-and-loss-recovery`). Recovery applied to prod. No `db:push`.**

## Trigger

Kajal Yadav, Ayush Gupta, Pranay Dubey reported "links disappear when I paste" on the HR daily link-report. Read-only forensics on `dashmani_prod` found **two distinct phenomena** sharing one symptom:

1. **Correct dedupe, misread as a bug.** Kajal's 74-link paste contained 2 byte-identical duplicate lines → 72 stored. Working as designed (verified: stored report = exactly 72 distinct links). The "deleted in front of her" was the in-submission dedupe catching a true dup as she re-typed it. She could re-paste "the same 74" next day because Instagram regenerates `?igsh=` on every copy, so the full-URL dedupe key saw them as new.
2. **A genuine, separate data-loss bug** ("Anish" incremental-submit clobber, pre-fix). Heavy incremental submitters lost unique links: draft (`report_drafts.links_json`) held more than stored `report_links`. Confirmed: Nayan 76, Kajal 38, Fareen 19, Shamshad 2, + smaller. Root cause was client-side (form showed N+M, POST sent N); server never truncates.

## Fixes (commits db3ad14 code, a773d33 scripts)

### 1. `canonicalKey()` — content-id dedupe (`packages/shared/src/utils/canonical-url.ts`)
Collapses recognized platforms to a stable key so `?igsh=` variants of the same post dedupe correctly:
- `ig:<shortcode>` (reel/reels/p/tv), `yt:<videoId>` (watch/youtu.be/shorts/embed/live, reuses `extractYouTubeVideoId`), `fb:<numericId>` (reel/videos/watch?v= numeric ONLY).
- **IG shortcodes & YT ids kept case-sensitive** (lowercasing merges distinct posts). FB opaque `/share/r/…`, `pfbid`, `/posts/…` → **full-URL fallback** (never over-collapse; prod FB ~84% opaque). Unrecognized/non-URL/empty → `trim().toLowerCase()` (old behavior, zero change).
- Wired into all 5 dedupe sites; DB stores raw URLs, key computed fresh on read → **no migration**.
- Behavior locked by `apps/api/tests/canonical-url.test.ts` (14). See memory `feedback_canonical_url_dedupe`.

### 2. Server `submitDailyReport` (`apps/api/src/services/daily-report.service.ts`)
- Removed 400 `DUPLICATE_LINKS` throw → silent keep-first-merge (matches frontend; submit never blocked).
- Cross-day fetch rewritten: exact `url:{in:liveUrls}` (a no-op for igsh-varying IG) → 90-day windowed scan compared by canonicalKey (includes reportDate so the IST-day filter still excludes today's own links — no same-day self-drop).
- `priorFirstSeen` keyed by canonicalKey, earliest-wins → firstSeenAt survives igsh changes across resubmit.

### 3. Duplicate-removal UX (`apps/hr/src/app/report/page.tsx`)
- Replaced the small corner toast with a prominent centered `DedupeModal` listing each removed link grouped by reason ("pasted/typed twice just now" vs "already posted on `<date>`"), reassuring unique links are kept. Removal is still an immediate state update (no mid-fade row can be POSTed). Dropped the unreachable "already posted today" category (today's links are prefilled → re-paste is caught as in-submission).

## Data recovery (APPLIED to prod 2026-06-05, after `pg_dump` backup)

- `scripts/audit-lost-links.ts` (read-only) + `scripts/restore-lost-links.ts` (dry-run default, `--apply --confirm-prod`).
- Restored **115 links** into their ORIGINAL historical reports with their assigned channel and `firstSeenAt` = draft saved time (shows on the original day, employee does nothing): **Kajal +38 (→505), Nayan +56 (→156), Fareen +19 (→26), Shamshad +2 (→29)**.
- **Skipped (deliberate):** 20 no-account links (incl. Nayan's) — every link must carry its assigned channel; and all `stored=0` never-submitted drafts (Vicky 142, SATISH 29, Khushbu 22…) — restoring would fabricate work never submitted.
- Eligibility (all required): in-draft-not-stored + report exists that day (stored>0) + still-valid assigned account + parseable URL + canonicalKey not already present (idempotent) + past day (today hard-skipped; a same-day resubmit's delete-and-recreate would wipe a direct insert). Re-audit after apply: 0 restorable remaining for the four.

## Verify
- `npm run test -w @dashmani/api -- daily-report canonical-url` → 44 green (incl. Anish/removal/no-cap canaries + 7 new cases). `tsc --noEmit` clean on shared/api/hr. The ~36 analytics/content/task/team failures are the known pre-existing baseline (identical on clean main).
- Re-running the restore is idempotent (canonicalKey existence check). Rollback: `/tmp/backup_pre_linkrestore_*.sql` on Linode.
