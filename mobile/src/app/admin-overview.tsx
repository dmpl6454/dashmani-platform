import React, { useState } from "react";
import { Image, Linking, StyleSheet, Text, View } from "react-native";
import { apiFetch, fmtCompact, fmtDateTime, fmtDay, fmtRange, fmtUsdCents } from "@/lib/api";
import { colors, radius, spacing, toneColors, type } from "@/lib/theme";
import type { Tone } from "@/lib/theme";
import { Avatar, Card, Chips, Empty, Screen, SectionTitle, useApi } from "@/components/ui";
import { AsyncBlock } from "@/components/async";
import { ListGroup, ListItem, StatGrid, StatTile } from "@/components/list";
import { SkeletonList, SkeletonStatRow } from "@/components/skeleton";
import { toast } from "@/components/feedback";

// Overview — the phone-sized version of portal.digitalsukoon.com/overview (GET /admin/overview,
// open to every internal user). Same accuracy rules as the web page:
//  • a figure nobody reported is null and renders "—", never 0, with the reason beside it;
//  • reach exists only for Meta's own 7-day and 28-day windows (unique people cannot be summed);
//  • every window ends on the last CLOSED day (the server's dataThroughDay), which is said on screen;
//  • revenue is USD (Meta pays in dollars).

const PERIODS = ["7", "14", "30", "90"] as const;
type Period = (typeof PERIODS)[number];
const PERIOD_LABELS: Record<Period, string> = { "7": "7 days", "14": "14 days", "30": "30 days", "90": "90 days" };

const CHANNEL_TABS = ["all", "facebook", "instagram"] as const;
type ChannelTab = (typeof CHANNEL_TABS)[number];
const CHANNEL_TAB_LABELS: Record<ChannelTab, string> = { all: "All", facebook: "Facebook", instagram: "Instagram" };

type MetaPlatform = "facebook" | "instagram";

type Trend = { pct: number | null; reliable: boolean };

type PeriodMetric = { value: number | null; trend: Trend | null };

type Channel = {
  id: string;
  metaId: string;
  name: string;
  username: string | null;
  platform: MetaPlatform;
  pictureUrl?: string | null;
  followers: number | null;
  views: number | null;
  earningsCents: number | null;
};

type LatestPost = {
  id: string;
  title: string;
  permalink: string | null;
  postedAt: string;
  views: number | null;
  thumbnailUrl: string | null;
  channel: { name: string; platform: MetaPlatform } | null;
};

type TrendingTopic = {
  id: string;
  name: string;
  count: number;
  changePct: number | null;
};

type Overview = {
  period: { days: number; start: string; end: string; dataThroughDay: string | null };
  channels: { total: number; complete: number; errored: number } | null;
  kpis: {
    followers: { value: number | null; delta: number | null; deltaDays: number | null; channelsWithHistory: number };
    views: PeriodMetric;
    engagements: PeriodMetric;
    revenue: PeriodMetric & { earning: number };
    reach: { value: number | null; window: "week" | "days_28" | null };
  };
  topChannels?: Channel[];
  topChannelsFacebook?: Channel[];
  topChannelsInstagram?: Channel[];
  latestPosts?: LatestPost[];
  trending?: TrendingTopic[];
  trendingWindow?: { captionsThisWeek: number; captionsLastWeek: number } | null;
};

const dash = (n: number | null | undefined): string => (n == null ? "—" : fmtCompact(n));

const signed = (n: number): string => `${n >= 0 ? "+" : "-"}${fmtCompact(Math.abs(n))}`;

const platformName = (p: MetaPlatform): string => (p === "instagram" ? "Instagram" : "Facebook");

/** ▲/▼ percentage chip for a StatTile; "*" marks a trend whose baseline period isn't fully covered. */
function trendDelta(trend: Trend | null | undefined): { value: string; tone: Tone } | undefined {
  if (!trend || trend.pct == null) return undefined;
  const up = trend.pct >= 0;
  return {
    value: `${up ? "▲" : "▼"} ${Math.abs(trend.pct).toFixed(1)}%${trend.reliable ? "" : "*"}`,
    tone: up ? "success" : "danger",
  };
}

/** Facebook opens by its numeric Page id (always present, permanent); Instagram by username (no id URL exists). */
function metaUrl(c: { platform: MetaPlatform; metaId: string; username: string | null }): string | null {
  if (c.platform === "facebook") return /^\d+$/.test(c.metaId) ? `https://www.facebook.com/${c.metaId}` : null;
  return c.username ? `https://www.instagram.com/${encodeURIComponent(c.username)}/` : null;
}

