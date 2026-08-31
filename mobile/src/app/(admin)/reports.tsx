import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch, daysAgoIST, todayIST, fmtCompact } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Stat, Chips, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

const WINDOWS = ["24h", "7d", "30d", "90d"] as const;
type Win = (typeof WINDOWS)[number];
const WIN_DAYS: Record<Win, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };

export default function AdminReports() {
  const router = useRouter();
  const [win, setWin] = useState<Win>("7d");

  const startDate = daysAgoIST(WIN_DAYS[win] - 1);
  const endDate = todayIST();

  const { data, loading, refreshing, error, refresh } = useApi<any>(
    () => apiFetch(`/admin/reports/summary?startDate=${startDate}&endDate=${endDate}`),
    [win],
  );

  const employees = (data?.employees ?? [])
    .slice()
    .sort((a: any, b: any) => (b.totalLinks ?? 0) - (a.totalLinks ?? 0));

  // Team platform mix — aggregated from each employee's platformBreakdown
  const platformMix: Array<[string, number]> = (() => {
    const map: Record<string, number> = {};
    for (const e of data?.employees ?? []) {
      for (const pb of e.platformBreakdown ?? []) {
        const k = String(pb.platform ?? "?").toLowerCase();
        map[k] = (map[k] || 0) + (pb.count ?? pb.linkCount ?? 0);
      }
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 6);
  })();

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Chips options={WINDOWS} value={win} onChange={setWin} labels={{ "24h": "24h", "7d": "7 days", "30d": "30 days", "90d": "90 days" }} />
      <ErrorBanner message={error} />

      {loading ? (
        <Loading />
      ) : (
        <>
          <View style={styles.statRow}>
            <Stat label="Reporting" value={data?.employeesReporting ?? 0} />
            <Stat label="Reports" value={data?.totalReports ?? 0} accent={colors.purple} />
            <Stat label="Links" value={fmtCompact(data?.totalLinks ?? 0)} accent={colors.green} />
          </View>

          {platformMix.length > 0 && (
            <>
              <SectionTitle>Platform Mix</SectionTitle>
              <Card>
                {platformMix.map(([platform, count]) => {
                  const max = platformMix[0][1] || 1;
                  return (
                    <View key={platform} style={styles.mixRow}>
                      <Text style={styles.mixLabel} numberOfLines={1}>{platform}</Text>
                      <View style={styles.mixTrack}>
                        <View style={[styles.mixFill, { width: `${Math.max(4, Math.round((count / max) * 100))}%` }]} />
                      </View>
                      <Text style={styles.mixValue}>{fmtCompact(count)}</Text>
                    </View>
                  );
                })}
              </Card>
            </>
          )}

          <SectionTitle>Employee Summary ({employees.length})</SectionTitle>
          <Card>
            {employees.length === 0 ? (
              <Empty icon="bar-chart-outline" text="No reports in this window" />
            ) : (
              employees.map((e: any, i: number) => (
                <Pressable
                  key={e.employeeId ?? e.id ?? i}
                  onPress={() => router.push(`/admin-employee/${e.employeeId ?? e.id}?name=${encodeURIComponent(e.employeeName ?? e.name ?? "")}`)}
                >
                  <View style={[styles.row, i === employees.length - 1 && { borderBottomWidth: 0 }]}>
                    <Text style={styles.rank}>{i + 1}</Text>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.empName} numberOfLines={1}>
                        {e.employeeName ?? e.name}
                      </Text>
                      <Text style={styles.empMeta}>
                        {e.reportCount ?? 0} report(s)
                        {e.linksToday != null ? ` · ${e.linksToday} today` : ""}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={styles.links}>{e.totalLinks ?? 0}</Text>
                      <Text style={styles.linksLabel}>links</Text>
                    </View>
                  </View>
                </Pressable>
              ))
            )}
          </Card>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  statRow: { flexDirection: "row", gap: 8, marginBottom: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rank: { width: 24, fontSize: 12, fontWeight: "700", color: colors.faint, textAlign: "center" },
  mixRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  mixLabel: { width: 84, fontSize: 13, color: colors.ink, textTransform: "capitalize" },
  mixTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.cardHigh, overflow: "hidden" },
  mixFill: { height: 6, borderRadius: 3, backgroundColor: colors.purple },
  mixValue: { width: 48, fontSize: 12, color: colors.sub, textAlign: "right", fontVariant: ["tabular-nums"] },
  empName: { fontSize: 14, fontWeight: "700", color: colors.ink },
  empMeta: { fontSize: 12, color: colors.sub, marginTop: 1 },
  links: { fontSize: 16, fontWeight: "700", color: colors.purple },
  linksLabel: { fontSize: 10, color: colors.sub },
});
