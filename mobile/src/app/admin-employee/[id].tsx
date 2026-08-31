import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useLocalSearchParams, Stack } from "expo-router";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Stat, TrendBars, StatusPill, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";
import { fmtCompact } from "@/lib/api";

export default function AdminEmployeeDetail() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();

  const { data, loading, refreshing, error, refresh } = useApi<{ stats: any; reports: any[]; profile: any; accounts: any[] }>(async () => {
    const [stats, reports, profile, accounts] = await Promise.allSettled([
      apiFetch<any>(`/admin/reports/employee-stats/${id}`),
      apiFetch<any[]>(`/admin/reports?employeeId=${id}&pageSize=20`),
      apiFetch<any>(`/employees/${id}`),
      apiFetch<any[]>(`/employees/${id}/accounts`),
    ]);
    return {
      stats: stats.status === "fulfilled" ? stats.value : null,
      reports: reports.status === "fulfilled" ? (reports.value ?? []) : [],
      profile: profile.status === "fulfilled" ? profile.value : null,
      accounts: accounts.status === "fulfilled" ? (accounts.value ?? []) : [],
    };
  }, [id]);

  if (loading) return <Loading />;

  const s = data?.stats;
  const reports = data?.reports ?? [];
  const prof = data?.profile;
  const accounts = data?.accounts ?? [];
  const roles = (prof?.roles ?? []).map((r: any) => r?.role?.name ?? r?.name ?? "").filter(Boolean).join(" · ");
  const trend: number[] = (s?.dailyTrend ?? []).map((t: any) => t.linkCount ?? t.count ?? 0);
  const platforms: Array<{ platform: string; count: number }> = s?.platformBreakdown ?? [];
  const maxPlat = Math.max(...platforms.map((x) => x.count), 1);

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Stack.Screen options={{ title: name ? String(name) : "Employee Reports" }} />
      <ErrorBanner message={error} />

      <View style={styles.statRow}>
        <Stat label="Reports" value={s?.totalReports ?? "—"} />
        <Stat label="Links" value={s?.totalLinks ?? "—"} accent={colors.purple} />
        <Stat label="Streak" value={s?.currentStreak ?? "—"} />
      </View>
      <View style={styles.statRow}>
        <Stat label="Avg Links/Day" value={s?.avgLinksPerDay ?? "—"} />
        <Stat label="Submission Rate" value={s?.submissionRate != null ? `${s.submissionRate}%` : "—"} accent={colors.green} />
      </View>

      {prof ? (
        <>
          <SectionTitle>Profile</SectionTitle>
          <Card>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.profName}>{prof.name}</Text>
                <Text style={styles.profSub} numberOfLines={1}>{prof.email ?? prof.phone ?? ""}</Text>
                {roles ? <Text style={styles.profRoles} numberOfLines={1}>{roles}</Text> : null}
              </View>
              <StatusPill status={prof.status ?? ""} />
            </View>
            <Text style={styles.profMeta}>{accounts.length} assigned account(s)</Text>
          </Card>
        </>
      ) : null}

      {trend.length > 1 && (
        <>
          <SectionTitle>Daily Links</SectionTitle>
          <Card>
            <TrendBars data={trend} />
            <Text style={styles.trendCaption}>Last {trend.length} days</Text>
          </Card>
        </>
      )}

      {platforms.length > 0 && (
        <>
          <SectionTitle>Platforms</SectionTitle>
          <Card>
            {platforms.slice(0, 6).map((pb) => (
              <View key={pb.platform} style={styles.mixRow}>
                <Text style={styles.mixLabel} numberOfLines={1}>{pb.platform}</Text>
                <View style={styles.mixTrack}>
                  <View style={[styles.mixFill, { width: `${Math.max(4, Math.round((pb.count / maxPlat) * 100))}%` }]} />
                </View>
                <Text style={styles.mixValue}>{fmtCompact(pb.count)}</Text>
              </View>
            ))}
            {s?.bestChannel ? (
              <Text style={styles.channelNote}>
                Best: {s.bestChannel.platform}{s?.worstChannel ? ` · Needs attention: ${s.worstChannel.platform}` : ""}
              </Text>
            ) : null}
          </Card>
        </>
      )}

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
  profName: { fontSize: 17, fontWeight: "600", color: colors.ink },
  profSub: { fontSize: 13, color: colors.sub, marginTop: 1 },
  profRoles: { fontSize: 12, color: colors.purple, marginTop: 2 },
  profMeta: { fontSize: 13, color: colors.sub, marginTop: 8 },
  trendCaption: { fontSize: 11, color: colors.faint, marginTop: 8, textAlign: "center" },
  mixRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  mixLabel: { width: 84, fontSize: 13, color: colors.ink, textTransform: "capitalize" },
  mixTrack: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.cardHigh, overflow: "hidden" },
  mixFill: { height: 6, borderRadius: 3, backgroundColor: colors.purple },
  mixValue: { width: 48, fontSize: 12, color: colors.sub, textAlign: "right", fontVariant: ["tabular-nums"] },
  channelNote: { fontSize: 12, color: colors.sub, marginTop: 8 },
});
