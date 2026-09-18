// Mirror of apps/api/src/services/overview.service.ts → OverviewPayload.
// Kept by hand: the API is the source of truth, this file just types the wire.

export interface Trend {
  pct: number;
  reliable: boolean;
}

export interface PeriodMetric {
  value: number | null;
  previous: number | null;
  trend: Trend | null;
  contributing: number;
  spark: number[];
}

/** The search/drawer subset — no pictureUrl (a ~397-char Meta CDN URL nothing here renders). */
export type ChannelDirectoryRow = Omit<ChannelRow, "pictureUrl">;

export interface ChannelRow {
  id: string;
  metaId: string;
  name: string;
  username: string | null;
  platform: "facebook" | "instagram";
  pictureUrl: string | null;
  followers: number | null;
  views: number | null;
  earningsCents: number | null;
  followerDelta: number | null;
  followerDeltaDays: number | null;
}

export type CityTier = "high" | "growing" | "emerging";
/** ⚠️ No "leave": a named person's leave type/status must not ride a payload served to
 *  every internal user. Removing it from the union makes re-adding it a compile error. */
export type ActivityKind = "post" | "report" | "user" | "announcement";
export type TractionKey = "views" | "engagements" | "reactions" | "shares";

export interface OverviewPayload {
  generatedAt: string;
  period: {
    days: number; start: string; end: string; prevStart: string; prevEnd: string;
    dataThroughDay: string | null;
    /** True when the window came from an explicit start/end rather than a preset. */
    custom: boolean;
    /** The last closed day, when the requested end was later than it. */
    clampedTo: string | null;
  };
  channels: {
    total: number; facebook: number; instagram: number;
    /** Channels whose stored history covers every day of the window. */
    complete: number;
    /** Channels whose latest window fetch carries a Meta error (figures still counted). */
    errored: number;
  };
  /** Every live channel, followers-desc — what the header search searches. */
  allChannels: ChannelDirectoryRow[];
  kpis: {
    followers: { value: number; delta: number | null; deltaDays: number | null; channelsWithHistory: number;
      /** Follower stock of just those channels — the like-for-like denominator. */
      followersWithHistory: number | null; spark: number[] };
    views: PeriodMetric;
    engagements: PeriodMetric;
    /** `contributing` = Pages that REPORTED a figure (includes exact zeros, 317 on prod
     *  at every period); `earning` = Pages actually above zero (57 at 14d). Label each
     *  for what it is — conflating them is what made this card read "317 pages earning". */
    revenue: PeriodMetric & { earning: number };
    reach: { value: number | null; window: "week" | "days_28" | null; contributing: number };
  };
  audience: {
    days: number;
    series: Array<{ date: string; followers: number }>;
    channelsUsed: number;
    channelsLinked: number;
    delta: number | null;
  };
  revenue: {
    days: number;
    series: Array<{ date: string; cents: number | null; cumulativeCents: number }>;
    totalCents: number | null;
    previousCents: number | null;
    trend: Trend | null;
  };
  viewsByChannel: Array<{ id: string | null; name: string; platform: "facebook" | "instagram" | null; views: number; share: number }>;
  /** Every channel over the Views-by-Channel window, for the expanded view. */
  viewsByChannelAll: Array<{ id: string; name: string; platform: "facebook" | "instagram"; views: number; share: number }>;
  /** Effective period of that card (equals period.days unless detached). */
  viewsByChannelDays: number;
  /** Total views over THAT card's own window — the donut centre must use this, never
   *  kpis.views.value, which is always the global period (measured 12x apart on prod). */
  viewsByChannelTotal: number;
  topChannels: ChannelRow[];
  revenueByChannel: ChannelRow[];
  cities: {
    total: number;
    indiaShare: number;
    assets: number;
    items: Array<{ name: string; state: string | null; value: number; share: number; tier: CityTier }>;
  };
  latestPosts: Array<{
    id: string;
    title: string;
    permalink: string | null;
    postedAt: string;
    views: number | null;
    likes: number | null;
    comments: number | null;
    mediaProductType: string | null;
    channel: { name: string; username: string | null; platform: "facebook" | "instagram"; pictureUrl: string | null };
  }>;
  /** `postId` opens the post drawer; `href` is an in-portal route. Both nullable. */
  activity: Array<{ kind: ActivityKind; text: string; at: string; postId: string | null; href: string | null }>;
  traction: {
    /** Effective period of this card (equals period.days unless detached). */
    days: number;
    start: string;
    end: string;
    prevStart: string;
    prevEnd: string;
    tiles: Array<{ key: TractionKey; label: string; value: number | null; previous: number | null; pct: number | null }>;
    series: Array<{ date: string; views: number | null; engagements: number | null; reactions: number | null; shares: number | null }>;
  };
  demographics: {
    assets: number;
    age: Array<{ bucket: string; value: number }>;
    gender: Array<{ bucket: string; label: string; value: number }>;
    country: Array<{ bucket: string; value: number }>;
  };
  trending: Array<{
    id: string; name: string; type: string; count: number; previousCount: number;
    share: number | null; previousShare: number | null;
    /** Change in SHARE of harvested captions, not in raw count — null when nothing to compare. */
    changePct: number | null;
    firstSeenThisWeek: boolean;
  }>;
  trendingWindow: { captionsThisWeek: number; captionsLastWeek: number };
  pending: { approvals: number; employees: number; leave: number; documents: number; linksToday: number; submittedToday: number } | null;
}

export type OverviewPeriod = 7 | 14 | 30 | 90;
/** 0 = follow the global period — the default for every card. */
export type WidgetPeriod = 0 | 7 | 14 | 30 | 90;
