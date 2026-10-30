import React, { useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { apiFetch, daysAgoIST, fmtCompact, todayIST } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { Chips, Empty, Screen, useApi } from "@/components/ui";
import { ListGroup, ListItem, StatGrid, StatTile } from "@/components/list";
import { AsyncBlock } from "@/components/async";
import { SkeletonList, SkeletonStatRow } from "@/components/skeleton";
import { toast } from "@/components/feedback";

const PLATFORMS = ["youtube", "instagram", "facebook", "snapchat"] as const;
type PlatformKey = (typeof PLATFORMS)[number];
const PLATFORM_LABELS: Record<PlatformKey, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  snapchat: "Snapchat",
};

const WINDOWS = ["7D", "30D", "ALL"] as const;
type Win = (typeof WINDOWS)[number];
const WINDOW_LABELS: Record<Win, string> = { "7D": "7 days", "30D": "30 days", ALL: "All time" };

const NOTE = "A dash means the platform doesn't publish that metric. Metrics refresh on a 2-hour cycle.";

type TopLink = {
  linkId?: string | null;
  url?: string | null;
  employeeName?: string | null;
  employee?: { name?: string | null } | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
};

type InsightsSummary = {
  totalViews?: number | null;
  views?: number | null;
  totalLikes?: number | null;
  likes?: number | null;
  totalComments?: number | null;
  comments?: number | null;
};

type TopLinksData = { links: TopLink[]; summary: InsightsSummary | null };

function openLink(url: string): void {
  Linking.openURL(url).catch(() => toast.show({ message: "Couldn't open this link", tone: "danger" }));
}

function dash(n: number | null | undefined): string {
  return n == null ? "—" : fmtCompact(n);
}

export default function AdminTopLinks() {
  const [platform, setPlatform] = useState<PlatformKey>("instagram");
  const [win, setWin] = useState<Win>("30D");

  const range = win === "ALL" ? "" : `&startDate=${daysAgoIST(win === "7D" ? 6 : 29)}&endDate=${todayIST()}`;

  const state = useApi<TopLinksData>(
    async () => {
      const [links, summary] = await Promise.allSettled([
        apiFetch<TopLink[]>(`/admin/reports/top-links?platform=${platform}&limit=20${range}`),
        apiFetch<InsightsSummary>(`/admin/reports/insights-summary?${range.slice(1)}`),
      ]);
      // The ranking is the screen: a failed ranking is a failed load, never "no links".
      // The summary is optional — its tiles are simply hidden when it fails.
      if (links.status === "rejected") throw links.reason;
      return {
        links: Array.isArray(links.value) ? links.value : [],
        summary: summary.status === "fulfilled" ? summary.value ?? null : null,
      };
    },
    [platform, win],
    { keepData: true },
  );

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <View style={styles.controls}>
        <Chips options={WINDOWS} value={win} onChange={setWin} labels={WINDOW_LABELS} accessibilityLabel="Time window" />
        <Chips
          options={PLATFORMS}
          value={platform}
          onChange={setPlatform}
          labels={PLATFORM_LABELS}
          accessibilityLabel="Platform"
        />
      </View>

      <AsyncBlock
        state={state}
        skeleton={
          <>
            <SkeletonStatRow count={3} />
            <SkeletonList rows={6} />
          </>
        }
      >
        {(data) => {
          const links = data.links;
          const s = data.summary;
          return (
            <View style={state.fetching && !state.refreshing ? styles.stale : null}>
              {s ? (
                <StatGrid columns={3} style={styles.stats}>
                  <StatTile
                    compact
                    label="Views"
                    value={dash(s.totalViews ?? s.views)}
                    valueColor={colors.purpleText}
                  />
                  <StatTile compact label="Likes" value={dash(s.totalLikes ?? s.likes)} />
                  <StatTile compact label="Comments" value={dash(s.totalComments ?? s.comments)} />
                </StatGrid>
              ) : null}

              {links.length === 0 ? (
                <>
                  <Empty
                    icon="trending-up-outline"
                    title="No enriched links"
                    text={`No enriched ${PLATFORM_LABELS[platform]} links in this window.`}
                  />
                  <Text maxFontSizeMultiplier={1.6} style={styles.note}>
                    {NOTE}
                  </Text>
                </>
              ) : (
                <ListGroup title={`Top ${links.length} links`} footer={NOTE}>
                  {links.map((l, i) => {
                    const url = l.url ?? "";
                    const who = l.employeeName ?? l.employee?.name ?? "";
                    const engage = `${dash(l.likes)} likes · ${dash(l.comments)} comments`;
                    return (
                      <ListItem
                        key={l.linkId ?? (url || String(i))}
                        title={url || "No URL"}
                        subtitle={who ? `${who}\n${engage}` : engage}
                        leading={
                          <View style={styles.rank}>
                            <Text maxFontSizeMultiplier={1.3} style={styles.rankText}>
                              {i + 1}
                            </Text>
                          </View>
                        }
                        trailing={
                          l.views != null ? (
                            <Text maxFontSizeMultiplier={1.3} style={styles.views}>
                              {fmtCompact(l.views)} views
                            </Text>
                          ) : undefined
                        }
                        onPress={url ? () => openLink(url) : undefined}
                        accessibilityLabel={`Rank ${i + 1}, ${url || "No URL"}${who ? `, by ${who}` : ""}${
                          l.views != null ? `, ${fmtCompact(l.views)} views` : ""
                        }, ${engage}`}
                        accessibilityHint="Opens the post"
                      />
                    );
                  })}
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
  stats: { marginBottom: spacing.sm },
  stale: { opacity: 0.6 },
  rank: { width: 28, alignItems: "center", justifyContent: "center" },
  rankText: { ...type.footnote, ...type.numeric, fontWeight: "700", color: colors.sub },
  views: { ...type.footnote, ...type.numeric, fontWeight: "700", color: colors.ink, marginLeft: spacing.sm },
  note: { ...type.footnote, color: colors.sub, marginTop: spacing.sm, textAlign: "center" },
});
