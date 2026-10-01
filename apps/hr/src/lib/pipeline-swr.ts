/**
 * SWR options for the pipeline's request-once data (spec §9.3): bootstrap, directory and the
 * archived / deleted lists. The live board and thread never use SWR — they come from the
 * SyncEngine — and nothing here polls (no refreshInterval, no global SWRConfig).
 *
 * Bootstrap alone revalidates a stale cache (GA, 2026-10-01), so a `pipeline.mode` flip
 * reaches tabs that are already open — at most one bootstrap request per 10 minutes per tab.
 */
import useSWR, { type SWRConfiguration } from "swr";
import type { PipelineBootstrap, PipelineDirectoryEntry, PipelineMode } from "@dashmani/shared";
import { apiFetch } from "@/lib/api";

export const PL_SWR: SWRConfiguration = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  revalidateIfStale: false,
  keepPreviousData: true,
  errorRetryCount: 4,
  onErrorRetry: (err, _k, _c, revalidate, { retryCount }) => {
    const s = (err as { status?: number } | undefined)?.status;
    if (s && s < 500 && s !== 0) return; // never retry 400/401/403/404/409/429
    if (retryCount >= 4) return;
    setTimeout(
      () => revalidate({ retryCount }),
      Math.min(60_000, 5000 * 2 ** retryCount) * (0.8 + Math.random() * 0.4),
    );
  },
};

/** GET a pipeline route and unwrap the `{success, data}` envelope. */
export async function plGet<T>(path: string): Promise<T> {
  const env = await apiFetch<{ success: true; data: T }>(`/pipeline${path}`);
  return env.data;
}

const TEN_MIN = 10 * 60_000;

/**
 * Bootstrap for the signed-in user. Shared by the sidebar (nav item) and the provider.
 *
 * G1 (GA): a cached answer is revalidated on mount when stale and on window focus, both
 * bounded to once per 10 minutes per tab (the dedupe window and the focus throttle) — so after
 * `pipeline.mode` goes pilot → on, an open tab shows the nav at its next focus instead of only
 * after a reload or a sign-in. ⚠️ Cheap and isolated by design: the route is memo-backed, the
 * pipeline's own per-user "read" bucket counts it (120/min), and the global limiter SKIPS
 * /v1/pipeline/* (app.ts isPipelinePath) — it can never 429 login, HR submit or Link History.
 * Never add a refreshInterval here: focus is enough, and polling every HR tab is not.
 */
export function usePipelineBootstrap(userId: string | null | undefined) {
  return useSWR<PipelineBootstrap>(
    userId ? ["/pipeline/bootstrap", userId] : null,
    () => plGet<PipelineBootstrap>("/bootstrap"),
    { ...PL_SWR, revalidateIfStale: true, revalidateOnFocus: true, focusThrottleInterval: TEN_MIN, dedupingInterval: TEN_MIN },
  );
}

/**
 * The people directory (names only). Only fetched once the feature is enabled.
 *
 * G3: keyed on the bootstrap MODE as well, so pilot users' cached directory — where everyone
 * outside the pilot is `pickable: false` — is fetched again when the mode becomes "on"
 * (otherwise they could not add or @mention newly enabled colleagues until a reload).
 * keepPreviousData keeps the old names on screen while the new list loads.
 */
export function usePipelineDirectory(
  userId: string | null | undefined,
  enabled: boolean,
  mode: Exclude<PipelineMode, "off">,
) {
  return useSWR<PipelineDirectoryEntry[]>(
    userId && enabled ? ["/pipeline/directory", userId, mode] : null,
    () => plGet<PipelineDirectoryEntry[]>("/directory"),
    { ...PL_SWR, dedupingInterval: TEN_MIN },
  );
}
