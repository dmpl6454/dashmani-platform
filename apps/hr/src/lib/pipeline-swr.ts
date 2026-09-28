/**
 * SWR options for the pipeline's request-once data (spec §9.3), used VERBATIM: bootstrap,
 * directory and the archived / deleted lists. The live board and thread never use SWR —
 * they come from the SyncEngine — and nothing here polls (no refreshInterval, no global
 * SWRConfig), so opening the HR portal costs one bootstrap request per session.
 */
import useSWR, { type SWRConfiguration } from "swr";
import type { PipelineBootstrap, PipelineDirectoryEntry } from "@dashmani/shared";
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

/** Bootstrap for the signed-in user. Shared by the sidebar (nav item) and the provider. */
export function usePipelineBootstrap(userId: string | null | undefined) {
  return useSWR<PipelineBootstrap>(
    userId ? ["/pipeline/bootstrap", userId] : null,
    () => plGet<PipelineBootstrap>("/bootstrap"),
    { ...PL_SWR, dedupingInterval: TEN_MIN },
  );
}

/** The people directory (names only). Only fetched once the feature is enabled. */
export function usePipelineDirectory(userId: string | null | undefined, enabled: boolean) {
  return useSWR<PipelineDirectoryEntry[]>(
    userId && enabled ? ["/pipeline/directory", userId] : null,
    () => plGet<PipelineDirectoryEntry[]>("/directory"),
    { ...PL_SWR, dedupingInterval: TEN_MIN },
  );
}
