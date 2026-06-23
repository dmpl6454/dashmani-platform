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

export interface InsightProvider {
  slug: string;
  isSupported(): boolean;
  extractTargetId(url: string): string | null;
  fetchBatch(targets: InsightTarget[]): Promise<Map<string, InsightFetchResult>>; // linkId → result
}
