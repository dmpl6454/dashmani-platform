import type { InsightProvider } from "./types";
import { youTubeProvider } from "./youtube.provider";
import { instagramProvider } from "./instagram.provider";
import { facebookProvider } from "./facebook.provider";
import { snapchatProvider } from "./snapchat.provider";

// ⚠️ ORDER IS THE 6h-CRON METRIC-SWEEP ORDER (getSupportedSlugs is only consumed by
// social-insights.cron.ts). Priority: cheapest-and-most-reliable FIRST, slowest LAST.
//   1. youtube   — ~2k links, fast Data API.
//   2. facebook  — ~19k links via the public-reel scraper.
//   3. instagram — ~38k links, the slow/rate-limit-prone sweep.
//   4. snapchat  — ~124 links via the public Spotlight scraper. Small + polite
//      (300ms/link), so it's last; its budget can't starve the big providers.
// Do NOT move Instagram before Facebook — that re-starves it (2026-06-26 outage).
const providers: InsightProvider[] = [
  youTubeProvider,
  facebookProvider,
  instagramProvider,
  snapchatProvider,
];

const providerMap = new Map<string, InsightProvider>(
  providers.map((p) => [p.slug, p])
);

export function getProvider(slug: string): InsightProvider | undefined {
  return providerMap.get(slug.toLowerCase());
}

export function getSupportedSlugs(): string[] {
  return providers.filter((p) => p.isSupported()).map((p) => p.slug);
}

export function getAllSlugs(): string[] {
  return providers.map((p) => p.slug);
}