function openExternal(url: string): void {
  Linking.openURL(url).catch(() => {
    toast.show({ message: "Couldn't open the link on this device.", tone: "danger" });
  });
}

function OverviewSkeleton() {
  return (
    <View>
      <SkeletonStatRow count={2} />
      <SkeletonStatRow count={2} />
      <SkeletonList rows={5} tile />
    </View>
  );
}

export default function AdminOverview() {
  const [period, setPeriod] = useState<Period>("30");
  const [tab, setTab] = useState<ChannelTab>("all");

  const state = useApi<Overview>(() => apiFetch<Overview>(`/admin/overview?days=${period}`), [period], {
    keepData: true,
  });
  const switching = state.fetching && !state.refreshing && state.data !== null;

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <View style={styles.periodPicker}>
        <Chips options={PERIODS} value={period} onChange={setPeriod} labels={PERIOD_LABELS} accessibilityLabel="Period" />
      </View>

      <AsyncBlock state={state} skeleton={<OverviewSkeleton />}>
        {(o) => (
          <View style={switching ? styles.dimmed : null} accessibilityState={{ busy: switching }}>
            <OverviewBody o={o} fallbackDays={Number(period)} tab={tab} onTab={setTab} />
          </View>
        )}
      </AsyncBlock>
    </Screen>
  );
}

