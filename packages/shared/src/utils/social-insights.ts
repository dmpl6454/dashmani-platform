// Snapchat is deliberately NOT here: it has no server-readable post captions/engagement
// (share-redirect links → client-rendered profile pages; no public organic API). Its
// follower counts + submission-count Top Links work without an insight provider.
export const SUPPORTED_INSIGHT_PLATFORMS = ["youtube", "instagram", "facebook"] as const;
export type SupportedInsightPlatform = (typeof SUPPORTED_INSIGHT_PLATFORMS)[number];

export function getSupportedInsightPlatforms(): readonly string[] {
  return SUPPORTED_INSIGHT_PLATFORMS;
}

export function isPlatformInsightSupported(platform: string | null | undefined): boolean {
  if (!platform) return false;
  return (SUPPORTED_INSIGHT_PLATFORMS as readonly string[]).includes(platform.toLowerCase());
}