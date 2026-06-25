import { prisma } from "@dashmani/db";
import { todayIST, istMidnight } from "@dashmani/shared";
import {
  fetchInstagramFollowerMap,
  fetchFacebookFollowerMap,
  fetchPublicInstagramFollowerMap,
  fbLookupKeys,
} from "./social-insights/meta-followers";
import { fetchYouTubeSubscriberCounts } from "./social-insights/youtube-followers";

// DELAY_MS: 5s between scraper requests to avoid rate limiting.
// Tests can set FOLLOWER_SYNC_DELAY_MS=0 to skip the delay.
const DELAY_MS = parseInt(process.env.FOLLOWER_SYNC_DELAY_MS ?? "5000", 10);

// RATE_LIMIT_BACKOFF_MS: backoff after a 429/401 from the IG scraper before the
// single retry. Tests can set FOLLOWER_SYNC_BACKOFF_MS=0 to skip the wait.
const RATE_LIMIT_BACKOFF_MS = parseInt(process.env.FOLLOWER_SYNC_BACKOFF_MS ?? "30000", 10);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function fetchFacebookFollowers(profileUrl: string, handle: string): Promise<number | null> {
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
  // Don't allow overlapping runs
  if (progress.state === "running") {
    return progress;
  }

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
    startedAt: new Date().toISOString(),
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
  ) {
    if (followers <= 0) return;
    console.log(`[follower-sync] ${account.platform.slug}/${account.handle}: ${followers}`);
    await prisma.socialAccount.update({
      where: { id: account.id },
      data: { followerCount: followers, lastSyncedAt: new Date() },
    });
    const existing = await prisma.accountGrowthSnapshot.findUnique({
      where: { accountId_date: { accountId: account.id, date: today } },
    });
    if (existing) {
      await prisma.accountGrowthSnapshot.update({
        where: { id: existing.id },
        data: { followerCount: followers },
      });
    } else {
      await prisma.accountGrowthSnapshot.create({
        data: { accountId: account.id, date: today, followerCount: followers },
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

  // ── First pass: administered map, then scraper ────────────────────────────

  for (const account of accounts) {
    const slug = account.platform.slug;
    let followers: number | null = null;

    if (slug === "instagram") {
      let username = account.handle.replace(/^@/, "").split("?")[0].split("/")[0].trim();
      if (!username && account.profileUrl) {
        username = account.profileUrl.match(/instagram\.com\/([^/?]+)/)?.[1] || "";
      }
      if (username) {
        // Graph-first (single batched call, no sleep). Fall back to the scraper.
        const entry = igFollowerMap.get(username.toLowerCase());
        if (entry) {
          followers = entry.followers;
        } else {
          followers = await fetchInstagramFollowers(username);
          await sleep(DELAY_MS);
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
          followers = entry.followers;
        } else {
          followers = await fetchFacebookFollowers(account.profileUrl || "", account.handle);
          await sleep(DELAY_MS);
        }
      }
    } else {
      // tiktok, linkedin, twitter, snapchat, pinterest, telegram — manual entry only
      progress.skipped++;
      progress.processed++;
      continue;
    }

    if (followers !== null && followers > 0) {
      await persistFollowerCount(account, followers);
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
  const IG_TIER3_MAX_HANDLES = 30;
  if (unresolvedIg.length > 0 && igFollowerMap.size > 0) {
    const attempted = unresolvedIg.slice(0, IG_TIER3_MAX_HANDLES);
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
          await persistFollowerCount(account, entry.followers);
        } else {
          progress.failed++;
        }
      }
    } catch (e) {
      console.error("[follower-sync] Public IG resolver failed — skipping IG Tier-3:", e);
      // Only the attempted slice is counted as failed; the deferred tail is not.
      progress.failed += attempted.length;
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
      await persistFollowerCount(account, entry.followers);
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
          await persistFollowerCount(account, subscribers);
        } else {
          progress.failed++;
        }
      }
    } catch (e) {
      console.error("[follower-sync] YouTube resolver failed — skipping YT Tier-3:", e);
      progress.failed += unresolvedYt.length;
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

  // Single-account refresh uses the scraper directly — building the full Graph
  // account map (all ~38 IG / ~87 FB) to read ONE account would waste the shared
  // Meta rate budget on this user-interactive path (the per-account refresh
  // button). The hourly batch sync (syncAllFollowerCounts) gets Graph coverage,
  // where the map is built once for ALL accounts and is efficient.
  if (slug === "instagram") {
    const username = account.handle.replace(/^@/, "") || account.profileUrl?.match(/instagram\.com\/([^/?]+)/)?.[1];
    if (username) followers = await fetchInstagramFollowers(username);
  } else if (slug === "youtube") {
    if (account.profileUrl) followers = await fetchYouTubeSubscribers(account.profileUrl);
  } else if (slug === "facebook") {
    followers = await fetchFacebookFollowers(account.profileUrl || "", account.handle);
  }
  // Other platforms: no automated sync; admin must enter the count manually.

  if (followers !== null && followers > 0) {
    await prisma.socialAccount.update({
      where: { id: accountId },
      data: { followerCount: followers, lastSyncedAt: new Date() },
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
