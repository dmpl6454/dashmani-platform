import type { InsightProvider } from "./types";
import { youTubeProvider } from "./youtube.provider";
import { instagramProvider } from "./instagram.provider";
import { facebookProvider } from "./facebook.provider";

const providers: InsightProvider[] = [
  youTubeProvider,
  instagramProvider,
  facebookProvider,
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
