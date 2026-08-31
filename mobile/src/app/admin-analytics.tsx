import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch } from "@/lib/api";
import { colors, spacing, formatStatus, statusColor } from "@/lib/theme";
import { Screen, Card, SectionTitle, Stat, Chips, Loading, ErrorBanner, Empty, useApi } from "@/components/ui";

const TABS = ["TASKS", "ATTENDANCE", "CONTENT", "PROJECTS"] as const;
type Tab = (typeof TABS)[number];

export default function AdminAnalytics() {
  const [tab, setTab] = useState<Tab>("TASKS");
  const { data, loading, refreshing, error, refresh } = useApi<any>(
    () => apiFetch(`/analytics/${tab.toLowerCase()}`),
    [tab],
  );

  // API distributions come as ARRAYS of {status|priority|platform, count} (Prisma
  // groupBy mapped server-side) — normalize any shape to [label, number] pairs.
  const num = (v: any): number =>
    typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) || 0 : v && typeof v === "object" ? num(v.count ?? v._count ?? v.total ?? 0) : 0;
  const dist = (x: any): Array<[string, number]> => {
    if (!x) return [];
    const pairs: Array<[string, number]> = Array.isArray(x)
      ? x.map((r: any) => [String(r.status ?? r.priority ?? r.platform ?? r.name ?? "?"), num(r.count ?? r._count ?? r.value ?? 0)])
      : Object.entries(x).map(([k, v]) => [k, num(v)] as [string, number]);
    return pairs.sort((a, b) => b[1] - a[1]);
  };

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <Chips options={TABS} value={tab} onChange={setTab} />
      <ErrorBanner message={error} />
      {loading ? (
        <Loading />
      ) : !data ? (
        <Card><Empty icon="bar-chart-outline" text="No data" /></Card>
      ) : tab === "TASKS" ? (
        <>
          <View style={styles.statRow}>
            <Stat label="Total" value={data.totalTasks ?? 0} />
            <Stat label="Done (mo)" value={data.completedThisMonth ?? 0} accent={colors.green} />
            <Stat label="Overdue" value={data.overdueCount ?? 0} accent={colors.red} />
            <Stat label="Rate" value={`${data.completionRate ?? 0}%`} accent={colors.purple} />
          </View>
          <SectionTitle>By Status</SectionTitle>
          <Card>
            {dist(data.byStatus).map(([k, v]) => (
              <BarRow key={k} label={formatStatus(k)} value={v} max={data.totalTasks || 1} />
            ))}
          </Card>
          <SectionTitle>By Priority</SectionTitle>
          <Card>
            {dist(data.byPriority).map(([k, v]) => (
              <BarRow key={k} label={formatStatus(k)} value={v} max={data.totalTasks || 1} color={statusColor(k).fg} />
            ))}
          </Card>
          <SectionTitle>Top Assignees</SectionTitle>
          <Card>
            {(data.topAssignees ?? []).length === 0 ? (
              <Empty icon="people-outline" text="No assignees" />
            ) : (
              (data.topAssignees ?? []).map((a: any, i: number) => (
                <View key={a.assigneeId ?? i} style={styles.assigneeRow}>
                  <Text style={styles.assigneeName}>{a.name}</Text>
                  <Text style={styles.assigneeCount}>{num(a.done ?? a.count ?? 0)} done</Text>
                </View>
              ))
            )}
          </Card>
        </>
      ) : tab === "ATTENDANCE" ? (
        <>
          {dist(data.byStatus).length > 0 && (
            <View style={styles.statRow}>
              {dist(data.byStatus).slice(0, 4).map(([k, v]) => (
                <Stat key={k} label={formatStatus(k)} value={v} />
              ))}
            </View>
          )}
          <Card>
            {Object.entries(data)
              .filter(([, v]) => typeof v === "number")
              .map(([k, v]) => (
                <View key={k} style={styles.assigneeRow}>
                  <Text style={styles.assigneeName}>{formatStatus(k.replace(/([A-Z])/g, "_$1"))}</Text>
                  <Text style={styles.assigneeCount}>{String(v)}</Text>
                </View>
              ))}
            {dist(data.byStatus).map(([k, v]) => (
              <BarRow key={k} label={formatStatus(k)} value={v} max={Math.max(...dist(data.byStatus).map(([, n]) => n), 1)} />
            ))}
          </Card>
        </>
      ) : tab === "CONTENT" ? (
        <>
          <View style={styles.statRow}>
            <Stat label="Total Posts" value={data.totalPosts ?? 0} />
            <Stat label="Published (mo)" value={data.publishedThisMonth ?? 0} accent={colors.green} />
            <Stat label="Scheduled" value={data.scheduledUpcoming ?? 0} accent={colors.amber} />
          </View>
          <SectionTitle>By Status</SectionTitle>
          <Card>
            {dist(data.byStatus).map(([k, v]) => (
              <BarRow key={k} label={formatStatus(k)} value={v} max={data.totalPosts || 1} />
            ))}
          </Card>
          <SectionTitle>By Platform</SectionTitle>
          <Card>
            {dist(data.byPlatform).map(([k, v]) => (
              <BarRow key={k} label={k} value={v} max={data.totalPosts || 1} color={colors.blue} />
            ))}
          </Card>
        </>
      ) : (
        <>
          <View style={styles.statRow}>
            <Stat label="Projects" value={data.totalProjects ?? 0} />
            <Stat label="Active" value={data.activeProjects ?? 0} accent={colors.green} />
          </View>
          <Card>
            {(data.projects ?? []).length === 0 ? (
              <Empty icon="folder-outline" text="No projects" />
            ) : (
              (data.projects ?? []).map((p: any) => (
                <View key={p.projectId} style={styles.projRow}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.projName} numberOfLines={1}>{p.projectName}</Text>
                    <Text style={styles.projSub}>{p.clientName} · {p.completedTasks}/{p.totalTasks} tasks</Text>
                  </View>
                  <Text style={styles.projPct}>{p.taskCompletionPercent}%</Text>
                </View>
              ))
            )}
          </Card>
        </>
      )}
    </Screen>
  );
}

function BarRow({ label, value, max, color }: { label: string; value: number; max: number; color?: string }) {
  const pct = Math.max(3, Math.round((value / max) * 100));
  return (
    <View style={styles.barRow}>
      <Text style={styles.barLabel} numberOfLines={1}>{label}</Text>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: color ?? colors.purple }]} />
      </View>
      <Text style={styles.barValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  statRow: { flexDirection: "row", gap: 8, marginBottom: spacing.sm },
  barRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 7 },
  barLabel: { width: 92, fontSize: 12, color: colors.ink, fontWeight: "600" },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.07)", overflow: "hidden" },
  barFill: { height: 8, borderRadius: 4 },
  barValue: { width: 36, fontSize: 12, fontWeight: "700", color: colors.sub, textAlign: "right" },
  assigneeRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  assigneeName: { fontSize: 13, fontWeight: "600", color: colors.ink },
  assigneeCount: { fontSize: 13, color: colors.green, fontWeight: "700" },
  projRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  projName: { fontSize: 14, fontWeight: "700", color: colors.ink },
  projSub: { fontSize: 12, color: colors.sub, marginTop: 1 },
  projPct: { fontSize: 14, fontWeight: "700", color: colors.purple },
});
