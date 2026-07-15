// Snapchat added 2026-07-14: Spotlight engagement (views/comments/shares) + captions
// are scrapeable token-free from the public /spotlight/<id> page's __NEXT_DATA__ blob
// (snapchat-scraper.ts). Links that are ephemeral Stories have no public stats and
// show as not_found — surfaced honestly in the coverage note. See
// docs/superpowers/plans/2026-07-14-snapchat-spotlight-insights.md.
export const SUPPORTED_INSIGHT_PLATFORMS = ["youtube", "instagram", "facebook", "snapchat"] as const;
export type SupportedInsightPlatform = (typeof SUPPORTED_INSIGHT_PLATFORMS)[number];

export function getSupportedInsightPlatforms(): readonly string[] {
  return SUPPORTED_INSIGHT_PLATFORMS;
}

export function isPlatformInsightSupported(platform: string | null | undefined): boolean {
  if (!platform) return false;
  return (SUPPORTED_INSIGHT_PLATFORMS as readonly string[]).includes(platform.toLowerCase());
}