import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiFetch, fmtCompact, fmtDateTime, fmtDay, fmtUsdCents } from "@/lib/api";
import { colors, sizes, spacing, type } from "@/lib/theme";
import { Avatar, Chips, Empty, Field, IconButton, Screen, useApi, useDebounce } from "@/components/ui";
import { ListGroup, ListItem, StatGrid, StatTile } from "@/components/list";
import { AsyncBlock } from "@/components/async";
import { SkeletonList, SkeletonStatRow } from "@/components/skeleton";

// The ONLY windows Meta can answer (FB: day/week/days_28; IG caps spans at 30d).
// "today" is Instagram-only and deliberately partial — FB publishes only
// completed days, so its cells show dashes under Today.
const WINDOW_KEYS = ["day", "week", "days_28", "today"] as const;
type WinKey = (typeof WINDOW_KEYS)[number];

const WINDOW_LABELS: Record<WinKey, string> = {
  day: "Yesterday",
  week: "7d",
  days_28: "28d",
  today: "Today",
};

/** Longer wording for the stat tiles' hint line. */
const WINDOW_HINTS: Record<WinKey, string> = {
  day: "Yesterday",
  week: "Last 7 days",
  days_28: "Last 28 days",
  today: "Today so far",
};

const PLATFORM_FILTERS = ["all", "facebook", "instagram"] as const;
type PlatformFilter = (typeof PLATFORM_FILTERS)[number];

const PLATFORM_LABELS: Record<PlatformFilter, string> = {
  all: "All",
  facebook: "Facebook",
  instagram: "Instagram",
};

type Channel = {
  id: string;
  name: string;
  username?: string | null;
  platform?: string | null;
  pictureUrl?: string | null;
  metricsError?: string | boolean | null;
  followers?: number | null;
  followerDelta?: number | null;
  followerDeltaDays?: number | null;
  earningsCents?: number | null;
  views28d?: number | null;
  engagements28d?: number | null;
};

type Totals = {
  views?: number | null;
  engagements?: number | null;
  reach?: number | null;
  followers?: number | null;
  earningsCents?: number | null;
};

type GrowthResponse = {
  items?: Channel[] | null;
  totals?: Totals | null;
  channelCount?: number | null;
  dataThroughDay?: string | null;
  dayStarts?: { instagram?: string | null } | null;
  erroredChannels?: number | null;
};

/** null means "Meta does not publish this" — render a dash, never 0. */
function dashCompact(n: number | null | undefined): string {
  return n == null ? "—" : fmtCompact(n);
}

function fmtDelta(c: Channel): string | null {
  const d = c.followerDelta;
  if (d == null) return null;
  const sign = d >= 0 ? "+" : "−";
  const days = c.followerDeltaDays ? ` in ${c.followerDeltaDays}d` : "";
  return `${sign}${fmtCompact(Math.abs(d))}${days}`;
}

function channelItem(c: Channel): React.ReactElement {
  const isInstagram = c.platform === "instagram";
  const line1 = [
    c.metricsError ? "⚠ Not refreshed" : null,
    c.username ? `@${c.username}` : null,
    isInstagram ? "Instagram" : "Facebook",
  ]
    .filter((s): s is string => !!s)
    .join(" · ");
  const line2 = [
    `${dashCompact(c.followers)} followers`,
    fmtDelta(c),
    c.earningsCents != null && c.earningsCents > 0 ? `${fmtUsdCents(c.earningsCents)} earned` : null,
  ]
    .filter((s): s is string => !!s)
    .join(" · ");

  return (
    <ListItem
      key={c.id}
      title={c.name}
      subtitle={`${line1}\n${line2}`}
      icon={isInstagram ? "logo-instagram" : "logo-facebook"}
      tint={isInstagram ? "pink" : "blue"}
      leading={c.pictureUrl ? <Avatar name={c.name} uri={c.pictureUrl} size={sizes.iconTile + 4} /> : undefined}
      trailing={
        <View
          style={styles.metrics}
          accessible
          accessibilityLabel={`${dashCompact(c.views28d)} views, ${dashCompact(c.engagements28d)} engagements`}
        >
          <Text maxFontSizeMultiplier={1.3} style={styles.metricValue}>
            {dashCompact(c.views28d)}
          </Text>
          <Text maxFontSizeMultiplier={1.3} style={styles.metricLabel}>
            views
          </Text>
          <Text maxFontSizeMultiplier={1.3} style={styles.metricValueSmall}>
            {dashCompact(c.engagements28d)}
          </Text>
          <Text maxFontSizeMultiplier={1.3} style={styles.metricLabel}>
            engage
          </Text>
        </View>
      }
    />
  );
}

