// Shapes of the creator API (see the Phase A contract). Kept here, not in @dashmani/shared,
// because only this app reads them.
import type { CreatorStatus, CreatorAssetKind } from "@dashmani/shared/src/validators/creator";

export type { CreatorStatus, CreatorAssetKind };

export interface CreatorMe {
  id: string;
  email: string;
  name: string;
  country: string | null;
  phone: string | null;
  status: CreatorStatus;
  emailVerified: boolean;
  termsAccepted: boolean;
  submittedAt: string | null;
  /** Only present when the account is rejected or suspended. */
  reviewNote: string | null;
  createdAt: string;
  /** Whether we post accepted bookings for creators. While false, the creator posts every one. */
  autoPost?: boolean;
}

export interface CreatorChecklist {
  emailVerified: boolean;
  connected: boolean;
  publishablePages: number;
  submitted: boolean;
}

export type CreatorMeWithChecklist = CreatorMe & { checklist: CreatorChecklist };

export interface CreatorSession {
  accessToken: string;
  refreshToken: string;
  creator: CreatorMe;
}

export interface CreatorAssetView {
  id: string;
  kind: CreatorAssetKind;
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
}

export interface ConnectionView {
  /** ACTIVE | PARTIAL_SCOPE | NEEDS_REAUTH_SOON | NEEDS_REAUTH | REVOKED */
  status: string;
  metaUserName: string | null;
  grantedScopes: string[];
  missingScopes: string[];
  tokenExpiresAt: string | null;
  dataAccessExpiresAt: string | null;
  /** pending | running | done | failed */
  discoveryState: string;
  lastError: string | null;
  connectedAt: string;
}

export interface ConnectionPayload {
  connection: ConnectionView | null;
  assets: CreatorAssetView[];
}

/** A booked post offered to this creator (GET /v1/creator/offers[/:id]). No client identity, no client price. */
export interface CreatorOffer {
  id: string;
  status: string;
  platform: "instagram" | "facebook";
  format: string;
  formatLabel: string;
  page: { id: string; name: string; handle: string | null };
  campaign: { name: string; brand: string; type: string; launchFrom: string | null; launchTo: string | null; songTrack: string | null };
  caption: string;
  hashtags: string[];
  userTags: string[];
  collaborators: string[];
  payoutPaise: number | null;
  offeredAt: string | null;
  respondBy: string | null;
  decidedAt: string | null;
  declineReason: string | null;
  scheduledFor: string | null;
  permalink: string | null;
  postedAt: string | null;
  /** Why you post this one yourself, when there is a reason specific to it (shown while you post it). */
  note: string | null;
  /** Whether we post accepted bookings for creators at all right now. */
  autoPost?: boolean;
  canAccept: boolean;
  canDecline: boolean;
  canRecordPost: boolean;
  /** Only on GET /creator/offers/:id: the exact files that would be posted, as signed paths. */
  files?: Array<{ kind: string; role: string; ready: boolean; url: string }>;
}

export interface CreatorOfferList {
  offers: CreatorOffer[];
  autoPost?: boolean;
  counts: { waiting: number; toPost: number; payoutAcceptedPaise: number };
}

/** GET /v1/creator/prices — the creator's own price per page and format (= their payout). */
export interface CreatorPagePrices {
  assetId: string;
  platform: "instagram" | "facebook";
  name: string;
  username: string | null;
  enabled: boolean;
  prices: Array<{ format: "reel" | "post" | "carousel"; pricePaise: number | null; updatedAt: string | null }>;
}
