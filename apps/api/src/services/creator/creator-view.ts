import type { Creator, CreatorAsset, CreatorConnection } from "@dashmani/db";

// The ONE place a creator row becomes JSON. ⚠️ Never return a token column (*_enc), the
// password hash, or payout details from anywhere else — every endpoint goes through these.

/** Scopes a creator connection must grant for publishing to work. */
export const CREATOR_REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
] as const;

/**
 * Connection statuses whose tokens still work. NEEDS_REAUTH (the token or the grant is gone)
 * and REVOKED are not: a page on such a connection cannot be submitted, enabled or booked.
 */
export const LIVE_CONNECTION_STATUSES = ["ACTIVE", "PARTIAL_SCOPE", "NEEDS_REAUTH_SOON"] as const;
/** Prisma filter for a CreatorAsset whose connection is live (see LIVE_CONNECTION_STATUSES). */
export const liveConnectionWhere = { revokedAt: null, status: { in: [...LIVE_CONNECTION_STATUSES] } };

/**
 * Discovery is fire-and-forget; an API restart mid-pass leaves discovery_state "running" for
 * good. Past this age (measured from the row's updatedAt, which the "running" write stamps) it
 * reads as interrupted, and Refresh is allowed again.
 */
export const DISCOVERY_STALE_MS = 10 * 60 * 1000;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const num = (b: bigint | number | null | undefined) => (b == null ? null : Number(b));

export function toCreatorMe(c: Creator) {
  return {
    id: c.id,
    email: c.email,
    name: c.name,
    country: c.country,
    phone: c.phone,
    status: c.status,
    emailVerified: c.emailVerifiedAt != null,
    termsAccepted: c.termsAcceptedAt != null,
    submittedAt: iso(c.submittedAt),
    // Only shown to the creator when it explains their current state.
    reviewNote: c.status === "rejected" || c.status === "suspended" ? c.reviewNote : null,
    createdAt: c.createdAt.toISOString(),
  };
}
export type CreatorMe = ReturnType<typeof toCreatorMe>;

export function profileUrl(a: Pick<CreatorAsset, "kind" | "metaId" | "username">): string | null {
  if (a.kind === "facebook_page") return `https://www.facebook.com/${a.metaId}`;
  return a.username ? `https://www.instagram.com/${encodeURIComponent(a.username)}/` : null;
}

export function toAssetView(a: CreatorAsset) {
  return {
    id: a.id,
    kind: a.kind as "facebook_page" | "instagram_account",
    metaId: a.metaId,
    name: a.name,
    username: a.username,
    pictureUrl: a.pictureUrl,
    profileUrl: profileUrl(a),
    followerCount: a.followerCount,
    mediaCount: a.mediaCount,
    canPublish: a.canPublish,
    publishProbeError: a.publishProbeError,
    networkDuplicate: a.networkDuplicateOf != null,
    enabled: a.enabled,
    disconnected: a.disconnectedAt != null,
    views28d: num(a.views28d),
    engagements28d: num(a.engagements28d),
    metricsFetchedAt: iso(a.metricsFetchedAt),
  };
}
export type CreatorAssetView = ReturnType<typeof toAssetView>;

export function toConnectionView(c: CreatorConnection, now: Date = new Date()) {
  const granted = c.grantedScopes ? c.grantedScopes.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const interrupted = c.discoveryState === "running" && now.getTime() - c.updatedAt.getTime() >= DISCOVERY_STALE_MS;
  return {
    status: c.status,
    metaUserName: c.metaUserName,
    grantedScopes: granted,
    missingScopes: CREATOR_REQUIRED_SCOPES.filter((s) => !granted.includes(s)),
    tokenExpiresAt: iso(c.tokenExpiresAt),
    dataAccessExpiresAt: iso(c.dataAccessExpiresAt),
    discoveryState: interrupted ? "failed" : c.discoveryState,
    lastError: interrupted ? "Checking your pages was interrupted. Press “Check pages again”." : c.lastError,
    connectedAt: c.createdAt.toISOString(),
  };
}
export type ConnectionView = ReturnType<typeof toConnectionView>;

/** A page that can be submitted for review / offered for booking. */
export const isPublishable = (a: Pick<CreatorAsset, "canPublish" | "networkDuplicateOf" | "disconnectedAt">) =>
  a.canPublish && a.networkDuplicateOf == null && a.disconnectedAt == null;
