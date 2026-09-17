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
export type ActivityKind = "post" | "report" | "user" | "leave" | "announcement";
export type TractionKey = "views" | "engagements" | "reactions" | "shares";

export interface OverviewPayload {
  generatedAt: string;
  period: { days: number; start: string; end: string; prevStart: string; prevEnd: string; dataThroughDay: string | null };
  channels: { total: number; facebook: number; instagram: number };
  kpis: {
    followers: { value: number; delta: number | null; deltaDays: number | null; channelsWithHistory: number; spark: number[] };
    views: PeriodMetric;
    engagements: PeriodMetric;
    revenue: PeriodMetric;
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
  activity: Array<{ kind: ActivityKind; text: string; at: string }>;
  traction: {
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
  trending: Array<{ id: string; name: string; type: string; count: number; previousCount: number }>;
  pending: { approvals: number; employees: number; leave: number; documents: number; linksToday: number; submittedToday: number } | null;
}

export type OverviewPeriod = 7 | 14 | 30 | 90;
export type WidgetPeriod = 7 | 30 | 90;
