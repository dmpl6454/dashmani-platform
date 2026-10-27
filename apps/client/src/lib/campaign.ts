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
  /** creative = part of the post; thumbnail = the client's cover image for a video. */
  role: "creative" | "thumbnail";
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
  platform: "instagram" | "facebook" | "youtube" | "snapchat";
  format: string;
  accountName: string;
  accountHandle: string | null;
  pricePaise: number;
  audioAddonPaise: number;
  /** Per-account text — null means "same as the campaign". superTextOverride "" = no overlay. */
  captionOverride: string | null;
  hashtagsOverride: string[];
  superTextOverride: string | null;
  superTextStyleOverride: string | null;
  /** State of this account's own renders (null when it posts the campaign's default files). */
  renderStatus: "queued" | "done" | "failed" | null;
  status: string;
  permalink: string | null;
  postedAt: string | null;
}

export interface Campaign {
  /** Subtotal + GST + total (GST is charged on top of the rate-card prices). Null with no accounts picked. */
  pricing?: CampaignPricing | null;
  id: string;
  name: string;
  brand: string;
  objective: string | null;
  launchFrom: string | null;
  launchTo: string | null;
  format: string | null;
  campaignType: "brand" | "entertainment";
  audioIntegration: boolean;
  audioTrack: string | null;
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
  /** "razorpay" opens the gateway at checkout; "offline" submits for review, amount settled by hand. */
  paymentMode?: "razorpay" | "offline";
  deliveredAt: string | null;
  /** The creative (never the thumbnail). */
  media: CampaignMedia[];
  /** The client's cover image for a video, if they supplied one. */
  thumbnail: CampaignMedia | null;
  items: CampaignItem[];
}

export interface ItemPreviewFile {
  mediaId: string;
  kind: "image" | "video";
  role: "creative" | "thumbnail";
  status: string;
  url: string | null;
}

export interface CampaignPricing {
  subtotalPaise: number;
  gstRateBp: number;
  taxMode: "intra" | "inter" | "none";
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  gstPaise: number;
  roundOffPaise: number;
  totalPaise: number;
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
  platform: "instagram" | "facebook" | "youtube" | "snapchat";
  name: string;
  username: string | null;
  pictureUrl: string | null;
  followers: number | null;
  engagementRatePct: number | null;
  views28d: number | null;
  category: string | null;
  profileUrl: string | null;
  /** About how long after posting the link is ready. */
  linkDeliveryMinutes: { min: number; max: number };
  offers: Array<{ rateCardId: string; format: string; pricePaise: number; entertainmentPricePaise: number | null; audioAddonPaise: number | null }>;
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
    /** When an automatic post is due (only while it waits). Absent on older API responses. */
    scheduledFor?: string | null;
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
    refreshInterval: (c) => (c && (renderPending(c) || c.status === "awaiting_payment") ? 5000 : 0),
  });
}

export function useCatalogue(enabled: boolean) {
  return useSWR<CatalogueEntry[]>(enabled ? "/client/campaigns/catalogue" : null, unwrap, { revalidateOnFocus: false, dedupingInterval: 60_000 });
}

export function useResults(id: string | null, enabled: boolean) {
  return useSWR<CampaignResults>(id && enabled ? `/client/campaigns/${id}/results` : null, unwrap, { revalidateOnFocus: true, refreshInterval: 120_000 });
}

/** Any file (creative, thumbnail or a per-account variant) still being prepared. */
export function renderPending(c: Campaign): boolean {
  const files = c.thumbnail ? [...c.media, c.thumbnail] : c.media;
  return files.some((m) => m.renderStatus === "queued" || m.renderStatus === "rendering") || c.items.some((i) => i.renderStatus === "queued");
}

/**
 * How much is still being prepared: files (creative + thumbnail default renders) and accounts
 * with their own printed text (variant renders). Drives the "Preparing your preview: …" line.
 */
export function renderPendingCounts(c: Campaign): { files: number; accounts: number } {
  const files = (c.thumbnail ? [...c.media, c.thumbnail] : c.media).filter((m) => m.renderStatus === "queued" || m.renderStatus === "rendering").length;
  const accounts = c.items.filter((i) => i.renderStatus === "queued").length;
  return { files, accounts };
}

/** "Where you left off" for a draft row on the campaign list and the home page. null once submitted. */
export function nextStepHint(r: Pick<CampaignListRow, "status" | "format" | "itemCount">): string | null {
  if (r.status !== "draft") return null;
  // Mode-neutral on purpose: list rows carry no paymentMode, and step 4 is "Review & submit"
  // offline but "Review & pay" with Razorpay.
  return !r.format ? "Next: add your video or image" : r.itemCount === 0 ? "Next: choose accounts" : "Next: review your campaign";
}

/**
 * Discard an upload the client cancelled or never saved (frees one of the 3 in-flight upload
 * slots at once instead of waiting for it to go stale). Fire-and-forget: never throws.
 * `keepalive` lets it outlive a closing tab, but browsers may drop a keepalive request that
 * needs a CORS preflight — it is best-effort; the server stops counting a stale upload anyway.
 */
export function deleteCampaignUpload(id: string, opts: { keepalive?: boolean } = {}): Promise<void> {
  let token: string | null = null;
  try {
    token = localStorage.getItem("clientAccessToken");
  } catch {
    /* storage blocked */
  }
  return fetch(`${API_URL}/client/campaign-uploads/${id}`, {
    method: "DELETE",
    keepalive: opts.keepalive,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
    .then(() => undefined)
    .catch(() => undefined);
}

export function renderFailed(c: Campaign): boolean {
  const files = c.thumbnail ? [...c.media, c.thumbnail] : c.media;
  return files.some((m) => m.renderStatus === "failed") || c.items.some((i) => i.renderStatus === "failed");
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

/**
 * Mirror of the server's priceFor(): what one account costs for this booking. The server
 * re-prices at checkout; this only drives the list and the running total.
 */
export function offerPrice(
  offer: CatalogueEntry["offers"][number],
  b: { campaignType: string; audioIntegration: boolean; format: string | null },
): { base: number; addon: number; total: number } | null {
  const base = b.campaignType === "entertainment" ? offer.entertainmentPricePaise : offer.pricePaise;
  if (base == null) return null;
  let addon = 0;
  if (b.audioIntegration && b.format === "reel") {
    if (offer.audioAddonPaise == null) return null;
    addon = offer.audioAddonPaise;
  }
  return { base, addon, total: base + addon };
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

export const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube", snapchat: "Snapchat" };
