import { extractYouTubeVideoId } from "@dashmani/shared";
import type { InsightProvider, InsightTarget, InsightFetchResult } from "./types";

const BATCH_SIZE = 50;
const TIMEOUT_MS = 10_000;

interface YouTubeStatistics {
  viewCount?: string;
  likeCount?: string;
  commentCount?: string;
}

interface YouTubeSnippet {
  title?: string;
  description?: string;
}

interface YouTubeItem {
  id: string;
  statistics?: YouTubeStatistics;
  snippet?: YouTubeSnippet;
}

interface YouTubeApiResponse {
  items?: YouTubeItem[];
  error?: { code: number; errors?: { reason: string }[] };
}

export let youTubeQuotaExceeded = false;

export const youTubeProvider: InsightProvider = {
  slug: "youtube",

  isSupported() {
    return !!process.env.YOUTUBE_API_KEY;
  },

  extractTargetId(url: string): string | null {
    return extractYouTubeVideoId(url);
  },

  async fetchBatch(targets: InsightTarget[]): Promise<Map<string, InsightFetchResult>> {
    const results = new Map<string, InsightFetchResult>();
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
      for (const t of targets) {
        results.set(t.linkId, { ok: false, status: "error", error: "YOUTUBE_API_KEY not configured" });
      }
      return results;
    }

    // Batch into groups of BATCH_SIZE (YouTube hard cap)
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      const videoIds = batch.map((t) => t.targetId).join(",");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let data: YouTubeApiResponse;
      try {
        const res = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${encodeURIComponent(videoIds)}&key=${apiKey}`,
          { signal: controller.signal }
        );

        data = (await res.json()) as YouTubeApiResponse;

        if (!res.ok) {
          const reason = data.error?.errors?.[0]?.reason;
          if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
            youTubeQuotaExceeded = true;
            console.error("[social-insights/youtube] quota exceeded — aborting run");
            for (const t of batch) {
              results.set(t.linkId, { ok: false, status: "rate_limited", error: "YouTube API quota exceeded" });
            }
            break; // abort entire batch loop
          }
          // Other HTTP error (keyInvalid, 5xx, etc.)
          console.error(`[social-insights/youtube] API error ${res.status}:`, data.error);
          for (const t of batch) {
            results.set(t.linkId, { ok: false, status: "error", error: `HTTP ${res.status}` });
          }
          continue;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const t of batch) {
          results.set(t.linkId, { ok: false, status: "error", error: msg });
        }
        continue;
      } finally {
        clearTimeout(timer);
      }

      // Build a map of videoId → full item (statistics + snippet) from the response
      const itemById = new Map<string, YouTubeItem>();
      for (const item of data.items ?? []) {
        itemById.set(item.id, item);
      }

      for (const t of batch) {
        const item = itemById.get(t.targetId);
        if (!item) {
          // Video not in response — deleted, private, or unlisted
          results.set(t.linkId, { ok: false, status: "not_found" });
        } else {
          const stats = item.statistics ?? {};
          results.set(t.linkId, {
            ok: true,
            status: "ok",
            views: stats.viewCount != null ? parseInt(stats.viewCount, 10) : null,
            likes: stats.likeCount != null ? parseInt(stats.likeCount, 10) : null,
            comments: stats.commentCount != null ? parseInt(stats.commentCount, 10) : null,
            shares: null, // YouTube Data API does not provide share counts
            title: item.snippet?.title ?? null,
            caption: item.snippet?.description ?? null,
          });
        }
      }
    }

    return results;
  },
};
