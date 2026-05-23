import { prisma } from "@dashmani/db";

const DELAY_MS = 5000; // 5s between requests to avoid rate limiting

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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
          console.log(`[follower-sync] Instagram rate limited for ${username}, waiting 30s...`);
          await sleep(30000);
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
    const match = html.match(/"subscriberCountText":\{"accessibility":\{"accessibilityData":\{"label":"([^"]+)"/);
    if (!match) return null;
    return parseYouTubeSubscribers(match[1]);
  } catch {
    return null;
  }
}

function parseFollowerCount(text: string): number | null {
  // handles "14M", "1.2K", "553,000", "14,000,000", "553 thousand", etc.
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
  else if (unit === "billion") num *= 1000000000;
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

async function fetchPageHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36",
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
  // Normalise URL — strip tracking params, use mbasic for lighter page
  const slug = extractHandle(profileUrl, "facebook") || handle.replace(/^@/, "").split("?")[0];
  if (!slug) return null;

  const html = await fetchPageHtml(`https://mbasic.facebook.com/${encodeURIComponent(slug)}`);
  if (!html) return null;

  // "14,000,000 followers", "14M followers", "14M likes"
  const patterns = [
    /(\d[\d,.]*[KkMmBb]?)\s*(?:followers|people follow)/i,
    /"followers_count"\s*:\s*(\d+)/,
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

async function fetchTikTokFollowers(profileUrl: string, handle: string): Promise<number | null> {
  const username = extractHandle(profileUrl, "tiktok") || handle.replace(/^@/, "").split("?")[0];
  if (!username) return null;
  const html = await fetchPageHtml(`https://www.tiktok.com/@${encodeURIComponent(username)}`);
  if (!html) return null;
  // JSON-LD or meta tags: "followerCount":"14000000"
  const m = html.match(/"followerCount"\s*:\s*"?([\d,]+)"?/);
  if (m) return parseFollowerCount(m[1]);
  return null;
}

async function fetchLinkedInFollowers(profileUrl: string): Promise<number | null> {
  // LinkedIn blocks scraping heavily; try the public page for follower text
  const html = await fetchPageHtml(profileUrl);
  if (!html) return null;
  const m = html.match(/([\d,]+[KkMm]?)\s+followers/i);
  if (m) return parseFollowerCount(m[1]);
  return null;
}

async function fetchTwitterFollowers(profileUrl: string, handle: string): Promise<number | null> {
  const username = extractHandle(profileUrl, "twitter") || handle.replace(/^@/, "").split("?")[0];
  if (!username) return null;
  // Use nitter as a public scrape proxy (fallback only — may not always be available)
  const html = await fetchPageHtml(`https://nitter.net/${encodeURIComponent(username)}`);
  if (!html) return null;
  const m = html.match(/<span[^>]*class="[^"]*followers[^"]*"[^>]*>([\d,KkMm.]+)<\/span>/i)
    || html.match(/Followers<\/[^>]+>\s*<[^>]+>([\d,KkMm.]+)</i);
  if (m) return parseFollowerCount(m[1]);
  return null;
}

export async function syncAllFollowerCounts() {
  igRateLimited = false;
  const accounts = await prisma.socialAccount.findMany({
    where: { profileUrl: { not: "" } },
    include: { platform: { select: { slug: true } } },
  });

  const results = { total: accounts.length, updated: 0, failed: 0, skipped: 0 };
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const account of accounts) {
    const slug = account.platform.slug;
    let followers: number | null = null;

    if (slug === "instagram") {
      let username = account.handle.replace(/^@/, "").split("?")[0].split("/")[0].trim();
      if (!username && account.profileUrl) {
        username = account.profileUrl.match(/instagram\.com\/([^/?]+)/)?.[1] || "";
      }
      if (username) {
        followers = await fetchInstagramFollowers(username);
        await sleep(DELAY_MS);
      }
    } else if (slug === "youtube") {
      if (account.profileUrl) {
        followers = await fetchYouTubeSubscribers(account.profileUrl);
        await sleep(DELAY_MS);
      }
    } else if (slug === "facebook") {
      if (account.profileUrl || account.handle) {
        followers = await fetchFacebookFollowers(account.profileUrl || "", account.handle);
        await sleep(DELAY_MS);
      }
    } else if (slug === "tiktok") {
      if (account.profileUrl || account.handle) {
        followers = await fetchTikTokFollowers(account.profileUrl || "", account.handle);
        await sleep(DELAY_MS);
      }
    } else if (slug === "linkedin") {
      if (account.profileUrl) {
        followers = await fetchLinkedInFollowers(account.profileUrl);
        await sleep(DELAY_MS);
      }
    } else if (slug === "twitter") {
      if (account.profileUrl || account.handle) {
        followers = await fetchTwitterFollowers(account.profileUrl || "", account.handle);
        await sleep(DELAY_MS);
      }
    } else {
      // snapchat, pinterest, telegram — no public scrape available yet
      results.skipped++;
      continue;
    }

    if (followers !== null && followers > 0) {
      console.log(`[follower-sync] ${slug}/${account.handle}: ${followers}`);
      // Update the social account's follower count
      await prisma.socialAccount.update({
        where: { id: account.id },
        data: { followerCount: followers, lastSyncedAt: new Date() },
      });

      // Record a growth snapshot for today
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

      results.updated++;
    } else {
      results.failed++;
    }
  }

  return results;
}

// Sync a single account (for on-demand refresh)
export async function syncSingleAccountFollowers(accountId: string) {
  const account = await prisma.socialAccount.findUnique({
    where: { id: accountId },
    include: { platform: { select: { slug: true } } },
  });
  if (!account) return null;

  let followers: number | null = null;
  const slug = account.platform.slug;

  if (slug === "instagram") {
    const username = account.handle.replace(/^@/, "") || account.profileUrl?.match(/instagram\.com\/([^/?]+)/)?.[1];
    if (username) followers = await fetchInstagramFollowers(username);
  } else if (slug === "youtube") {
    if (account.profileUrl) followers = await fetchYouTubeSubscribers(account.profileUrl);
  } else if (slug === "facebook") {
    followers = await fetchFacebookFollowers(account.profileUrl || "", account.handle);
  } else if (slug === "tiktok") {
    followers = await fetchTikTokFollowers(account.profileUrl || "", account.handle);
  } else if (slug === "linkedin") {
    if (account.profileUrl) followers = await fetchLinkedInFollowers(account.profileUrl);
  } else if (slug === "twitter") {
    followers = await fetchTwitterFollowers(account.profileUrl || "", account.handle);
  }

  if (followers !== null && followers > 0) {
    await prisma.socialAccount.update({
      where: { id: accountId },
      data: { followerCount: followers, lastSyncedAt: new Date() },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
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
