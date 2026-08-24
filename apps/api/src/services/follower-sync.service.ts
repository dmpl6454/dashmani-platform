import { prisma } from "@dashmani/db";
import { todayIST, istMidnight } from "@dashmani/shared";
import {
  fetchInstagramFollowerMap,
  fetchFacebookFollowerMap,
  fetchPublicInstagramFollowerMap,
  fbLookupKeys,
} from "./social-insights/meta-followers";
import { fetchYouTubeSubscriberCounts } from "./social-insights/youtube-followers";
import { scrapeSnapchatFollowers, SC_SCRAPER_DELAY_MS } from "./social-insights/snapchat-scraper";
import { fetchTwitterFollowerMap } from "./social-insights/twitter-followers";

// DELAY_MS: 5s between scraper requests to avoid rate limiting.
// Tests can set FOLLOWER_SYNC_DELAY_MS=0 to skip the delay.
const DELAY_MS = parseInt(process.env.FOLLOWER_SYNC_DELAY_MS ?? "5000", 10);

// RATE_LIMIT_BACKOFF_MS: backoff after a 429/401 from the IG scraper before the
// single retry. Tests can set FOLLOWER_SYNC_BACKOFF_MS=0 to skip the wait.
const RATE_LIMIT_BACKOFF_MS = parseInt(process.env.FOLLOWER_SYNC_BACKOFF_MS ?? "30000", 10);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Meta (Facebook/Instagram) SCRAPERS — OFF by default since 2026-08-24.
 *
 * Owner decision: Account Growth is a connected-account-only surface, so a scraped
 * Meta follower count has no consumer. Leaving the scrapers on would keep writing
 * unverifiable numbers into the DB and burn ~5s of sleep per account per hour for
 * data nothing renders.
 *
 * ⚠️ This does NOT affect YouTube (official Data API), Snapchat or X — those keep
 * their existing behaviour and still feed the accounts list.
 * ⚠️ It also does NOT touch Top Links / Link Search, which legitimately still use
 * the older System-User app.
 *
 * Escape hatch: META_SCRAPERS_ENABLED=1 restores the previous behaviour.
 *
 * ⚠️ Read PER CALL, not once at module load. A module-scope `const` here made the
 * escape hatch unverifiable — the tests that cover the scraper path could not turn
 * it on, because the value was already baked in by the time they ran. Reading it
 * at the call site costs nothing and means the flag can actually be exercised.
 */
function metaScrapersEnabled(): boolean {
  return (process.env.META_SCRAPERS_ENABLED ?? "") === "1";
}

/**
 * Provenance of a follower count, persisted to SocialAccount.syncSource.
 *
 *   "api"     — an official platform API: Meta Graph (administered Pages/IG
 *               accounts, and IG business_discovery for public pro accounts) or
 *               the YouTube Data API. Exact, ToS-sanctioned numbers.
 *   "scraper" — parsed from a public page (Googlebot-UA FB/Snapchat scrapers,
 *               X guest-token). Best-effort: correct in practice but the source
 *               can change shape or wall us at any time.
 *
 * Accounts never auto-synced keep syncSource = null and read as hand-entered.
 * ⚠️ Keep this in step with the UI's SourceBadge — the pill is the only place
 * an admin can tell an exact number from a best-effort one.
 */
export type FollowerSyncSource = "api" | "scraper";

// In-memory progress so the UI can poll for a "syncing… X/Y" status
type SyncProgress = {
  state: "idle" | "running";
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  processed: number;
  updated: number;
  failed: number;
  skipped: number;
  lastError?: string;
};

let progress: SyncProgress = {
  state: "idle",
  startedAt: null,
  finishedAt: null,
  total: 0,
  processed: 0,
  updated: 0,
  failed: 0,
  skipped: 0,
};

export function getSyncProgress(): SyncProgress {
  return { ...progress };
}

/**
 * How long a run may stay "running" before the next caller is allowed to take over.
 *
 * ⚠️ WHY THIS EXISTS (2026-08-18 outage): the overlap guard below is a plain boolean
 * — `if (progress.state === "running") return`. On 2026-08-15 a run hung mid-flight
 * (a Meta call that never settled), `progress.state` stayed "running" FOREVER, and
 * every subsequent hourly tick silently no-opped. Instagram and YouTube went 3+ days
 * with ZERO syncs while the process sat "online"; only a deploy restart cleared it.
 * A boolean guard with no escape converts ONE hung run into a PERMANENT outage.
 *
 * 2h is deliberately well ABOVE a healthy run (the full sweep is minutes, and the
 * slowest observed real run is ~40 min at 5s/scraped-account) but well BELOW the
 * point where the gap is user-visible. Set it too low and a legitimately slow run
 * gets a concurrent partner — the exact overlap the guard exists to prevent.
 */