function OverviewBody({
  o,
  fallbackDays,
  tab,
  onTab,
}: {
  o: Overview;
  fallbackDays: number;
  tab: ChannelTab;
  onTab: (t: ChannelTab) => void;
}) {
  const k = o.kpis;
  const days = o.period?.days ?? fallbackDays;
  const channels = o.channels;

  const windowLine = [
    o.period ? fmtRange(o.period.start, o.period.end) : null,
    `figures through ${o.period?.dataThroughDay ? fmtDay(o.period.dataThroughDay, { weekday: false, year: true }) : "—"}`,
    channels
      ? `${channels.total} channels (${channels.complete} complete for the period${channels.errored ? `, ${channels.errored} with errors` : ""})`
      : null,
  ]
    .filter((s): s is string => !!s)
    .join(" · ");

  const reachHint =
    k?.reach?.value == null ? `No ${days}-day reach` : k.reach.window === "week" ? "Meta's 7-day window" : "Meta's 28-day window";
  const reachNote =
    k?.reach?.value == null
      ? `Reach: Meta publishes no ${days}-day reach — pick 7 or 30 days.`
      : `Reach: unique accounts summed across channels (Meta's ${k.reach.window === "week" ? "7-day" : "28-day"} window).`;

  const followers = k?.followers;
  const followersHint =
    followers?.delta != null ? `${signed(followers.delta)} over ${followers.deltaDays ?? days}d` : "No history for this period";
  const followersNote =
    followers?.delta != null
      ? `Followers: change measured over ${followers.channelsWithHistory ?? 0}/${channels?.total ?? "—"} channels.`
      : "Followers: follower history doesn't cover this period yet.";

  const revenueHint = k?.revenue?.value != null ? `${k.revenue.earning ?? 0} Pages earned · USD` : "No earnings reported";

  const top: Channel[] =
    (tab === "facebook" ? o.topChannelsFacebook : tab === "instagram" ? o.topChannelsInstagram : o.topChannels) ?? [];
  const posts = (o.latestPosts ?? []).slice(0, 8);
  const trending = (o.trending ?? []).slice(0, 8);

  return (
    <>
      <Text style={styles.window}>{windowLine}</Text>

      <StatGrid>
        <StatTile
          label="Views"
          icon="eye-outline"
          value={dash(k?.views?.value)}
          delta={trendDelta(k?.views?.trend)}
          hint={k?.views?.value == null ? "No channel reported views" : undefined}
        />
        <StatTile
          label="Engagements"
          icon="heart-outline"
          tone="danger"
          value={dash(k?.engagements?.value)}
          delta={trendDelta(k?.engagements?.trend)}
        />
        <StatTile label="Total reach" icon="people-outline" tone="info" value={dash(k?.reach?.value)} hint={reachHint} />
        <StatTile label="Followers (now)" icon="person-add-outline" tone="success" value={dash(followers?.value)} hint={followersHint} />
        <StatTile
          label="Revenue"
          icon="cash-outline"
          tone="warning"
          value={fmtUsdCents(k?.revenue?.value)}
          delta={trendDelta(k?.revenue?.trend)}
          hint={revenueHint}
        />
      </StatGrid>
      <Text style={styles.foot}>
        {reachNote}
        {"\n"}
        {followersNote}
        {"\n"}
        ▲▼ compare with the {days} days before. * = the earlier period isn't fully covered, so treat that trend as rough. A dash
        means nothing was reported — not zero.
      </Text>

      <SectionTitle>Top channels · views</SectionTitle>
      <View style={styles.tabPicker}>
        <Chips options={CHANNEL_TABS} value={tab} onChange={onTab} labels={CHANNEL_TAB_LABELS} accessibilityLabel="Platform" />
      </View>
      {top.length === 0 ? (
        <Card>
          <Empty compact icon="stats-chart-outline" text="No channel reported views for this period" />
        </Card>
      ) : (
        <ListGroup footer={`Views over the selected ${days} days. Tap a channel to open it.`}>
          {top.map((c, i) => {
            const url = metaUrl(c);
            const subtitle = `${platformName(c.platform)} · ${dash(c.followers)} followers${
              c.earningsCents ? ` · ${fmtUsdCents(c.earningsCents)}` : ""
            }`;
            return (
              <ListItem
                key={c.id}
                title={`${i + 1}. ${c.name}`}
                subtitle={subtitle}
                detail={dash(c.views)}
                leading={<Avatar name={c.name} uri={c.pictureUrl} size={36} />}
                onPress={url ? () => openExternal(url) : undefined}
                accessibilityLabel={`${i + 1}. ${c.name}, ${subtitle}, ${dash(c.views)} views`}
                accessibilityHint={url ? `Opens the channel on ${platformName(c.platform)}` : undefined}
              />
            );
          })}
        </ListGroup>
      )}

      <SectionTitle>Latest posts</SectionTitle>
      {posts.length === 0 ? (
        <Card>
          <Empty compact icon="images-outline" text="No posts synced yet" />
        </Card>
      ) : (
        <ListGroup footer="Synced from the connected Meta account about every 3 hours.">
          {posts.map((p) => {
            const permalink = p.permalink;
            const subtitle = `${p.channel?.platform === "instagram" ? "IG" : "FB"} · ${p.channel?.name ?? "—"} · ${fmtDateTime(
              p.postedAt,
            )}`;
            return (
              <ListItem
                key={p.id}
                title={p.title || "(no caption)"}
                lines={2}
                subtitle={subtitle}
                detail={`${dash(p.views)} views`}
                leading={p.thumbnailUrl ? <Image source={{ uri: p.thumbnailUrl }} style={styles.thumb} /> : undefined}
                icon={p.thumbnailUrl ? undefined : "image-outline"}
                tint="gray"
                onPress={permalink ? () => openExternal(permalink) : undefined}
                accessibilityHint={permalink ? "Opens the post" : undefined}
              />
            );
          })}
        </ListGroup>
      )}

      <SectionTitle>What's trending</SectionTitle>
      {trending.length === 0 ? (
        <Card>
          <Empty compact icon="flame-outline" text="Nothing trending this week" />
        </Card>
      ) : (
        <ListGroup>
          {trending.map((t, i) => {
            const isNew = t.changePct == null;
            const up = !isNew && (t.changePct ?? 0) >= 0;
            const changeColor = isNew
              ? toneColors("brand").text
              : up
                ? toneColors("success").text
                : toneColors("danger").text;
            const changeText = isNew ? "new" : `${up ? "▲" : "▼"} ${Math.abs(t.changePct ?? 0).toFixed(0)}%`;
            return (
              <ListItem
                key={t.id}
                title={`${i + 1}. ${t.name}`}
                subtitle={`${t.count.toLocaleString("en-IN")} posts this week`}
                trailing={<Text style={[styles.change, { color: changeColor }]}>{changeText}</Text>}
              />
            );
          })}
        </ListGroup>
      )}
      <Text style={styles.foot}>
        From captions harvested from our connected channels' feeds, not only the links the team submitted. The change compares each
        topic's share of this week's captions with last week's
        {o.trendingWindow
          ? ` (${o.trendingWindow.captionsThisWeek.toLocaleString("en-IN")} vs ${o.trendingWindow.captionsLastWeek.toLocaleString(
              "en-IN",
            )} captions)`
          : ""}
        .
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  periodPicker: { marginBottom: spacing.md },
  tabPicker: { marginBottom: spacing.md },
  dimmed: { opacity: 0.55 },
  window: { ...type.footnote, color: colors.sub, marginBottom: spacing.md, lineHeight: 18 },
  foot: { ...type.caption, color: colors.sub, marginTop: spacing.sm, marginBottom: spacing.md, lineHeight: 17 },
  thumb: { width: 44, height: 44, borderRadius: radius.tile, backgroundColor: colors.cardHigh },
  change: { ...type.subhead, ...type.numeric, fontWeight: "700", marginLeft: spacing.sm },
});
