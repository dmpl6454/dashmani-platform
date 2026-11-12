import useSWR from "swr";
import { apiFetch } from "@/lib/api";

// Creator portal review queue (/v1/admin/creators*). Admin/Super Admin only on the API.

export const CREATOR_STATUS_ORDER = ["in_review", "approved", "draft", "rejected", "suspended", "closed"] as const;
export type CreatorStatus = (typeof CREATOR_STATUS_ORDER)[number];

export interface AdminCreatorRow {
  id: string;
  name: string;
  email: string;
  country: string | null;
  status: CreatorStatus;
  submittedAt: string | null;
  createdAt: string;
  pages: number;
  publishablePages: number;
  followers: number;
  connectionStatus: string | null;
}

export interface AdminCreator {
  id: string;
  email: string;
  name: string;
  country: string | null;
  phone: string | null;
  status: CreatorStatus;
  emailVerified: boolean;
  termsAccepted: boolean;
  submittedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewedByName?: string | null;
  closedAt: string | null;
  taxDetails: { route: "gst" | "pan"; gstin: string | null; pan: string; legalName: string } | null;
}

export interface CreatorConnectionView {
  status: string;
  metaUserName: string | null;
  grantedScopes: string[];
  missingScopes: string[];
  tokenExpiresAt: string | null;
  dataAccessExpiresAt: string | null;
  discoveryState: string;
  lastError: string | null;
  connectedAt: string;
}

export interface AdminAssetView {
  id: string;
  kind: "facebook_page" | "instagram_account";
  metaId: string;
  name: string;
  username: string | null;
  pictureUrl: string | null;
  profileUrl: string | null;
  followerCount: number | null;
  mediaCount: number | null;
  canPublish: boolean;
  publishProbeError: string | null;
  networkDuplicate: boolean;
  enabled: boolean;
  disconnected: boolean;
  views28d: number | null;
  engagements28d: number | null;
  metricsFetchedAt: string | null;
  tasks: string[];
  networkDuplicateOfName: string | null;
}

export interface AdminCreatorDetail {
  creator: AdminCreator;
  connection: CreatorConnectionView | null;
  assets: AdminAssetView[];
  /**
   * Only on approve/reject/suspend/reinstate responses: true when the email to the creator was
   * handed to SMTP. Absent on GET /admin/creators/:id (and on responses from an older API).
   */
  emailSent?: boolean;
}

const unwrap = <T,>(u: string) => apiFetch<{ data: T }>(u).then((r) => r.data);

/** `status` "" = every status. The search also scopes the tab counts; the tab does not. */
export function useCreators(status: string, q: string) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const term = q.trim();
  if (term) params.set("q", term);
  const qs = params.toString();
  const key = qs ? `/admin/creators?${qs}` : "/admin/creators";
  return useSWR<{ creators: AdminCreatorRow[]; counts: Record<CreatorStatus, number> }>(key, unwrap, {
    keepPreviousData: true,
    refreshInterval: 60_000,
    revalidateOnFocus: false,
  });
}

export function useCreatorDetail(id: string | undefined) {
  return useSWR<AdminCreatorDetail>(id ? `/admin/creators/${id}` : null, unwrap, { revalidateOnFocus: false });
}

// ── Marketplace: the creator's price + our margin (/admin/creators/:id/pricing) ─────────────

export interface CreatorFormatPrice {
  format: string;
  /** The creator's own price = their payout. null = the creator doesn't offer this format. */
  creatorPricePaise: number | null;
  creatorUpdatedAt: string | null;
  /** Our margin in basis points (2500 = 25%). */
  marginBps: number | null;
  entertainmentMarginBps: number | null;
  audioAddonPaise: number | null;
  active: boolean;
  /** The derived client price as listed now (null = not listed). */
  clientPricePaise: number | null;
  entertainmentClientPricePaise: number | null;
}

export interface CreatorPricedPage {
  assetId: string;
  kind: "facebook_page" | "instagram_account";
  platform: "facebook" | "instagram";
  name: string;
  username: string | null;
  followers: number | null;
  enabled: boolean;
  disconnected: boolean;
  /** Shown to clients right now (bookable and priced). */
  listed: boolean;
  category: string | null;
  formats: CreatorFormatPrice[];
}

export function useCreatorPricing(id: string | undefined) {
  return useSWR<CreatorPricedPage[]>(id ? `/admin/creators/${id}/pricing` : null, unwrap, { revalidateOnFocus: false });
}