const STALE_RUN_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Cursor persistence for the rotating IG Tier-3 slice, stored in `system_settings`
 * (the same table + shape the insights cron uses for its per-tier cursors).
 *
 * Both helpers are FAIL-OPEN and never throw: a cursor is an optimisation for
 * FAIRNESS, not correctness. If the read fails we start from the head (some
 * accounts get re-attempted, none are lost); if the write fails the next run
 * simply re-attempts the same slice. Neither may be allowed to abort a sync.
 */
async function readSyncCursor(key: string): Promise<string> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key } });
    return row?.value ?? "";
  } catch {
    return "";
  }
}

async function writeSyncCursor(key: string, value: string): Promise<void> {
  try {
    await prisma.systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  } catch {
    /* fail-open: rotation resumes from the previous cursor next run */
  }
}

/** True when a "running" run started long enough ago to be considered abandoned. */
function isStaleRun(p: SyncProgress): boolean {
  if (p.state !== "running" || !p.startedAt) return false;
  const started = Date.parse(p.startedAt);
  // An unparseable timestamp is itself corruption — treat it as stale rather than
  // letting a bad value wedge the sync forever (the failure mode we are fixing).
  if (Number.isNaN(started)) return true;
  return Date.now() - started > STALE_RUN_MS;
}

function parseYouTubeSubscribers(text: string): number | null {
  // "553 thousand subscribers" → 553000, "1.08 million" → 1080000
  const match = text.match(/([\d,.]+)\s*(thousand|million|billion|lakh|crore)?/i);
  if (!match) return null;
  let num = parseFloat(match[1].replace(/,/g, ""));
  const unit = (match[2] || "").toLowerCase();
  if (unit === "thousand") num *= 1000;
  else if (unit === "lakh") num *= 100000;
  else if (unit === "million") num *= 1000000;
  else if (unit === "crore") num *= 10000000;
  else if (unit === "billion") num *= 1000000000;
  return Math.round(num);
}

let igRateLimited = false;

async function fetchInstagramFollowers(username: string): Promise<number | null> {
  // If we already know we're rate limited this run, skip immediately
  if (igRateLimited) return null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
        {
          headers: {
            "User-Agent": "Instagram 275.0.0.27.98",
            "X-IG-App-ID": "936619743392459",
          },
        },
      );
      if (res.status === 429 || res.status === 401) {
        if (attempt === 0) {
          console.log(`[follower-sync] Instagram rate limited for ${username}, waiting ${RATE_LIMIT_BACKOFF_MS}ms...`);
          await sleep(RATE_LIMIT_BACKOFF_MS);
          continue;
        }
        // Still limited after retry — mark all Instagram as skipped for this run
        console.log(`[follower-sync] Instagram still blocked, skipping remaining Instagram accounts`);
        igRateLimited = true;
        return null;
      }
      if (!res.ok) return null;
      const data = await res.json() as any;
      return data?.data?.user?.edge_followed_by?.count ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchYouTubeSubscribers(profileUrl: string): Promise<number | null> {
  try {
    const res = await fetch(profileUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    });
    if (!res.ok) return null;
    const html = await res.text();

    // The channel's OWN subscriber count is rendered inside
    // pageHeaderRenderer → contentMetadataViewModel → metadataParts as an
    // `accessibilityLabel`.  In practice this is the ONLY `accessibilityLabel`
    // on the page that mentions "subscribers" (the related-channels sidebar
    // uses `subscriberCountText` instead).  Match the label directly.
    const accLabel = html.match(/"accessibilityLabel":"([^"]*\bsubscribers?\b[^"]*)"/i);
    if (accLabel) return parseYouTubeSubscribers(accLabel[1]);

    // Fallback to the older sidebar-style key for alternate YT layouts.
    // NOTE: on the current YT layout this returns the wrong (sidebar)
    // channel's count, so it's only useful as a "better than null" guard.
    const fallback = html.match(/"subscriberCountText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+)"/);
    if (fallback) return parseYouTubeSubscribers(fallback[1]);
    return null;
  } catch {
    return null;
  }
}

function parseFollowerCount(text: string): number | null {
  // handles "14M", "1.2K", "553,000", "14,000,000", "553 thousand", "1,41,63,052", etc.
  const clean = text.replace(/,/g, "").trim();
  const match = clean.match(/^([\d.]+)\s*([KkMmBbLl]|thousand|million|billion|lakh|crore)?/i);
  if (!match) return null;
  let num = parseFloat(match[1]);
  const unit = (match[2] || "").toLowerCase();
  if (unit === "k") num *= 1000;
  else if (unit === "m") num *= 1000000;
  else if (unit === "b") num *= 1000000000;
  else if (unit === "l") num *= 100000;
  else if (unit === "thousand") num *= 1000;
  else if (unit === "lakh") num *= 100000;
  else if (unit === "million") num *= 1000000;
  else if (unit === "crore") num *= 10000000;
  return isNaN(num) ? null : Math.round(num);
}

