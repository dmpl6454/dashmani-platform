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
      const data = await res.json();
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
      // Extract clean username — strip @, query params, trailing slashes
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
    } else {
      results.skipped++;
      continue;
    }

    if (followers !== null && followers > 0) {
      console.log(`[follower-sync] ${slug}/${account.handle}: ${followers}`);
      // Update the social account's follower count
      await prisma.socialAccount.update({
        where: { id: account.id },
        data: { followerCount: followers },
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
  }

  if (followers !== null && followers > 0) {
    await prisma.socialAccount.update({
      where: { id: accountId },
      data: { followerCount: followers },
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
