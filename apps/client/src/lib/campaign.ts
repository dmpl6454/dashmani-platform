import useSWR from "swr";
import { apiFetch } from "@/lib/api";

// Campaign booking — types, SWR hooks and the resumable chunked uploader for the client portal.

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";
/** Origin of the API (signed media URLs are returned as /v1/… paths). */
export const API_ORIGIN = API_URL.replace(/\/v1\/?$/, "");

export interface CampaignMedia {
  id: string;
  position: number;
  kind: "image" | "video";
  originalName: string;
  mime: string | null;
  bytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  uploadStatus: string;
  rejectReason: string | null;
  renderStatus: string;
  renderError: string | null;
}

export interface CampaignItem {
  id: string;
  rateCardId: string;
  platform: "instagram" | "facebook" | "youtube";
  format: string;
  accountName: string;
  accountHandle: string | null;
  pricePaise: number;
  status: string;
  permalink: string | null;
  postedAt: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  brand: string;
  objective: string | null;
  launchFrom: string | null;
  launchTo: string | null;
  format: string | null;
  caption: string | null;
  hashtags: string[];
  userTags: string[];
  collaborators: string[];
  superText: string | null;
  superTextStyle: string | null;
  status: string;
  totalPaise: number | null;
  reviewNote: string | null;
  paidAt: string | null;
  deliveredAt: string | null;
  media: CampaignMedia[];
  items: CampaignItem[];
}

export interface CampaignListRow {
  id: string;
  name: string;
  brand: string;
  status: string;
  format: string | null;
  totalPaise: number | null;
  launchFrom: string | null;
  launchTo: string | null;
  updatedAt: string;
  itemCount: number;
  liveCount: number;
}

export interface CatalogueEntry {
  targetType: string;
  targetId: string;
  platform: "instagram" | "facebook" | "youtube";
  name: string;
  username: string | null;
  pictureUrl: string | null;
  followers: number | null;
  engagementRatePct: number | null;
  views28d: number | null;
  category: string | null;
  profileUrl: string | null;
  offers: Array<{ rateCardId: string; format: string; pricePaise: number }>;
}

export interface CampaignResults {
  id: string;
  status: string;
  deliveredAt: string | null;
  items: Array<{
    id: string;
    platform: string;
    format: string;
    accountName: string;
    accountHandle: string | null;
    status: string;
    permalink: string | null;
    postedAt: string | null;
    metrics: { views: number | null; likes: number | null; comments: number | null; measuredAt: string | null } | null;
  }>;
}

const unwrap = async <T,>(url: string) => (await apiFetch<T>(url)).data;

export function useCampaigns() {
  return useSWR<CampaignListRow[]>("/client/campaigns", unwrap, { revalidateOnFocus: true });
}

/** Polls while a render or payment confirmation is pending, so the page moves on by itself. */
export function useCampaign(id: string | null) {
  return useSWR<Campaign>(id ? `/client/campaigns/${id}` : null, unwrap, {
    refreshInterval: (c) =>
      c && (c.media.some((m) => m.renderStatus === "queued" || m.renderStatus === "rendering") || c.status === "awaiting_payment") ? 5000 : 0,
  });
}

export function useCatalogue(enabled: boolean) {
  return useSWR<CatalogueEntry[]>(enabled ? "/client/campaigns/catalogue" : null, unwrap, { revalidateOnFocus: false, dedupingInterval: 60_000 });
}

export function useResults(id: string | null, enabled: boolean) {
  return useSWR<CampaignResults>(id && enabled ? `/client/campaigns/${id}/results` : null, unwrap, { revalidateOnFocus: true, refreshInterval: 120_000 });
}

export function mutateJson<T>(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown) {
  return apiFetch<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.data);
}

export async function previewUrl(mediaId: string): Promise<string> {
  const r = (await apiFetch<{ url: string }>(`/client/campaign-uploads/${mediaId}/preview-url`)).data;
  return `${API_ORIGIN}${r.url}`;
}

// ── Chunked upload ──────────────────────────────────────────────────────────────

interface UploadInit {
  id: string;
  chunkSize: number;
  totalChunks: number;
  receivedChunks?: number[];
}

/**
 * Upload a file in 8 MB chunks, two in flight, each retried up to 4 times with backoff.
 * Resumable: pass `resumeId` (the upload id from a previous attempt) and only missing chunks
 * are sent. Returns the completed upload.
 */
export async function uploadChunked(
  file: File,
  opts: { onProgress?: (fraction: number) => void; onId?: (id: string) => void; resumeId?: string | null; signal?: AbortSignal } = {},
): Promise<CampaignMedia> {
  let init: UploadInit;
  if (opts.resumeId) {
    init = (await apiFetch<UploadInit>(`/client/campaign-uploads/${opts.resumeId}`)).data;
  } else {
    init = await mutateJson<UploadInit>("/client/campaign-uploads", "POST", { filename: file.name, size: file.size, mime: file.type || "application/octet-stream" });
  }
  opts.onId?.(init.id);

  const done = new Set(init.receivedChunks ?? []);
  const todo = [...Array(init.totalChunks).keys()].filter((n) => !done.has(n));
  let sent = done.size;
  opts.onProgress?.(sent / init.totalChunks);

  const sendOne = async (n: number) => {
    const blob = file.slice(n * init.chunkSize, Math.min(file.size, (n + 1) * init.chunkSize));
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw new Error("Upload cancelled");
      try {
        const token = localStorage.getItem("clientAccessToken");
        const res = await fetch(`${API_URL}/client/campaign-uploads/${init.id}/chunks/${n}`, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: blob,
          signal: opts.signal,
        });
        if (res.status === 401) {
          // Let apiFetch refresh the token, then retry.
          await apiFetch(`/client/campaign-uploads/${init.id}`).catch(() => undefined);
          throw new Error("auth");
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.success) {
          const msg = body?.error?.message || `Upload failed (${res.status})`;
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw Object.assign(new Error(msg), { fatal: true });
          throw new Error(msg);
        }
        sent++;
        opts.onProgress?.(sent / init.totalChunks);
        return;
      } catch (err: any) {
        if (err?.fatal || opts.signal?.aborted || attempt >= 4) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  };

  const queue = todo.slice();
  await Promise.all(
    [0, 1].map(async () => {
      while (queue.length) await sendOne(queue.shift()!);
    }),
  );
  return mutateJson<CampaignMedia>(`/client/campaign-uploads/${init.id}/complete`, "POST");
}

// ── Formatting ──────────────────────────────────────────────────────────────────

export function rupees(paise: number | null | undefined): string {
  if (paise == null) return "—";
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { maximumFractionDigits: r % 1 === 0 ? 0 : 2 })}`;
}

export function compact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e7) return `${(n / 1e7).toFixed(n >= 1e8 ? 0 : 1)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(n >= 1e6 ? 0 : 1)} L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}

export const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" };