function extractHandle(profileUrl: string, platform: string): string {
  try {
    const url = new URL(profileUrl.split("?")[0].replace(/\/$/, ""));
    const parts = url.pathname.split("/").filter(Boolean);
    // facebook.com/paparazzziii or facebook.com/pages/name/id
    if (platform === "facebook" && parts[0] === "pages" && parts.length >= 2) return parts[1];
    return parts[parts.length - 1] || "";
  } catch {
    return "";
  }
}

// Devanagari → ASCII digit map.  Facebook localises Indian pages so the
// follower count comes back as "१,४१,६३,०५२" instead of "14,163,052".
const DEVANAGARI_DIGIT_MAP: Record<string, string> = {
  "०": "0", "१": "1", "२": "2", "३": "3", "४": "4",
  "५": "5", "६": "6", "७": "7", "८": "8", "९": "9",
};

function devanagariToAscii(input: string): string {
  return input.replace(/[०-९]/g, (d) => DEVANAGARI_DIGIT_MAP[d] || d);
}

function decodeHtmlEntities(s: string): string {
  return s.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
          .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
          .replace(/&amp;/g, "&")
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'");
}

async function fetchPageHtml(url: string, userAgent?: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": userAgent || "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

// A real m.facebook.com profile page (og:description + full mobile markup) runs
// tens of KB. A walled/interstitial page (login wall, checkpoint, error shell)
// can still be served with a 200 status but is much shorter — same lesson the
// sibling scrapers already learned (facebook-scraper.ts's MIN_REEL_HTML_LEN,
// snapchat-scraper.ts's MIN_PAGE_LEN): reject on body length BEFORE parsing.
const MIN_MOBILE_FB_HTML_LEN = 20_000;

async function fetchFacebookFollowers(profileUrl: string, handle: string): Promise<number | null> {
  // Live-verified 2026-07-10 (from the actual prod server, against real prod FB
  // pages): Facebook has tightened logged-out access and the www.facebook.com/
  // <slug> vanity-URL Googlebot path now serves a login wall for many pages.
  // BUT numeric-ID profiles (facebook.com/profile.php?id=<n>) have a still-
  // working alternate: the lightweight MOBILE site (m.facebook.com) with a
  // mobile Safari UA (not Googlebot) returns an un-walled page whose
  // og:description carries the follower/like count. 150/155 real prod accounts
  // resolved via this exact method. Try it FIRST for numeric-ID URLs; on any
  // miss, fall through to the existing vanity-slug Googlebot path below (which
  // is a harmless no-op fallback for a pure numeric ID with no slug).
  const numericIdMatch = profileUrl.match(/profile\.php\?id=(\d+)/);
  if (numericIdMatch) {
    const id = numericIdMatch[1];
    const mobileHtml = await fetchPageHtml(
      `https://m.facebook.com/profile.php?id=${id}&locale=en_US`,
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    );
    // fetchPageHtml only checks res.ok — a walled/interstitial page can still
    // return HTTP 200, so reject a short body BEFORE parsing (never trust length
    // alone as a guarantee of real content, but a short body is never real content).
    if (mobileHtml && mobileHtml.length >= MIN_MOBILE_FB_HTML_LEN) {
      const ogDesc = mobileHtml.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
      if (ogDesc) {
        const decoded = devanagariToAscii(decodeHtmlEntities(ogDesc[1]));
        // Mobile format is "Name. N,NNN likes · ..." — REQUIRE the count to be
        // anchored to "likes"/"followers"/"people". Unlike the vanity-slug path
        // below, this branch does NOT fall back to "first number sequence": an
        // unanchored number (e.g. a year, a phone fragment, or any incidental
        // digits on a walled/interstitial page) must never be mistaken for a
        // follower count and persisted. If unanchored, fall through to the
        // vanity-slug path below (the existing safety net), not to a guess.
        const anchoredMatch = decoded.match(/([\d,]+)\s*(?:likes|followers|people)/i);
        if (anchoredMatch) {
          const parsed = parseFollowerCount(anchoredMatch[1]);
          if (parsed && parsed > 0) return parsed;
        }
      }
    }
  }

  // FB blocks default UAs and returns HTTP 400 on mbasic without a cookie.
  // Googlebot UA is the only reliable way to get the public, un-walled page.
  const slug = extractHandle(profileUrl, "facebook") || handle.replace(/^@/, "").split("?")[0];
  if (!slug) return null;

  const html = await fetchPageHtml(
    `https://www.facebook.com/${encodeURIComponent(slug)}`,
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  );
  if (!html) return null;

  // 1) og:description meta tag — most reliable, format example for Indian pages:
  //    "Paparazzii.&#x967;,&#x96a;&#x967;,&#x96c;&#x969;,&#x966;&#x96b;&#x968; आवडी · ..."
  //    where the Devanagari digits decode to "1,41,63,052 likes (followers)"
  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i);
  if (ogDesc) {
    const decoded = devanagariToAscii(decodeHtmlEntities(ogDesc[1]));
    // Match the first number sequence (may use Indian "1,41,63,052" or Western "14,163,052")
    const numMatch = decoded.match(/([\d,]+)/);
    if (numMatch) {
      const parsed = parseFollowerCount(numMatch[1]);
      if (parsed && parsed > 0) return parsed;
    }
  }

  // 2) JSON / inline patterns for English / pages without an og:description count
  const patterns = [
    /"follower_count"\s*:\s*(\d+)/,
    /"followers_count"\s*:\s*(\d+)/,
    /(\d[\d,.]*[KkMmBb]?)\s*(?:followers|people follow)/i,
    /(\d[\d,.]*[KkMmBb]?)\s*likes/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const parsed = parseFollowerCount(m[1]);
      if (parsed && parsed > 0) return parsed;
    }
  }
  return null;
}

