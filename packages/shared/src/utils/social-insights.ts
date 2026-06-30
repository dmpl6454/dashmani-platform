export const SUPPORTED_INSIGHT_PLATFORMS = ["youtube", "instagram", "facebook", "snapchat"] as const;
export type SupportedInsightPlatform = (typeof SUPPORTED_INSIGHT_PLATFORMS)[number];

export function getSupportedInsightPlatforms(): readonly string[] {
  return SUPPORTED_INSIGHT_PLATFORMS;
}

export function isPlatformInsightSupported(platform: string | null | undefined): boolean {
  if (!platform) return false;
  return (SUPPORTED_INSIGHT_PLATFORMS as readonly string[]).includes(platform.toLowerCase());
}