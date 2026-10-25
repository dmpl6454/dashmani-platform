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
