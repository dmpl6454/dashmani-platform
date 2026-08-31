import React from "react";
import { View, Text, StyleSheet, Pressable, ImageBackground } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/lib/auth";
import { apiFetch, fmtCompact, daysAgoIST, todayIST } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Stat, SeeAll, TrendBars, useApi } from "@/components/ui";

const HERO = require("../../../assets/visuals/hero-admin.jpg");

/** Meta earnings arrive in USD cents. */
function fmtUsd(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return "$" + (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

const num = (v: any): number =>
  typeof v === "number" ? v : v && typeof v === "object" ? num(v.count ?? v._count ?? 0) : 0;

export default function AdminDashboard() {
  const { user } = useAuth();
  const router = useRouter();

  // The command center pulls every company vital in one parallel sweep.
  const { data, refreshing, refresh } = useApi<any>(async () => {
    const week = `startDate=${daysAgoIST(6)}&endDate=${todayIST()}`;
    const [overview, poa, growth, tasks, summary, apps, complaints, bugs] = await Promise.allSettled([
      apiFetch<any>("/analytics/overview"),
      apiFetch<any>("/admin/daily-reports/status"),
      apiFetch<any>("/admin/meta/channels?window=days_28"),
      apiFetch<any>("/analytics/tasks"),
      apiFetch<any>(`/admin/reports/summary?${week}`),
      apiFetch<any[]>("/admin/applications"),
      apiFetch<any[]>("/admin/complaints"),
      apiFetch<any[]>("/admin/bug-reports"),
    ]);
    const g = growth.status === "fulfilled" ? growth.value : null;
    const t = tasks.status === "fulfilled" ? tasks.value : null;
    const sum = summary.status === "fulfilled" ? summary.value : null;
    const openApps =
      apps.status === "fulfilled"
        ? (apps.value ?? []).filter((a: any) => ["RECEIVED", "REVIEWING", "SHORTLISTED", "INTERVIEW"].includes(a.status)).length
        : null;
    const openComplaints =
      complaints.status === "fulfilled" ? (complaints.value ?? []).filter((c: any) => c.status === "OPEN").length : null;
    const openBugs =
      bugs.status === "fulfilled"
        ? (bugs.value ?? []).filter((b: any) => ["OPEN", "IN_PROGRESS"].includes(b.status)).length
        : null;
    const doneTasks = num((t?.byStatus ?? []).find?.((x: any) => x.status === "DONE"));
    return {
      ...(overview.status === "fulfilled" ? overview.value : {}),
      poaStatus: poa.status === "fulfilled" ? poa.value : null,
      growth: g ? { ...g.totals, channelCount: g.channelCount } : null,
      tasks: t
        ? {
            total: t.totalTasks ?? 0,
            open: Math.max(0, (t.totalTasks ?? 0) - doneTasks),
            overdue: t.overdueCount ?? 0,
            rate: t.completionRate ?? 0,
          }
        : null,
      topPerformers: (sum?.employees ?? [])
        .slice()
        .sort((a: any, b: any) => (b.totalLinks ?? 0) - (a.totalLinks ?? 0))
        .slice(0, 3),
      openApps,
      openComplaints,
      openBugs,
    };
  });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const g = data?.growth;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      {/* Hero */}
      <ImageBackground source={HERO} style={styles.hero} imageStyle={styles.heroImg}>
        <LinearGradient
          colors={["rgba(0,0,0,0.10)", "rgba(0,0,0,0.55)", "rgba(0,0,0,0.92)"]}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.greeting}>{greeting},</Text>
            <Text style={styles.name} numberOfLines={1}>
              {user?.name}
            </Text>
            <Text style={styles.heroTag}>ADMIN</Text>
          </View>
          <Pressable onPress={() => router.push("/admin-notifications")} style={styles.bell}>
            <Ionicons name="notifications-outline" size={22} color={colors.ink} />
          </Pressable>
        </View>
      </ImageBackground>

      {/* Pending approvals — straight to the queues */}
      {(data?.pendingApprovals ?? 0) > 0 && (
        <Pressable onPress={() => router.push("/(admin)/approvals")}>
          <Card style={{ backgroundColor: colors.amberSoft }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Ionicons name="alert-circle" size={24} color={colors.amber} />
              <View style={{ flex: 1 }}>
                <Text style={styles.calloutTitle}>{data!.pendingApprovals} pending approval(s)</Text>
                <Text style={styles.calloutSub}>
                  {data!.pendingLeaveRequests ?? 0} leaves · {data!.pendingEmployees ?? 0} new joiners ·{" "}
                  {data!.pendingDocuments ?? 0} documents
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.sub} />
            </View>
          </Card>
        </Pressable>
      )}

      {/* Account Growth — the business headline */}
      <SectionTitle right={<SeeAll onPress={() => router.push("/admin-growth")} />}>Account Growth · 28d</SectionTitle>
      <Pressable onPress={() => router.push("/admin-growth")}>
        <Card>
          <View style={styles.growthRow}>
            <View style={styles.growthCell}>
              <Text style={styles.growthValue} numberOfLines={1} adjustsFontSizeToFit>{fmtCompact(g?.views)}</Text>
              <Text style={styles.growthLabel}>Views</Text>
            </View>
            <View style={styles.growthCell}>
              <Text style={styles.growthValue} numberOfLines={1} adjustsFontSizeToFit>{fmtCompact(g?.engagements)}</Text>
              <Text style={styles.growthLabel}>Engagements</Text>
            </View>
            <View style={styles.growthCell}>
              <Text style={styles.growthValue} numberOfLines={1} adjustsFontSizeToFit>{fmtCompact(g?.followers)}</Text>
              <Text style={styles.growthLabel}>Followers</Text>
            </View>
            <View style={styles.growthCell}>
              <Text style={[styles.growthValue, { color: colors.green }]} numberOfLines={1} adjustsFontSizeToFit>{fmtUsd(g?.earningsCents)}</Text>
              <Text style={styles.growthLabel}>Revenue</Text>
            </View>
          </View>
          <Text style={styles.growthFoot}>{g?.channelCount ?? "—"} connected Meta channels</Text>
        </Card>
      </Pressable>

      {/* Team today */}
      <SectionTitle right={<SeeAll onPress={() => router.push("/admin-employees")} />}>Team Today</SectionTitle>
      <View style={styles.statRow}>
        <Stat label="Employees" value={data?.totalEmployees ?? "—"} onPress={() => router.push("/admin-employees")} />
        <Stat
          label="Present"
          value={data?.presentToday ?? "—"}
          accent={colors.green}
          onPress={() => router.push("/admin-attendance")}
        />
        <Stat
          label="Submitted"
          value={data?.submittedTodayCount ?? "—"}
          accent={colors.purple}
          onPress={() => router.push("/(admin)/reports")}
        />
        <Stat
          label="Rate"
          value={data?.submissionRateToday != null ? `${data.submissionRateToday}%` : "—"}
          onPress={() => router.push("/(admin)/reports")}
        />
      </View>

      {/* Links activity + trend */}
      <SectionTitle right={<SeeAll onPress={() => router.push("/(admin)/reports")} />}>Links Activity</SectionTitle>
      <View style={styles.statRow}>
        <Stat
          label="Today"
          value={fmtCompact(data?.linksToday)}
          accent={colors.purple}
          onPress={() => router.push("/(admin)/reports")}
        />
        <Stat label="This Week" value={fmtCompact(data?.linksThisWeek)} onPress={() => router.push("/(admin)/reports")} />
        <Stat label="This Month" value={fmtCompact(data?.linksThisMonth)} onPress={() => router.push("/(admin)/reports")} />
      </View>
      {Array.isArray(data?.linksTrend) && data.linksTrend.length > 1 && (
        <Pressable onPress={() => router.push("/(admin)/reports")}>
          <Card>
            <TrendBars data={data.linksTrend.map((t: any) => t.count ?? 0)} />
            <View style={styles.trendFoot}>
              <Text style={styles.trendLabel}>{String(data.linksTrend[0]?.date).slice(5)}</Text>
              <Text style={styles.trendLabel}>Links · last {data.linksTrend.length} days</Text>
              <Text style={styles.trendLabel}>{String(data.linksTrend[data.linksTrend.length - 1]?.date).slice(5)}</Text>
            </View>
          </Card>
        </Pressable>
      )}

      {/* Top performers this week */}
      {(data?.topPerformers ?? []).length > 0 && (
        <>
          <SectionTitle right={<SeeAll onPress={() => router.push("/admin-leaderboard")} />}>
            Top Performers · 7d
          </SectionTitle>
          <Card>
            {data.topPerformers.map((e: any, i: number) => (
              <Pressable
                key={e.employeeId ?? i}
                onPress={() =>
                  router.push(`/admin-employee/${e.employeeId ?? e.id}?name=${encodeURIComponent(e.employeeName ?? e.name ?? "")}`)
                }
              >
                <View style={[styles.perfRow, i === data.topPerformers.length - 1 && { borderBottomWidth: 0 }]}>
                  <Text style={styles.perfRank}>{i + 1}</Text>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.perfName} numberOfLines={1}>
                      {e.employeeName ?? e.name}
                    </Text>
                    <Text style={styles.perfMeta}>{e.reportCount ?? 0} report(s)</Text>
                  </View>
                  <Text style={styles.perfLinks}>{fmtCompact(e.totalLinks ?? 0)} links</Text>
                  <Ionicons name="chevron-forward" size={14} color={colors.faint} />
                </View>
              </Pressable>
            ))}
          </Card>
        </>
      )}

      {/* Tasks */}
      <SectionTitle right={<SeeAll onPress={() => router.push("/admin-tasks")} />}>Tasks</SectionTitle>
      <View style={styles.statRow}>
        <Stat label="Open" value={data?.tasks?.open ?? "—"} onPress={() => router.push("/admin-tasks")} />
        <Stat
          label="Overdue"
          value={data?.tasks?.overdue ?? "—"}
          accent={(data?.tasks?.overdue ?? 0) > 0 ? colors.red : undefined}
          onPress={() => router.push("/admin-tasks")}
        />
        <Stat
          label="Done Rate"
          value={data?.tasks?.rate != null ? `${data.tasks.rate}%` : "—"}
          accent={colors.green}
          onPress={() => router.push("/admin-analytics")}
        />
      </View>

      {/* Today's POA */}
      {data?.poaStatus ? (
        <>
          <SectionTitle right={<SeeAll onPress={() => router.push("/admin-employees")} />}>
            Today's Plans (POA)
          </SectionTitle>
          <Card>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
              <Text style={styles.poaCount}>{data.poaStatus.submittedCount ?? 0}</Text>
              <Text style={styles.poaOf}>
                of {(data.poaStatus.submittedCount ?? 0) + (data.poaStatus.nonSubmitters?.length ?? 0)} submitted
              </Text>
            </View>
            {(data.poaStatus.nonSubmitters ?? []).length > 0 && (
              <Text style={styles.poaMissing} numberOfLines={2}>
                Missing: {(data.poaStatus.nonSubmitters ?? []).slice(0, 6).map((e: any) => e.name).join(", ")}
                {(data.poaStatus.nonSubmitters ?? []).length > 6
                  ? ` +${data.poaStatus.nonSubmitters.length - 6} more`
                  : ""}
              </Text>
            )}
          </Card>
        </>
      ) : null}

      {/* Workspace */}
      <SectionTitle right={<SeeAll onPress={() => router.push("/(admin)/manage")} label="Manage" />}>Workspace</SectionTitle>
      <View style={styles.statRow}>
        <Stat label="Teams" value={data?.activeTeams ?? "—"} onPress={() => router.push("/admin-teams")} />
        <Stat label="Projects" value={data?.activeProjects ?? "—"} onPress={() => router.push("/admin-projects")} />
        <Stat
          label="Published (mo)"
          value={data?.contentPublishedThisMonth ?? "—"}
          onPress={() => router.push("/admin-content")}
        />
      </View>

      {/* Needs attention */}
      <SectionTitle>Needs Attention</SectionTitle>
      <View style={styles.statRow}>
        <Stat
          label="Applications"
          value={data?.openApps ?? "—"}
          accent={(data?.openApps ?? 0) > 0 ? colors.blue : undefined}
          onPress={() => router.push("/admin-jobs")}
        />
        <Stat
          label="Complaints"
          value={data?.openComplaints ?? "—"}
          accent={(data?.openComplaints ?? 0) > 0 ? colors.amber : undefined}
          onPress={() => router.push("/admin-complaints")}
        />
        <Stat
          label="Bugs"
          value={data?.openBugs ?? "—"}
          accent={(data?.openBugs ?? 0) > 0 ? colors.red : undefined}
          onPress={() => router.push("/admin-bug-reports")}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    borderRadius: radius.xl,
    overflow: "hidden",
    marginBottom: spacing.lg,
  },
  heroImg: { borderRadius: radius.xl },
  header: { flexDirection: "row", alignItems: "flex-end", padding: spacing.lg, paddingTop: 64 },
  greeting: { fontSize: 13, color: colors.sub },
  name: { fontSize: 20, fontWeight: "700", color: colors.ink },
  heroTag: { fontSize: 11, fontWeight: "500", color: colors.sub, letterSpacing: 1.2, marginTop: 4 },
  bell: {
    width: 42,
    height: 42,
    borderRadius: radius.full,
    backgroundColor: "rgba(28,28,30,0.7)",
    alignItems: "center",
    justifyContent: "center",
  },
  calloutTitle: { fontSize: 15, fontWeight: "600", color: colors.ink },
  calloutSub: { fontSize: 12, color: colors.sub, marginTop: 2 },
  statRow: { flexDirection: "row", gap: 8, marginBottom: spacing.lg },
  growthRow: { flexDirection: "row" },
  growthCell: { flex: 1, alignItems: "center", paddingHorizontal: 3 },
  growthValue: { fontSize: 19, fontWeight: "600", color: colors.ink, fontVariant: ["tabular-nums"] },
  growthLabel: { fontSize: 11, color: colors.sub, marginTop: 2 },
  growthFoot: { fontSize: 12, color: colors.faint, textAlign: "center", marginTop: 10 },
  trendFoot: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  trendLabel: { fontSize: 11, color: colors.faint },
  perfRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  perfRank: {
    width: 20,
    fontSize: 15,
    fontWeight: "600",
    color: colors.faint,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  perfName: { fontSize: 15, fontWeight: "600", color: colors.ink },
  perfMeta: { fontSize: 12, color: colors.sub, marginTop: 1 },
  perfLinks: { fontSize: 14, fontWeight: "600", color: colors.purple, fontVariant: ["tabular-nums"] },
  poaCount: { fontSize: 28, fontWeight: "600", color: colors.ink, fontVariant: ["tabular-nums"] },
  poaOf: { fontSize: 14, color: colors.sub },
  poaMissing: { fontSize: 13, color: colors.sub, marginTop: 8 },
});