// snapchat / pinterest / telegram / tiktok / linkedin / twitter — these
// platforms either render entirely on the client (TikTok), gate everything
// behind auth (LinkedIn returns HTTP 999 on bot UAs), or have unreliable proxy
// scrapers (Twitter via nitter is mostly dead).  Skipped — admins should enter
// counts manually for those.

export async function syncAllFollowerCounts() {
  // Don't allow overlapping runs — but NEVER let a wedged run block forever.
  // See STALE_RUN_MS: a hung run used to pin state="running" permanently, silently
  // killing every future hourly tick until someone restarted the process.
  if (progress.state === "running") {
    if (!isStaleRun(progress)) return progress;
    console.warn(
      `[follower-sync] WATCHDOG: previous run has been "running" since ${progress.startedAt} ` +
        `(> ${STALE_RUN_MS / 60000} min) and is presumed dead at ${progress.processed}/${progress.total} ` +
        `processed. Taking over. If this repeats, a provider call is hanging without a timeout.`,
    );
    // Fall through and start a fresh run. The abandoned run's async work may still
    // be in flight; that is acceptable — every write goes through persistFollowerCount,
    // which is an idempotent upsert on (accountId, date), so a late straggler can only
    // re-write the same row with an equal-or-newer count. It can never corrupt state.
  }

  // ⚠️ CLAIM THE GUARD SYNCHRONOUSLY, BEFORE THE FIRST `await`.
  // The check above and the full `progress = {...}` reset below are separated by
  // several awaits (two Graph map builds + findMany). Marking "running" only at
  // that reset left a check-then-act (TOCTOU) window in which a second concurrent
  // call saw state="idle" and started a duplicate sync — two runs writing the same
  // accounts and double-spending the shared Meta budget. Every `await` is a yield
  // point; being single-threaded does not make this atomic. Setting state here
  // makes the claim atomic with respect to other callers, since no other code can
  // interleave before the first await.
  progress.state = "running";
  progress.startedAt = new Date().toISOString();
  progress.finishedAt = null;

  igRateLimited = false;

  // Build the Meta Graph follower maps ONCE per run (single batched discovery
  // call each). Graph-first source for IG/FB; the legacy scrapers stay as the
  // per-account fallback when the map has no entry. Guarded so a throw leaves the
  // map empty — an empty map is exactly the local/dark-switch case, where the
  // loop falls back to the scrapers and behaviour is unchanged. NEVER throws here.
  let igFollowerMap = new Map<string, { followers: number; following: number | null; posts: number | null }>();
  let fbFollowerMap = new Map<string, { followers: number }>();
  try { igFollowerMap = await fetchInstagramFollowerMap(); } catch (e) { console.error("[follower-sync] IG graph map failed:", e); }
  try { fbFollowerMap = await fetchFacebookFollowerMap(); } catch (e) { console.error("[follower-sync] FB graph map failed:", e); }

  const accounts = await prisma.socialAccount.findMany({
    where: { profileUrl: { not: "" } },
    include: { platform: { select: { slug: true } } },
  });

  progress = {
    state: "running",
    // KEEP the startedAt stamped at the top of the run, don't restamp it here.
    // The watchdog measures staleness from it, and the slow part we most need to
    // detect (the Graph map builds) happens BEFORE this point — restamping would
    // hide exactly the hang we are trying to catch.
    startedAt: progress.startedAt ?? new Date().toISOString(),
    finishedAt: null,
    total: accounts.length,
    processed: 0,
    updated: 0,
    failed: 0,
    skipped: 0,
  };

  // IST midnight — consistent with account-growth.service.ts so the
  // (accountId, date) snapshot upsert is idempotent across both writers.
  const today = istMidnight(todayIST());

  // ── Shared write helper — DRY, identical semantics for all three tiers ────
  //
  // Guards: followers must be > 0. Never overwrites a good value with 0/null.
  // Uses the IST midnight date key so the (accountId, date) upsert is idempotent
  // regardless of which tier writes first.
  async function persistFollowerCount(
    account: { id: string; handle: string; platform: { slug: string } },
    followers: number,
    source: FollowerSyncSource,
  ) {
    if (followers <= 0) return;
    console.log(`[follower-sync] ${account.platform.slug}/${account.handle}: ${followers} (${source})`);
    await prisma.socialAccount.update({
      where: { id: account.id },
      data: { followerCount: followers, lastSyncedAt: new Date(), syncSource: source },
    });
    const existing = await prisma.accountGrowthSnapshot.findUnique({
      where: { accountId_date: { accountId: account.id, date: today } },
    });
    // Stamp HOW the point was measured. The column existed but no writer ever
    // populated it, so every historical snapshot reads as NULL and a reader cannot
    // tell an exact API figure from a best-effort scrape. Recording it lets a
    // later reader refuse to measure growth across a change of method.
    if (existing) {
      await prisma.accountGrowthSnapshot.update({
        where: { id: existing.id },
        data: { followerCount: followers, source },
      });
    } else {
      await prisma.accountGrowthSnapshot.create({
        data: { accountId: account.id, date: today, followerCount: followers, source },
      });
    }
    progress.updated++;
  }

  // ── Tier-3 collection buckets (filled during the first pass) ─────────────
  //
  // Accounts that Tier 1 (administered map + scraper) could not resolve are
  // collected here, grouped by platform. After the first pass, a single batched
  // call per platform tries to fill the gaps via the public-API tier.
  const unresolvedIg: typeof accounts = [];
  const unresolvedYt: typeof accounts = [];
  // FB unresolved accounts reuse the EXISTING fbFollowerMap via fbLookupKeys
  // (the name-keyed map added in commit f967ac1 already covers display-name
  // accounts); no second network call is needed for FB.
  const unresolvedFb: typeof accounts = [];
  // X/Twitter has no Tier-1 map at all (unlike IG/FB) — every "x" account
  // goes straight to this bucket in the first pass, then Tier-3 resolves the
  // whole batch via one guest-token GraphQL session.
  const unresolvedTw: typeof accounts = [];

  // ── First pass: administered map, then scraper ────────────────────────────

  for (const account of accounts) {
    const slug = account.platform.slug;
    let followers: number | null = null;
    // Provenance of whatever `followers` ends up holding. Set by each branch at
    // the moment it resolves — the FB branch in particular can land on either
    // the Graph map or the scraper, so it MUST be assigned per-resolution and
    // never inferred from the platform afterwards.
    let source: FollowerSyncSource = "api";

    if (slug === "instagram") {
      let username = account.handle.replace(/^@/, "").split("?")[0].split("/")[0].trim();
      if (!username && account.profileUrl) {
        username = account.profileUrl.match(/instagram\.com\/([^/?]+)/)?.[1] || "";
      }
      if (username) {
        // Graph-first (single batched call, no sleep). The legacy
        // fetchInstagramFollowers() logged-out scraper is intentionally NOT
        // called here: IG blocks logged-out scraping, so it can NEVER resolve a
        // non-administered account — it just 429s (a 30s backoff on the first
        // hit + a 5s sleep per account), trips igRateLimited, and returns null
        // for the rest. With ~109 unresolved IG accounts that was ~9+ min of
        // dead delay BEFORE Tier-3 (business_discovery, the reliable resolver)
        // even ran. So on a map miss we leave followers=null and let the account
        // fall through to unresolvedIg → Tier-3. (Mirrors the YouTube branch
        // below; the scraper stays defined for syncSingleAccountFollowers.)
        const entry = igFollowerMap.get(username.toLowerCase());
        if (entry) {
          followers = entry.followers;
        }
      }
    } else if (slug === "youtube") {
      // YouTube scraper removed in favour of the Data API v3 resolver (Tier 3).
      // The legacy fetchYouTubeSubscribers() is kept for syncSingleAccountFollowers
      // but is intentionally NOT called here — the per-scrape-with-sleep approach
      // was O(accounts) HTTP requests; the batched API call is far cheaper.
      // All YouTube accounts go directly to the Tier-3 bucket.
    } else if (slug === "facebook") {
      if (account.profileUrl || account.handle) {
        // Graph-first: try fbLookupKeys (id, username slug, display name) against
        // the administered-page map. The map is now name-keyed (commit f967ac1),
        // so stale rows stored under a display name (e.g. "Bollywood Society") also
        // match here without any new network call.
        const candidateKeys = fbLookupKeys(account.handle, account.profileUrl || "");
        let entry: { followers: number } | undefined;
        for (const key of candidateKeys) {
          entry = fbFollowerMap.get(key);
          if (entry) break;
        }
        if (entry) {
          followers = entry.followers; // administered Page via Graph → exact
        } else if (metaScrapersEnabled()) {
          // Legacy path, DISABLED BY DEFAULT since 2026-08-24 (owner decision).
          // Account Growth now shows only API-verified channels, so a scraped
          // Facebook number has no consumer — it would just be unverifiable data
          // written to the DB and 5s of sleep per account for nothing.
          // Set META_SCRAPERS_ENABLED=1 to restore the old behaviour.
          followers = await fetchFacebookFollowers(account.profileUrl || "", account.handle);
          source = "scraper";
          await sleep(DELAY_MS);
        } else {
          // Not administered and scraping is off ⇒ leave the stored value untouched.
          // We do NOT zero it: the number is not false, it is simply unverifiable,
          // and other surfaces (the accounts list) still display it.
          progress.skipped++;
          progress.processed++;
          continue;
        }
      }
    } else if (slug === "snapchat") {
      // Snapchat follower counts live on the account's PUBLIC PROFILE page. Our
      // accounts are `/t/<code>` share links (in profile_url) that resolve to a
      // `snapchat.com/p/<uuid>` page — NOT `/add/<handle>` (that 404s). The scraper
      // tries profile_url FIRST, then legacy /add/ handle fallbacks, all with a
      // Googlebot UA. Live-verified from the Linode IP 2026-07-01.
      // ⚠️ Fail-open: returns null on any miss (we keep the existing value, never zero it).
      // Kill switch: SC_SCRAPER_ENABLED=0
      const scHandle = account.handle.replace(/^@/, "").split("?")[0].trim();
      const result = await scrapeSnapchatFollowers(scHandle, fetch, account.profileUrl);
      if (result.followers && result.followers > 0) {
        followers = result.followers;
        source = "scraper"; // Snapchat has no follower API at all
      }
      await sleep(SC_SCRAPER_DELAY_MS);
      if (followers === null) {
        // No count recoverable (dead share link + no /add/ profile). Keep the
        // existing manual value; count as skipped, do not overwrite with 0.
        progress.skipped++;
        progress.processed++;
        continue;
      }
    } else if (slug === "x") {
      // No Tier-1 map for X (unlike IG/FB) — every "x" account is deferred to
      // the batched Tier-3 guest-token GraphQL pass below, which resolves the
      // whole unresolvedTw bucket in one guest-token session. Do NOT resolve
      // here; just collect and let the post-loop `followers === null` branch
      // push this account onto unresolvedTw like IG/YT do.
      unresolvedTw.push(account);
      progress.processed++;
      continue;
    } else {
      // tiktok, linkedin, pinterest, telegram — manual entry only
      progress.skipped++;
      progress.processed++;
      continue;
    }

    if (followers !== null && followers > 0) {
      await persistFollowerCount(account, followers, source);
    } else {
      // Collect for the Tier-3 pass; don't increment failed yet.
      if (slug === "instagram") unresolvedIg.push(account);
      else if (slug === "youtube") unresolvedYt.push(account);
      else if (slug === "facebook") unresolvedFb.push(account);
      else progress.failed++; // should never reach (handled by the else-skip above)
    }
    progress.processed++;
  }

  // ── Tier-3: public-API pass for unresolved accounts ──────────────────────
  //
  // Each resolver is wrapped in try/catch so a throw from one platform can
  // NEVER abort the sync or leave other platforms untouched. Fail-open contract.

  // — Instagram: business_discovery edge ————————————————————————————————————
  // fetchPublicInstagramFollowerMap internally re-discovers one administered IG
  // node via me/accounts (~1 cheap call) AND fires ONE business_discovery call
  // PER handle. To protect the shared ~200-call/hr Meta budget (also used by the
  // harvest cron):
  //   • Only invoke Tier-3 if Tier-1 actually worked (igFollowerMap.size > 0).
  //     An EMPTY igFollowerMap means Meta is unavailable/rate-limiting this token
  //     this run (Tier-1's catch left it empty) — firing one call per unresolved
  //     handle would pile onto an already-limited token and starve the harvest.
  //     When skipped, the unresolved IG accounts simply stay as-is (fail-open)
  //     and retry next hour — we do NOT count them as failed (deliberate skip,
  //     not an attempted-and-missed resolution).
  //   • Cap the handles slice at 30 — belt-and-suspenders for a large unresolved
  //     tail even when Tier-1 partially succeeded. Accounts beyond the cap are
  //     DEFERRED to a future run, NOT counted as failed (not attempted this run).
  //   • ⚠️ ROTATE that slice across runs (added 2026-08-18). It used to be a bare
  //     `slice(0, 30)` over an arbitrarily-ordered array, so the SAME first 30
  //     handles were retried every hour forever and the remaining tail — ~78 of
  //     ~110 external IG accounts on prod — was NEVER attempted even once. Those
  //     accounts showed as "manual" on Account Growth purely because the resolver
  //     never reached them. Same class as the PR #130 cursorless-tier starvation.
  //     The cursor is a HIGH-WATER MARK over a STABLE ORDER (by id): resume after
  //     the last id attempted, wrap at the end. That guarantees every account is
  //     reached within ceil(n / 30) runs — a property a random or offset-based
  //     pick cannot promise.
  const IG_TIER3_MAX_HANDLES = 30;
  const IG_TIER3_CURSOR_KEY = "follower-sync-cursor:ig-tier3";
  if (unresolvedIg.length > 0 && igFollowerMap.size > 0) {
    // Stable order so the cursor means the same thing from run to run.
    const ordered = [...unresolvedIg].sort((a, b) => a.id.localeCompare(b.id));
    const cursor = await readSyncCursor(IG_TIER3_CURSOR_KEY);
    // Resume strictly AFTER the last-attempted id. An unknown/stale cursor (the
    // account was resolved or deleted since) yields -1 → start from the head,
    // which is the correct fallback rather than skipping the whole run.
    const startIdx = cursor ? ordered.findIndex((a) => a.id > cursor) : 0;
    const from = startIdx < 0 ? 0 : startIdx;
    // Wrap around the end so a cursor near the tail still fills its full quota
    // instead of attempting a handful and idling.
    const attempted =
      ordered.length <= IG_TIER3_MAX_HANDLES
        ? ordered
        : [...ordered.slice(from), ...ordered.slice(0, from)].slice(0, IG_TIER3_MAX_HANDLES);
    console.log(
      `[follower-sync] IG Tier-3: attempting ${attempted.length} of ${ordered.length} unresolved ` +
        `(rotating from index ${from}${cursor ? `, after id ${cursor}` : ", head"}).`,
    );
    try {
      const handles = attempted
        .map((a) => a.handle.replace(/^@/, "").split("?")[0].split("/")[0].trim())
        .filter(Boolean);
      const publicIgMap = await fetchPublicInstagramFollowerMap(handles);
      // Only count failed for accounts we actually attempted (the slice), not the
      // deferred tail beyond the cap.
      for (const account of attempted) {
        const handle = account.handle.replace(/^@/, "").split("?")[0].split("/")[0].trim().toLowerCase();
        const entry = publicIgMap.get(handle);
        if (entry && entry.followers > 0) {
          // business_discovery is the official Graph edge (public pro accounts),
          // so this is an exact API number even though we don't administer it.
          await persistFollowerCount(account, entry.followers, "api");
        } else {
          progress.failed++;
        }
      }
    } catch (e) {
      console.error("[follower-sync] Public IG resolver failed — skipping IG Tier-3:", e);
      // Only the attempted slice is counted as failed; the deferred tail is not.
      progress.failed += attempted.length;
    } finally {
      // ⚠️ Advance the cursor in `finally` — on SUCCESS *and* on FAILURE. If it only
      // advanced on success, a batch that fails every run (a handle Meta always
      // rejects, a transient outage) would pin the cursor and re-attempt the same 30
      // forever — re-creating the exact starvation this rotation exists to fix.
      // Rotation must be driven by "attempted", never by "succeeded".
      if (attempted.length > 0) {
        await writeSyncCursor(IG_TIER3_CURSOR_KEY, attempted[attempted.length - 1].id);
      }
    }
  }

  // — Facebook: fbLookupKeys against the EXISTING administered map ——————————
  // No new network call — we reuse fbFollowerMap (now name-keyed). Accounts
  // whose handle is a display name (e.g. "Bollywood Society") now resolve via
  // the name key without hitting the network again.
  for (const account of unresolvedFb) {
    const candidateKeys = fbLookupKeys(account.handle, account.profileUrl || "");
    let entry: { followers: number } | undefined;
    for (const key of candidateKeys) {
      entry = fbFollowerMap.get(key);
      if (entry) break;
    }
    if (entry && entry.followers > 0) {
      await persistFollowerCount(account, entry.followers, "api"); // administered Page map
    } else {
      progress.failed++;
    }
  }

  // — YouTube: Data API v3 (channels.list, forHandle, search.list) ——————————
  // Note: progress.processed is already incremented for YouTube accounts in the
  // first pass (where they are collected into unresolvedYt). Do NOT increment it
  // again here.
  if (unresolvedYt.length > 0) {
    try {
      const ytResults = await fetchYouTubeSubscriberCounts(
        unresolvedYt.map((a) => ({ id: a.id, handle: a.handle, profileUrl: a.profileUrl || "" })),
        { maxSearchLookups: 10 },
      );
      // Index results by accountId for O(1) lookup
      const ytMap = new Map(ytResults.map((r) => [r.accountId, r.subscribers]));
      for (const account of unresolvedYt) {
        const subscribers = ytMap.get(account.id);
        if (subscribers != null && subscribers > 0) {
          await persistFollowerCount(account, subscribers, "api"); // YouTube Data API v3
        } else {
          progress.failed++;
        }
      }
    } catch (e) {
      console.error("[follower-sync] YouTube resolver failed — skipping YT Tier-3:", e);
      progress.failed += unresolvedYt.length;
    }
  }

  // — X/Twitter: anonymous guest-token GraphQL (UserByScreenName) ——————————
  // Note: progress.processed is already incremented for X accounts in the
  // first pass (where they are collected into unresolvedTw). Do NOT increment
  // it again here. Mirrors the YouTube Tier-3 shape above.
  if (unresolvedTw.length > 0) {
    try {
      const handles = unresolvedTw.map((a) => a.handle.replace(/^@/, "").split("?")[0].trim());
      const twMap = await fetchTwitterFollowerMap(handles);
      for (const account of unresolvedTw) {
        const handle = account.handle.replace(/^@/, "").split("?")[0].trim().toLowerCase();
        const followers = twMap.get(handle);
        if (followers != null && followers > 0) {
          // Guest-token GraphQL — an unauthenticated public read, not an official
          // API product (X has no free follower API), so it counts as scraping.
          await persistFollowerCount(account, followers, "scraper");
        } else {
          progress.failed++;
        }
      }
    } catch (e) {
      console.error("[follower-sync] X/Twitter resolver failed — skipping X Tier-3:", e);
      progress.failed += unresolvedTw.length;
    }
  }

  progress.state = "idle";
  progress.finishedAt = new Date().toISOString();
  return { total: progress.total, updated: progress.updated, failed: progress.failed, skipped: progress.skipped };
}

