import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Stat, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

export default function AdminEmployeeDetail() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();

  const { data, loading, refreshing, error, refresh } = useApi<{ stats: any; reports: any[] }>(async () => {
    const [stats, reports] = await Promise.allSettled([
      apiFetch<any>(`/admin/reports/employee-stats/${id}`),
      apiFetch<any[]>(`/admin/reports?employeeId=${id}&pageSize=20`),
    ]);
    return {
      stats: stats.status === "fulfilled" ? stats.value : null,
      reports: reports.status === "fulfilled" ? (reports.value ?? []) : [],
    };
  }, [id]);

  if (loading) return <Loading />;

  const s = data?.stats;
  const reports = data?.reports ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Stack.Screen options={{ title: name ? String(name) : "Employee Reports" }} />
      <ErrorBanner message={error} />

      <View style={styles.statRow}>
        <Stat label="Reports" value={s?.totalReports ?? "—"} />
        <Stat label="Links" value={s?.totalLinks ?? "—"} accent={colors.purple} />
        <Stat label="Streak" value={s?.currentStreak != null ? `${s.currentStreak}🔥` : "—"} />
      </View>
      <View style={styles.statRow}>
        <Stat label="Avg Links/Day" value={s?.avgLinksPerDay ?? "—"} />
        <Stat label="Submission Rate" value={s?.submissionRate != null ? `${s.submissionRate}%` : "—"} accent={colors.green} />
      </View>

      <SectionTitle>Recent Reports</SectionTitle>
      <Card>
        {reports.length === 0 ? (
          <Empty icon="document-text-outline" text="No reports yet" />
        ) : (
          reports.map((r: any, i: number) => (
            <View key={r.id} style={[styles.row, i === reports.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.date}>{fmtDate(r.date)}</Text>
                {r.notes ? (
                  <Text style={styles.notes} numberOfLines={1}>
                    {r.notes}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.links}>{(r.links ?? []).filter((l: any) => l.url).length} links</Text>
            </View>
          ))
        )}
      </Card>
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
  date: { fontSize: 14, fontWeight: "600", color: colors.ink },
  notes: { fontSize: 12, color: colors.sub, marginTop: 2 },
  links: { fontSize: 13, fontWeight: "700", color: colors.purple },
});
