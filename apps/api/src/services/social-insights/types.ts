export interface InsightFetchResult {
  ok: boolean;
  status: "ok" | "not_found" | "private" | "rate_limited" | "error";
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  title?: string | null;     // post title (YouTube snippet.title)
  caption?: string | null;   // post caption (IG/FB caption; YouTube snippet.description)
  error?: string;
}

export interface InsightTarget {
  linkId: string;
  url: string;
  urlNormalized: string;
  targetId: string; // videoId for YouTube, mediaId for Instagram, etc.
  employeeId: string;
  reportDate: Date;
}

// A post the provider saw while building its feed map this run — captured for
// content enrichment regardless of whether a matching report_link was submitted.
// Keyed by canonicalKey so it slots straight into link_content on the cron side.
export interface HarvestedContent {
  canonicalKey: string;
  title?: string | null;
  caption?: string | null;
}

export interface InsightProvider {
  slug: string;
  isSupported(): boolean;
  extractTargetId(url: string): string | null;
  fetchBatch(targets: InsightTarget[]): Promise<Map<string, InsightFetchResult>>; // linkId → result
  // OPTIONAL: providers that page an owned-account feed (Instagram) can expose the
  // FULL set of posts they saw this run — not just the submitted ones still
  // top-of-feed. The cron upserts all of it into link_content (independently
  // guarded), so captions are captured at fetch time before firehose volume buries
  // them. Returns [] (or is absent) for providers without a feed map (YouTube reads
  // by id; Facebook is App-Review-blocked). Must be called AFTER fetchBatch in the
  // same run so it reuses the already-built map (no extra API calls).
  harvestContent?(): HarvestedContent[];
}