// Sync a single account (for on-demand refresh)
export async function syncSingleAccountFollowers(accountId: string) {
  // Reset the module-level IG rate-limit flag: a user-initiated single refresh
  // must always attempt the network, independent of a prior/concurrent batch
  // run that may have set igRateLimited=true mid-run. Otherwise the refresh
  // button would silently no-op (return null) without ever hitting Instagram.
  igRateLimited = false;

  const account = await prisma.socialAccount.findUnique({
    where: { id: accountId },
    include: { platform: { select: { slug: true } } },
  });
  if (!account) return null;

  let followers: number | null = null;
  const slug = account.platform.slug;
  // This interactive path deliberately avoids building the Graph maps (see below),
  // so IG/FB/Snapchat/X all resolve via scrapers here. Only YouTube uses a real
  // API. Each branch sets this so the pill reflects how THIS refresh resolved —
  // a manual refresh can legitimately downgrade an account's badge from api to
  // scraper, which is honest: that IS where the displayed number came from.
  let source: FollowerSyncSource = "scraper";

  // Single-account refresh uses the scraper directly — building the full Graph
  // account map (all ~38 IG / ~87 FB) to read ONE account would waste the shared
  // Meta rate budget on this user-interactive path (the per-account refresh
  // button). The hourly batch sync (syncAllFollowerCounts) gets Graph coverage,
  // where the map is built once for ALL accounts and is efficient.
  if (slug === "instagram") {
    const username = account.handle.replace(/^@/, "") || account.profileUrl?.match(/instagram\.com\/([^/?]+)/)?.[1];
    if (username) followers = await fetchInstagramFollowers(username);
  } else if (slug === "youtube") {
    if (account.profileUrl) {
      followers = await fetchYouTubeSubscribers(account.profileUrl);
      if (followers !== null) source = "api"; // YouTube Data API v3
    }
  } else if (slug === "facebook") {
    followers = await fetchFacebookFollowers(account.profileUrl || "", account.handle);
  } else if (slug === "snapchat") {
    // profile_url (a /t/ or /p/ link) is tried FIRST by the scraper — that's where
    // the count lives; /add/<handle> 404s for our accounts. See snapchat-scraper.ts.
    const scHandle = account.handle.replace(/^@/, "").split("?")[0].trim();
    const result = await scrapeSnapchatFollowers(scHandle, fetch, account.profileUrl);
    followers = result.followers;
  } else if (slug === "x") {
    // fetchTwitterFollowerMap activates a fresh guest token per call — calling
    // it here for a single handle is a little wasteful (one token activation
    // for one lookup) but that's fine and consistent with how the other
    // single-account branches above already work (direct network call, not
    // batch-map reuse). Normalization MUST match the batch Tier-3 path in
    // syncAllFollowerCounts exactly (strip leading @, drop query string, trim,
    // then lowercase for the map lookup — the map itself is keyed lowercase in
    // fetchTwitterFollowerMap) so a manual refresh resolves the same handle the
    // hourly cron would.
    const xHandle = account.handle.replace(/^@/, "").split("?")[0].trim();
    if (xHandle) {
      const twMap = await fetchTwitterFollowerMap([xHandle]);
      followers = twMap.get(xHandle.toLowerCase()) ?? null;
    }
  }
  // Other platforms: no automated sync; admin must enter the count manually.

  if (followers !== null && followers > 0) {
    await prisma.socialAccount.update({
      where: { id: accountId },
      data: { followerCount: followers, lastSyncedAt: new Date(), syncSource: source },
    });

    // IST midnight — consistent with account-growth.service.ts / the batch sync.
    const today = istMidnight(todayIST());
    const existing = await prisma.accountGrowthSnapshot.findUnique({
      where: { accountId_date: { accountId, date: today } },
    });
    if (existing) {
      await prisma.accountGrowthSnapshot.update({ where: { id: existing.id }, data: { followerCount: followers } });
    } else {
      await prisma.accountGrowthSnapshot.create({ data: { accountId, date: today, followerCount: followers } });
    }

    return { accountId, handle: account.handle, followers, updated: true };
  }

  return { accountId, handle: account.handle, followers: null, updated: false };
}