export default function AdminGrowth() {
  const [win, setWin] = useState<WinKey>("days_28");
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [search, setSearch] = useState("");
  const query = useDebounce(search.trim(), 350);

  const state = useApi<GrowthResponse>(
    () => {
      const qs = new URLSearchParams();
      qs.set("window", win);
      if (platform !== "all") qs.set("platform", platform);
      if (query) qs.set("q", query);
      return apiFetch<GrowthResponse>(`/admin/meta/channels?${qs.toString()}`);
    },
    [win, platform, query],
    { keepData: true },
  );

  const hint = WINDOW_HINTS[win];
  const filtered = query !== "" || platform !== "all";
  const clearFilters = () => {
    setSearch("");
    setPlatform("all");
  };

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <View style={styles.controls}>
        <Chips
          options={WINDOW_KEYS}
          value={win}
          onChange={setWin}
          labels={WINDOW_LABELS}
          accessibilityLabel="Time window"
        />
        <Chips
          options={PLATFORM_FILTERS}
          value={platform}
          onChange={setPlatform}
          labels={PLATFORM_LABELS}
          accessibilityLabel="Platform"
        />
        <Field
          value={search}
          onChangeText={setSearch}
          placeholder="Search channels"
          accessibilityLabel="Search channels"
          leading="search-outline"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          trailing={
            search ? (
              <IconButton
                icon="close-circle"
                label="Clear search"
                onPress={() => setSearch("")}
                glyph={18}
                tint={colors.faint}
              />
            ) : undefined
          }
        />
      </View>

      <AsyncBlock
        state={state}
        skeleton={
          <>
            <SkeletonStatRow count={3} />
            <SkeletonList rows={5} tile />
          </>
        }
      >
        {(data) => {
          const items: Channel[] = Array.isArray(data.items) ? data.items : [];
          const totals = data.totals;
          const count = data.channelCount ?? items.length;
          return (
            <View style={state.fetching && !state.refreshing ? styles.stale : null}>
              {/* Summary tiles — followers is a STOCK (now), the rest are the period's flows */}
              {totals ? (
                <>
                  <StatGrid columns={3}>
                    <StatTile compact label="Views" value={dashCompact(totals.views)} hint={hint} />
                    <StatTile compact label="Engage" value={dashCompact(totals.engagements)} hint={hint} />
                    <StatTile compact label="Reach" value={dashCompact(totals.reach)} hint={hint} />
                  </StatGrid>
                  <StatGrid columns={2} style={styles.gridGap}>
                    <StatTile label="Followers" value={dashCompact(totals.followers)} hint="Now" />
                    <StatTile
                      label="Revenue"
                      value={fmtUsdCents(totals.earningsCents)}
                      valueColor={colors.greenText}
                      tone="success"
                      hint={hint}
                    />
                  </StatGrid>
                </>
              ) : null}

              {/* The last CLOSED calendar day the figures cover (dataThrough is the instant that day
                  closed — rendering it as a time read a day late). Today's figures are partial and
                  start at each platform's own midnight. */}
              {win === "today" && data.dayStarts ? (
                <Text maxFontSizeMultiplier={1.6} style={styles.note}>
                  So far today · Instagram since {fmtDateTime(data.dayStarts.instagram)} · Facebook publishes no
                  figure until its day closes
                </Text>
              ) : data.dataThroughDay ? (
                <Text maxFontSizeMultiplier={1.6} style={styles.note}>
                  Figures through {fmtDay(data.dataThroughDay, { year: true })}
                </Text>
              ) : null}
              {data.erroredChannels ? (
                <Text maxFontSizeMultiplier={1.6} style={[styles.note, styles.warning]}>
                  {data.erroredChannels} channel(s) couldn&apos;t be refreshed (marked ⚠) — their last good figures
                  are still counted.
                </Text>
              ) : null}

              {items.length === 0 ? (
                filtered ? (
                  <Empty
                    icon="search-outline"
                    title="No matches"
                    text="No connected channels match this search or filter."
                    action={{ label: "Show all", onPress: clearFilters }}
                  />
                ) : (
                  <Empty icon="trending-up-outline" title="No connected channels" text="Connect a Facebook page or Instagram account on the web portal." />
                )
              ) : (
                <ListGroup
                  title={`Connected channels · ${count}`}
                  footer={
                    "A dash means Meta doesn't publish that metric for the channel — not zero. \"Today\" is Instagram-only; Facebook publishes completed days only."
                  }
                >
                  {items.map(channelItem)}
                </ListGroup>
              )}
            </View>
          );
        }}
      </AsyncBlock>
    </Screen>
  );
}

const styles = StyleSheet.create({
  controls: { gap: spacing.sm, marginBottom: spacing.md },
  gridGap: { marginTop: spacing.sm },
  stale: { opacity: 0.6 },
  note: { ...type.footnote, color: colors.sub, marginTop: spacing.md },
  warning: { color: colors.warningText },
  metrics: { alignItems: "flex-end", marginLeft: spacing.sm },
  metricValue: { ...type.subhead, ...type.numeric, fontWeight: "700", color: colors.purpleText },
  metricValueSmall: { ...type.caption, ...type.numeric, fontWeight: "700", color: colors.ink, marginTop: 2 },
  metricLabel: { ...type.caption2, color: colors.sub },
});
