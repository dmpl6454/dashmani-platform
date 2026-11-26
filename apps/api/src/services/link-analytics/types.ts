// Link Analytics — the fetch-adapter contract (docs/link-analytics/SPEC.md §2-§5).
//
// An adapter turns a batch of posts into outcomes. The worker owns the queue, retries, snapshots
// and the call budget; an adapter only answers "what does the data source say about this post".
// Adding a platform or source later = one more adapter in adapters/index.ts.

import type { OauthGraphResult, CallBudget } from "../meta-oauth/oauth-graph";

export type LinkStatus = "pending" | "verified" | "restricted" | "failed";
export type LinkAccess = "full" | "public" | "none";
export type LinkDataSource = "meta_graph" | "meta_business_discovery" | "platform_sync" | "none";

/** Why a post is Restricted. The UI maps each to a sentence (RESTRICTED_REASON_TEXT). */
export type RestrictedReason =
  | "ig_no_username"
  | "ig_account_not_public"
  | "ig_post_not_in_recent_media"
  | "fb_not_our_page"
  | "fb_unresolvable_link"
  | "no_meta_connection";

export const RESTRICTED_REASON_TEXT: Record<RestrictedReason, string> = {
  ig_no_username:
    "Not on an Instagram account we've connected, and the link has no @username. Add the account's username so Meta's business discovery can look it up.",
  ig_account_not_public:
    "Meta's business discovery can't see this account: it is a personal or private account, or the username is wrong. Only business and creator accounts are readable.",
  ig_post_not_in_recent_media:
    "Business discovery found the account, but this post is older than the newest posts it can page through.",
  fb_not_our_page:
    "This Facebook post is on a Page or profile we don't administer. Meta shares no metrics for it without Page Public Content Access, which our apps don't have.",
  fb_unresolvable_link:
    "This Facebook share link doesn't reveal which post it is. Open it and copy the post's own link.",
  no_meta_connection:
    "No Meta account is connected, so nothing can be read. An admin connects one on Account Growth in the staff portal.",
};

export interface MetricValues {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
}

export const NO_VALUES: MetricValues = { views: null, reach: null, likes: null, comments: null, shares: null, saves: null };

export interface FetchTarget {
  /** link_posts.id */
  id: string;
  postKey: string;
  platform: "instagram" | "facebook";
  postType: string;
  canonicalUrl: string;
  /** IG username (from the URL or typed by staff) or FB page slug. */
  accountHint: string | null;
}

export type FetchOutcome =
  | {
      kind: "ok";
      status: "verified" | "restricted";
      access: LinkAccess;
      reason?: RestrictedReason;
      dataSource: LinkDataSource;
      metricsAt: Date;
      values: MetricValues;
      account?: { metaAssetId?: string | null; accountName?: string | null; username?: string | null; followers?: number | null; followersAt?: Date | null };
      post?: { externalId?: string | null; caption?: string | null; publishedAt?: Date | null; thumbnailUrl?: string | null; postType?: string };
      /** Set when an opaque FB link was resolved to a numeric post id. */
      newPostKey?: string;
    }
  | { kind: "restricted"; reason: RestrictedReason; newPostKey?: string }
  /** Permanent for now (deleted post, dead token): Failed until the next refresh. */
  | { kind: "failed"; message: string; newPostKey?: string }
  /** Try again later (throttle, network, 5xx). */
  | { kind: "transient"; message: string; newPostKey?: string };

export type GraphFn = <T = unknown>(path: string, params: Record<string, string | number | undefined>, token: string, label: string) => Promise<OauthGraphResult<T>>;

export interface AdapterContext {
  graph: GraphFn;
  budget: CallBudget;
  now: () => Date;
  /** One redirect:manual GET of an FB share link → numeric id, or null. */
  resolveOpaqueFacebook: (url: string) => Promise<string | null>;
  /** Highest Meta usage % seen this tick and Meta's regain estimate, for the worker's back-off. */
  usage: { maxPct: number; regainMinutes: number | null; rateLimited: boolean };
}

export interface LinkMetricsAdapter {
  name: string;
  handles(t: FetchTarget): boolean;
  fetch(targets: FetchTarget[], ctx: AdapterContext): Promise<Map<string, FetchOutcome>>;
}
