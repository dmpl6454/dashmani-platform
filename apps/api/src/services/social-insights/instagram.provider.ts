import type { InsightProvider, InsightTarget, InsightFetchResult } from "./types";

// Stub — Instagram requires per-employee OAuth (Graph API).
// When that is built, replace isSupported() and fetchBatch() with real implementation.
export const instagramProvider: InsightProvider = {
  slug: "instagram",
  isSupported() {
    return false;
  },
  extractTargetId(_url: string) {
    return null;
  },
  async fetchBatch(_targets: InsightTarget[]): Promise<Map<string, InsightFetchResult>> {
    return new Map();
  },
};
