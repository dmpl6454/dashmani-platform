"use client";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import type { PortalDirectory, PortalEntry } from "@/lib/types";

// Links between the sales and billing portals (2026-11-07). sales.digitalsukoon.com and
// billing.digitalsukoon.com are two origins with two sessions, so a plain <a> to the other
// portal would land on its sign-in page. A link across portals is therefore a HANDOFF with a
// destination: POST /auth/handoff { target, next } answers
// <portal>/login?next=<path>#handoff=<code>, the target's login page exchanges the code for its
// own session and opens <path>. (PortalLink in components/portal-link.tsx keeps the absolute URL
// as the href, so open-in-new-tab and copy-link still work.)

export type PortalKey = PortalEntry["key"];
const SWR_OPTS = { revalidateOnFocus: false, dedupingInterval: 300_000 } as const;

/** GET /auth/portals, shared with the portal switcher (one request per five minutes). */
export function usePortals() {
  return useSWR<PortalDirectory>("/auth/portals", fetcher, SWR_OPTS);
}

/** The absolute URL of `path` on another portal, once the directory has loaded. */
export function usePortalUrl(target: PortalKey, path: string): string | undefined {
  const { data } = usePortals();
  const entry = data?.portals.find((p) => p.key === target);
  return entry ? `${entry.url}${path}` : undefined;
}

/** Open `path` on another portal already signed in. Throws if the handoff could not be made. */
export async function openPortal(target: PortalKey, path: string): Promise<void> {
  const res = await apiFetch<{ url: string }>("/auth/handoff", { method: "POST", body: JSON.stringify({ target, next: path }) });
  window.location.assign(res.data.url);
  // The page is leaving; keep the caller's "busy" state until it has.
  await new Promise(() => {});
}
