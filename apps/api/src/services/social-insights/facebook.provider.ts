import type { InsightProvider, InsightTarget, InsightFetchResult } from "./types";

// Stub — Facebook requires per-employee OAuth (Graph API, same Meta auth as Instagram).
// When that is built, replace isSupported() and fetchBatch() with real implementation.
export const facebookProvider: InsightProvider = {
  slug: "facebook",
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
