import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable, Linking } from "react-native";
import { apiFetch, fmtCompact, daysAgoIST, todayIST } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Stat, Chips, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

const PLATFORMS = ["youtube", "instagram", "facebook", "snapchat"] as const;
const WINDOWS = ["7D", "30D", "ALL"] as const;
type Win = (typeof WINDOWS)[number];

export default function AdminTopLinks() {
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]>("instagram");
  const [win, setWin] = useState<Win>("30D");

  const range = win === "ALL" ? "" : `&startDate=${daysAgoIST(win === "7D" ? 6 : 29)}&endDate=${todayIST()}`;

  const { data, loading, refreshing, error, refresh } = useApi<any>(async () => {
    const [links, summary] = await Promise.allSettled([
      apiFetch<any[]>(`/admin/reports/top-links?platform=${platform}&limit=20${range}`),
      apiFetch<any>(`/admin/reports/insights-summary?${range.slice(1)}`),
    ]);
    return {
      links: links.status === "fulfilled" ? links.value ?? [] : [],
      summary: summary.status === "fulfilled" ? summary.value : null,
    };
  }, [platform, win]);

  const links: any[] = data?.links ?? [];
  const s = data?.summary;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Chips options={WINDOWS} value={win} onChange={setWin} labels={{ "7D": "7 days", "30D": "30 days", ALL: "All time" }} />
      <Chips options={PLATFORMS} value={platform} onChange={setPlatform}
        labels={{ youtube: "YouTube", instagram: "Instagram", facebook: "Facebook", snapchat: "Snapchat" }} />
      <ErrorBanner message={error} />

      {loading ? (
        <Loading />
      ) : (
        <>
          {s ? (
            <View style={styles.statRow}>
              <Stat label="Views" value={fmtCompact(s.totalViews ?? s.views)} accent={colors.purple} />
              <Stat label="Likes" value={fmtCompact(s.totalLikes ?? s.likes)} />
              <Stat label="Comments" value={fmtCompact(s.totalComments ?? s.comments)} />
            </View>
          ) : null}

          <SectionTitle>Top {links.length} Links</SectionTitle>
          <Card>
            {links.length === 0 ? (
              <Empty icon="trending-up-outline" text="No enriched links in this window" />
            ) : (
              links.map((l: any, i: number) => (
                <Pressable key={l.linkId ?? l.url ?? i} onPress={() => l.url && Linking.openURL(l.url)}>
                  <View style={[styles.row, i === links.length - 1 && { borderBottomWidth: 0 }]}>
                    <Text style={styles.rank}>{i + 1}</Text>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.url} numberOfLines={1}>{l.url}</Text>
                      <Text style={styles.meta} numberOfLines={1}>
                        {l.employeeName ?? l.employee?.name ?? ""}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      {l.views != null ? <Text style={styles.views}>{fmtCompact(l.views)} views</Text> : null}
                      <Text style={styles.engage}>
                        {l.likes != null ? `${fmtCompact(l.likes)} ♥` : "—"} · {l.comments != null ? `${fmtCompact(l.comments)} 💬` : "—"}
                      </Text>
                    </View>
                  </View>
                </Pressable>
              ))
            )}
          </Card>
          <Text style={styles.note}>
            A dash means the platform doesn't publish that metric. Metrics refresh on a 2-hour cycle.
          </Text>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statRow: { flexDirection: "row", gap: 8, marginBottom: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rank: { width: 24, fontSize: 12, fontWeight: "800", color: colors.faint, textAlign: "center" },
  url: { fontSize: 12, color: colors.purple },
  meta: { fontSize: 11, color: colors.sub, marginTop: 2 },
  views: { fontSize: 13, fontWeight: "800", color: colors.ink },
  engage: { fontSize: 11, color: colors.sub, marginTop: 1 },
  note: { fontSize: 11, color: colors.faint, marginTop: 4, textAlign: "center" },
});
