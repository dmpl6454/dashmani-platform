export interface InsightFetchResult {
  ok: boolean;
  status: "ok" | "not_found" | "private" | "rate_limited" | "error";
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
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
