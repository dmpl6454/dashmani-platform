import type { InsightProvider } from "./types";
import { youTubeProvider } from "./youtube.provider";
import { instagramProvider } from "./instagram.provider";
import { facebookProvider } from "./facebook.provider";
import { snapchatProvider } from "./snapchat.provider";

// ⚠️ ORDER IS THE 6h-CRON METRIC-SWEEP ORDER (getSupportedSlugs is only consumed by
// social-insights.cron.ts). Priority: cheapest-and-most-reliable FIRST, slowest LAST.
//   1. youtube   — ~2k links, fast Data API.
//   2. facebook  — ~19k links via the public-reel scraper.
//   3. snapchat  — Spotlight scraper (public pages, Googlebot UA). Runs 3rd —
//      after YT/FB (which are heavier) but before IG (rate-limit-prone). Scraped
//      per-link at 400ms/link; ~78 Spotlight links on prod → ~31s total. No feed map
//      to build, no early harvest needed (captions returned inline in fetchBatch).
//   4. instagram — ~38k links, the slow/rate-limit-prone sweep. IG is the safe one
//      to run LAST (harvest fires early, engagement is Graph-administered-only).
// Do NOT move Instagram before Facebook/Snapchat — that re-starves them (2026-06-26 outage).
const providers: InsightProvider[] = [
  youTubeProvider,
  facebookProvider,
  snapchatProvider,
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
