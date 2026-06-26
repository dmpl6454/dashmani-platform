import type { InsightProvider } from "./types";
import { youTubeProvider } from "./youtube.provider";
import { instagramProvider } from "./instagram.provider";
import { facebookProvider } from "./facebook.provider";

// ⚠️ ORDER IS THE 6h-CRON METRIC-SWEEP ORDER (getSupportedSlugs is only consumed by
// social-insights.cron.ts). Priority: cheapest-and-most-reliable FIRST, slowest LAST.
//   1. youtube   — ~2k links, fast Data API.
//   2. facebook  — ~19k links via the public-reel scraper (reliable first-try, ~80min).
//      FB's engagement AND its external-reel caption harvest BOTH ride the metric
//      sweep (the early harvestContent only covers the ~5-15% administered Pages), so
//      FB MUST get its sweep turn — it was previously starved behind Instagram.
//   3. instagram — ~38k links, the slow/rate-limit-prone sweep. IG's caption harvest
//      runs EARLY (independent of sweep completion) and IG engagement is Graph-
//      administered-only (low marginal value), so IG is the safe one to run LAST.
// Do NOT move Instagram before Facebook again — that re-starves FB (the 2026-06-26
// "Facebook 0 ok / 1 searchable" outage).
const providers: InsightProvider[] = [
  youTubeProvider,
  facebookProvider,
  instagramProvider,
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
