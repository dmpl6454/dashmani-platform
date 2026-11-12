"use client";
// The creator review queue (/v1/sales/creators*) — the same data the staff portal's /creators
// shows, served by apps/api services/creator/creator-admin.service.ts.
import useSWR, { type SWRConfiguration } from "swr";
import { fetcher } from "./api";

export const CREATOR_STATUSES = ["in_review", "approved", "rejected", "suspended", "draft", "closed"] as const;
export type CreatorStatus = (typeof CREATOR_STATUSES)[number];

export const CREATOR_STATUS_LABEL: Record<string, string> = {
  in_review: "In review",
  approved: "Approved",
  draft: "Setting up",
  rejected: "Not approved",
  suspended: "Suspended",
  closed: "Closed",
};

export const CONNECTION_LABEL: Record<string, string> = {
  ACTIVE: "Connected",
  PARTIAL_SCOPE: "Missing permissions",
  NEEDS_REAUTH_SOON: "Reconnect soon",
  NEEDS_REAUTH: "Needs reconnect",
  REVOKED: "Disconnected",
};

/** Plain sentences for NOT_ENABLEABLE's reason (the API puts the machine code in `details`). */
export const BLOCK_REASON: Record<string, string> = {
  creator_not_approved: "Approve the creator before turning their pages on.",
  disconnected: "This page is disconnected — the creator must reconnect it first.",
  connection_not_live: "The creator's Facebook connection has lapsed — they must reconnect it first.",
  network_duplicate: "This page is already on our network, so it can't be offered as a creator page.",
  cannot_publish: "We can't publish to this page through the API yet.",
};

export interface CreatorRow {
  id: string;
  name: string;
  email: string;
  country: string | null;
  status: string;
  submittedAt: string | null;
  createdAt: string;
  pages: number;
  publishablePages: number;
  followers: number;
  connectionStatus: string | null;
}

export interface CreatorList {
  creators: CreatorRow[];
  counts: Record<CreatorStatus, number>;
}

export interface CreatorAsset {
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
  networkDuplicateOfName: string | null;
  enabled: boolean;
  disconnected: boolean;
  views28d: number | null;
  engagements28d: number | null;
  metricsFetchedAt: string | null;
  tasks: string[];
  /** Formats brands can book right now (needs the creator's price and our margin). */
  listedFormats?: string[];
}

export interface CreatorDetail {
  creator: {
    id: string;
    email: string;
    name: string;
    country: string | null;
    phone: string | null;
    status: string;
    emailVerified: boolean;
    termsAccepted: boolean;
    submittedAt: string | null;
    createdAt: string;
    reviewNote: string | null;
    reviewedAt: string | null;
    reviewedByName: string | null;
    closedAt: string | null;
  };
  connection: {
    status: string;
    metaUserName: string | null;
    missingScopes: string[];
    tokenExpiresAt: string | null;
    dataAccessExpiresAt: string | null;
    discoveryState: string;
    lastError: string | null;
    connectedAt: string;
  } | null;
  assets: CreatorAsset[];
}

const opts: SWRConfiguration = { revalidateOnFocus: false, dedupingInterval: 10_000, keepPreviousData: true };

export const useCreators = (status: string, q: string) => {
  const p = new URLSearchParams();
  if (status) p.set("status", status);
  if (q.trim()) p.set("q", q.trim());
  const s = p.toString();
  return useSWR<CreatorList>(`/sales/creators${s ? `?${s}` : ""}`, fetcher, opts);
};

export const useCreator = (id: string | null) => useSWR<CreatorDetail>(id ? `/sales/creators/${id}` : null, fetcher, opts);
