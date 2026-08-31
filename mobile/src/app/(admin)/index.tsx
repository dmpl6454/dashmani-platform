import React from "react";
import { View, Text, StyleSheet, Pressable, ImageBackground } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/lib/auth";
import { apiFetch, fmtCompact } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Stat, TrendBars, useApi } from "@/components/ui";

const HERO = require("../../../assets/visuals/hero-admin.jpg");

export default function AdminDashboard() {
  const { user } = useAuth();
  const router = useRouter();
  const { data, refreshing, refresh } = useApi<any>(async () => {
    const [overview, poa] = await Promise.allSettled([
      apiFetch<any>("/analytics/overview"),
      apiFetch<any>("/admin/daily-reports/status"),
    ]);
    return {
      ...(overview.status === "fulfilled" ? overview.value : {}),
      poaStatus: poa.status === "fulfilled" ? poa.value : null,
    };
  });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const quick = [
    { icon: "people", label: "Employees", to: "/admin-employees", tint: colors.purpleSoft, fg: colors.purple },
    { icon: "checkbox", label: "Tasks", to: "/admin-tasks", tint: colors.yellowSoft, fg: colors.amber },
    { icon: "trending-up", label: "Account Growth", to: "/admin-growth", tint: colors.blueSoft, fg: colors.blue },
    { icon: "trophy", label: "Leaderboard", to: "/admin-leaderboard", tint: colors.greenSoft, fg: colors.green },
  ] as const;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ImageBackground source={HERO} style={styles.hero} imageStyle={styles.heroImg}>
        <LinearGradient
          colors={["rgba(10,9,19,0.10)", "rgba(10,9,19,0.55)", "rgba(10,9,19,0.92)"]}
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

      {/* Pending approvals callout */}
      {(data?.pendingApprovals ?? 0) > 0 && (
        <Pressable onPress={() => router.push("/(admin)/approvals")}>
          <Card style={{ backgroundColor: colors.amberSoft, borderColor: "transparent" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <Ionicons name="alert-circle" size={26} color={colors.amber} />
              <View style={{ flex: 1 }}>
                <Text style={styles.calloutTitle}>{data!.pendingApprovals} pending approval(s)</Text>
                <Text style={styles.calloutSub}>
                  {data!.pendingLeaveRequests ?? 0} leaves · {data!.pendingEmployees ?? 0} new employees ·{" "}
                  {data!.pendingDocuments ?? 0} documents
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.sub} />
            </View>
          </Card>
        </Pressable>
      )}

      <SectionTitle>Team Today</SectionTitle>
      <View style={styles.statRow}>
        <Stat label="Employees" value={data?.totalEmployees ?? "—"} />
        <Stat label="Present" value={data?.presentToday ?? "—"} accent={colors.green} />
        <Stat label="Submitted" value={data?.submittedTodayCount ?? "—"} accent={colors.purple} />
        <Stat label="Rate" value={data?.submissionRateToday != null ? `${data.submissionRateToday}%` : "—"} />
      </View>

      <SectionTitle>Links Activity</SectionTitle>
      <View style={styles.statRow}>
        <Stat label="Today" value={fmtCompact(data?.linksToday)} accent={colors.purple} />
        <Stat label="This Week" value={fmtCompact(data?.linksThisWeek)} />
        <Stat label="This Month" value={fmtCompact(data?.linksThisMonth)} />
      </View>
      {Array.isArray(data?.linksTrend) && data.linksTrend.length > 1 && (
        <Card>
          <TrendBars data={data.linksTrend.map((t: any) => t.count ?? 0)} />
          <View style={styles.trendFoot}>
            <Text style={styles.trendLabel}>{String(data.linksTrend[0]?.date).slice(5)}</Text>
            <Text style={styles.trendLabel}>Links · last {data.linksTrend.length} days</Text>
            <Text style={styles.trendLabel}>{String(data.linksTrend[data.linksTrend.length - 1]?.date).slice(5)}</Text>
          </View>
        </Card>
      )}

      {data?.poaStatus ? (
        <>
          <SectionTitle>Today's Plans (POA)</SectionTitle>
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
                {(data.poaStatus.nonSubmitters ?? []).length > 6 ? ` +${data.poaStatus.nonSubmitters.length - 6} more` : ""}
              </Text>
            )}
          </Card>
        </>
      ) : null}

      <SectionTitle>Content</SectionTitle>
      <View style={styles.statRow}>
        <Stat label="Published (mo)" value={data?.contentPublishedThisMonth ?? "—"} accent={colors.green} />
        <Stat label="Scheduled" value={data?.contentScheduledUpcoming ?? "—"} />
        <Stat label="Pending Docs" value={data?.pendingDocuments ?? "—"} />
      </View>

      <SectionTitle>Workspace</SectionTitle>
      <View style={styles.statRow}>
        <Stat label="Teams" value={data?.activeTeams ?? "—"} />
        <Stat label="Projects" value={data?.activeProjects ?? "—"} />
        <Stat label="Tasks Done (mo)" value={data?.tasksCompletedThisMonth ?? "—"} accent={colors.green} />
      </View>

      <SectionTitle>Quick Access</SectionTitle>
      <View style={styles.quickGrid}>
        {quick.map((q) => (
          <Pressable key={q.label} style={styles.quickTile} onPress={() => router.push(q.to as any)}>
            <View style={[styles.quickIcon, { backgroundColor: q.tint }]}>
              <Ionicons name={q.icon as any} size={20} color={q.fg} />
            </View>
            <Text style={styles.quickLabel}>{q.label}</Text>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    borderRadius: radius.xl,
    overflow: "hidden",
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  heroImg: { borderRadius: radius.xl },
  header: { flexDirection: "row", alignItems: "flex-end", padding: spacing.lg, paddingTop: 64 },
  heroTag: { fontSize: 11, fontWeight: "500", color: colors.sub, letterSpacing: 1.2, marginTop: 4 },
  greeting: { fontSize: 13, color: colors.sub },
  name: { fontSize: 18, fontWeight: "700", color: colors.ink },
  bell: {
    width: 42,
    height: 42,
    borderRadius: radius.full,
    backgroundColor: colors.cardHigh,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  calloutTitle: { fontSize: 15, fontWeight: "700", color: colors.ink },
  calloutSub: { fontSize: 12, color: colors.sub, marginTop: 2 },
  statRow: { flexDirection: "row", gap: 8, marginBottom: spacing.md },
  trendFoot: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  trendLabel: { fontSize: 11, color: colors.faint },
  poaCount: { fontSize: 28, fontWeight: "600", color: colors.ink, fontVariant: ["tabular-nums"] },
  poaOf: { fontSize: 14, color: colors.sub },
  poaMissing: { fontSize: 13, color: colors.sub, marginTop: 8 },
  quickGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  quickTile: {
    width: "47%",
    flexGrow: 1,
    backgroundColor: colors.cardHigh,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    alignItems: "center",
    gap: 8,
  },
  quickIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  quickLabel: { fontSize: 13, fontWeight: "700", color: colors.ink },
});
