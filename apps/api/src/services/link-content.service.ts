import { prisma } from "@dashmani/db";

/** Classify platform from the canonicalKey prefix (NOT the dirty platform column). */
export function platformFromCanonicalKey(canonicalKey: string): string {
  if (canonicalKey.startsWith("yt:")) return "youtube";
  if (canonicalKey.startsWith("ig:")) return "instagram";
  if (canonicalKey.startsWith("fb:")) return "facebook";
  return "other";
}

export interface UpsertLinkContentInput {
  canonicalKey: string;
  title?: string | null;
  caption?: string | null;
  /** Provider fetch status. If omitted, derived from whether any text was found. */
  status?: "ok" | "not_found" | "private" | "unsupported" | "error";
}

/**
 * Upsert the fetched caption/title for a unique post, keyed on canonicalKey.
 * Idempotent: the same canonicalKey upserts one row and refreshes text + fetchedAt.
 * status defaults to "ok" when any title/caption is present, else "not_found".
 */
export async function upsertLinkContent(input: UpsertLinkContentInput) {
  const { canonicalKey } = input;
  const platform = platformFromCanonicalKey(canonicalKey);
  const hasText = !!(input.title || input.caption);
  const status = input.status ?? (hasText ? "ok" : "not_found");
  const now = new Date();

  return prisma.linkContent.upsert({
    where: { canonicalKey },
    create: {
      canonicalKey,
      platform,
      title: input.title ?? null,
      caption: input.caption ?? null,
      status,
      fetchedAt: now,
    },
    update: {
      platform,
      title: input.title ?? null,
      caption: input.caption ?? null,
      status,
      fetchedAt: now,
      // NOTE: do NOT touch extractedAt here — Stage 2 owns it. Refreshing text does
      // not reset extraction; if you later want re-extraction on text change, that's
      // a separate, deliberate decision.
    },
  });
}
