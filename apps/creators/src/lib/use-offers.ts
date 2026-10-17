"use client";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { API_ORIGIN, fetcher } from "./api";
import { useAuth } from "./auth";
import { countAwaitingAnswer, MARKETPLACE_STATUS_PATH, OFFERS_PATH, signedUrlExpiry, type OfferFile, type OfferRow } from "./offers";

/**
 * The browser's clock in ms, read after mount (null before: the static render and the first paint must not
 * depend on the time) and again every `intervalMs`, so an expiry countdown and an offer that runs out while the
 * page is open both move on their own.
 */
export function useNow(intervalMs = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * Whether creator bookings are open, from GET /creator/marketplace-status. TRUE only for a loaded `true`:
 * while the answer is loading, failed (an older server has no such route), or `false`, bookings are hidden
 * entirely — no nav entry, no dashboard row. That keeps the whole feature dark for everyone while its switches
 * are off. It re-reads on focus (at most once a minute) so switching bookings on needs no reload.
 */
export function useMarketplaceOpen(): boolean {
  const { data } = useSWR<{ marketplaceEnabled: boolean }>(MARKETPLACE_STATUS_PATH, fetcher, {
    revalidateOnFocus: true,
    dedupingInterval: 60_000,
    shouldRetryOnError: false,
  });
  return data?.marketplaceEnabled === true;
}

/**
 * The creator's offers (the same SWR entry as the Bookings page, so one request serves the nav, the Overview row
 * and the list). Fetched only when `enabled`: an unapproved creator has no offers and the API answers 403.
 */
export function useOffersList(enabled: boolean) {
  return useSWR<OfferRow[]>(enabled ? OFFERS_PATH : null, fetcher, {
    revalidateOnFocus: true,
    dedupingInterval: 15_000,
    shouldRetryOnError: false,
  });
}

/**
 * How many offers wait for the creator's answer, for the nav badge and the Overview row. null until it is KNOWN: a
 * failed or pending read never claims "none".
 */
export function useAwaitingAnswerCount(): { open: boolean; count: number | null } {
  const { creator } = useAuth();
  const open = useMarketplaceOpen();
  const approved = creator?.status === "approved";
  const { data } = useOffersList(open && approved);
  const now = useNow(60_000);
  return { open, count: open && approved && data ? countAwaitingAnswer(data, now) : null };
}

/** The absolute URL of a signed media path. */
export const mediaUrl = (path: string) => `${API_ORIGIN}${path}`;

/**
 * Signed media paths that stay put. Every read of the offer mints new signatures, so re-reading on focus would give
 * a playing <video> a new `src` each time a creator comes back from posting. A file keeps the URL it first had
 * until that one is within ten minutes of expiring (the links live hours), so the player only reloads when it must.
 */
export function useStableFileUrls(files: OfferFile[] | undefined): Map<string, { url: string | null; downloadUrl: string | null }> {
  const kept = useRef(new Map<string, { url: string | null; downloadUrl: string | null }>());
  const out = new Map<string, { url: string | null; downloadUrl: string | null }>();
  const nowSec = Math.floor(Date.now() / 1000);
  for (const f of files ?? []) {
    const prev = kept.current.get(f.id);
    const exp = signedUrlExpiry(prev?.url);
    const stale = !prev || !prev.url || exp == null || exp - nowSec < 600;
    const next = stale || !f.url ? { url: f.url, downloadUrl: f.downloadUrl } : prev!;
    kept.current.set(f.id, next);
    out.set(f.id, next);
  }
  return out;
}
