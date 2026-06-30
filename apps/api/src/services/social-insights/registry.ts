import type { InsightProvider } from "./types";
import { youTubeProvider } from "./youtube.provider";
import { instagramProvider } from "./instagram.provider";
import { facebookProvider } from "./facebook.provider";

// ⚠️ ORDER IS THE 6h-CRON METRIC-SWEEP ORDER (getSupportedSlugs is only consumed by
// social-insights.cron.ts). Priority: cheapest-and-most-reliable FIRST, slowest LAST.
//   1. youtube   — ~2k links, fast Data API.
//   2. facebook  — ~19k links via the public-reel scraper.
//   3. instagram — ~38k links, the slow/rate-limit-prone sweep. IG is the safe one
//      to run LAST (harvest fires early, engagement is Graph-administered-only).
// Do NOT move Instagram before Facebook — that re-starves it (2026-06-26 outage).
//
// NOTE: Snapchat has NO insight provider. Its post captions/engagement are not
// readable server-side — prod links are snapchat.com/t/<code> share redirects that
// resolve to client-rendered profile pages (no caption/views in the HTML), and there
// is no public organic API. A Spotlight scraper was removed (2026-06-30) after a live
// Linode probe confirmed it produced nothing for the real /t/ link shape. The only
// working Snapchat feature is follower-count sync (Account Growth) in
// follower-sync.service.ts, which needs no insight provider. There is no Snapchat
// "Top Links" — engagement is unreadable, so an engagement-ranked panel is impossible.
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
