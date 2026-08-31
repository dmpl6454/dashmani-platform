import React from "react";
import { View, Text, StyleSheet, Pressable, Image, ImageBackground } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/lib/auth";
import { apiFetch, API_BASE, fmtDate, todayIST } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, Stat, SeeAll, Empty, useApi } from "@/components/ui";

const HERO = require("../../../assets/visuals/hero-employee.jpg");

type Attendance =
  | { isEmployee: false }
  | { totalWorkdays: number; present: number; late: number; halfDay: number; absent: number; rate: number };

type Dash = {
  attendance: Attendance | null;
  leaveBalance: any;
  holidays: any[];
  unread: number;
  todayReport: any;
};

async function loadDashboard(): Promise<Dash> {
  const [attendance, leaveBalance, holidays, count, todayReport] = await Promise.allSettled([
    apiFetch<Attendance>("/hr/attendance"),
    apiFetch<any>("/hr/leave-balance"),
    apiFetch<any[]>("/hr/holidays"),
    apiFetch<{ count: number }>("/hr/notifications/count"),
    apiFetch<any>("/hr/reports/today"),
  ]);
  return {
    attendance: attendance.status === "fulfilled" ? attendance.value : null,
    leaveBalance: leaveBalance.status === "fulfilled" ? leaveBalance.value : null,
    holidays: holidays.status === "fulfilled" ? holidays.value ?? [] : [],
    unread: count.status === "fulfilled" ? count.value?.count ?? 0 : 0,
    todayReport: todayReport.status === "fulfilled" ? todayReport.value : null,
  };
}

export default function HomeScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const { data, refreshing, refresh } = useApi(loadDashboard);

  const att = data?.attendance;
  const isEmployee = att && "rate" in att;
  const upcoming = (data?.holidays ?? [])
    .filter((h) => String(h.date).slice(0, 10) >= todayIST())
    .slice(0, 3);
  const linksToday = data?.todayReport?.links?.filter((l: any) => !l.isScheduled && l.url)?.length ?? 0;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const avatarUrl = user?.profileImageUrl
    ? user.profileImageUrl.startsWith("http")
      ? user.profileImageUrl
      : `${API_BASE}${user.profileImageUrl}`
    : null;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      {/* Header — Seedance hero */}
      <ImageBackground source={HERO} style={styles.hero} imageStyle={styles.heroImg}>
        <LinearGradient
          colors={["rgba(10,9,19,0.10)", "rgba(10,9,19,0.55)", "rgba(10,9,19,0.92)"]}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.header}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flex: 1 }}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={styles.avatarLetter}>{(user?.name || "?").charAt(0).toUpperCase()}</Text>
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.greeting}>{greeting},</Text>
            <Text style={styles.name} numberOfLines={1}>
              {user?.name}
            </Text>
          </View>
        </View>
        <Pressable onPress={() => router.push("/notifications")} style={styles.bell}>
          <Ionicons name="notifications-outline" size={22} color={colors.ink} />
          {(data?.unread ?? 0) > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{data!.unread > 9 ? "9+" : data!.unread}</Text>
            </View>
          )}
        </Pressable>
        </View>
      </ImageBackground>

      {/* Today's report status */}
      <Pressable onPress={() => router.push("/(tabs)/report")}>
        <Card style={{ backgroundColor: linksToday > 0 ? colors.greenSoft : colors.yellowSoft, borderColor: "transparent" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Ionicons
              name={linksToday > 0 ? "checkmark-circle" : "alert-circle"}
              size={28}
              color={linksToday > 0 ? colors.green : colors.amber}
            />
            <View style={{ flex: 1 }}>
              <Text style={styles.reportTitle}>
                {linksToday > 0 ? `${linksToday} link${linksToday === 1 ? "" : "s"} submitted today` : "No report submitted today"}
              </Text>
              <Text style={styles.reportSub}>
                {linksToday > 0 ? "Tap to add more links" : "Tap to submit your daily report"}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.sub} />
          </View>
        </Card>
      </Pressable>

      {/* Attendance */}
      {isEmployee && (
        <>
          <SectionTitle
            right={<SeeAll onPress={() => router.push("/attendance")} label="Details" />}
          >
            Attendance · This Month
          </SectionTitle>
          <View style={styles.statRow}>
            <Stat label="Present" value={(att as any).present} accent={colors.green} onPress={() => router.push("/attendance")} />
            <Stat label="Absent" value={(att as any).absent} accent={colors.red} onPress={() => router.push("/attendance")} />
            <Stat label="Late" value={(att as any).late} accent={colors.amber} onPress={() => router.push("/attendance")} />
            <Stat label="Rate" value={`${(att as any).rate}%`} accent={colors.purple} onPress={() => router.push("/attendance")} />
          </View>
        </>
      )}

      {/* Leave balance */}
      {data?.leaveBalance && (
        <>
          <SectionTitle
            right={<SeeAll onPress={() => router.push("/(tabs)/leave")} label="Apply" />}
          >
            Leave Balance
          </SectionTitle>
          <View style={styles.statRow}>
            <Stat label="Casual" value={data.leaveBalance.casual?.balance ?? "—"} onPress={() => router.push("/(tabs)/leave")} />
            <Stat label="Sick" value={data.leaveBalance.sick?.balance ?? "—"} onPress={() => router.push("/(tabs)/leave")} />
            <Stat label="Earned" value={data.leaveBalance.earned?.balance ?? "—"} onPress={() => router.push("/(tabs)/leave")} />
          </View>
        </>
      )}

      {/* Upcoming holidays */}
      <SectionTitle
        right={<SeeAll onPress={() => router.push("/holidays")} label="See All" />}
      >
        Upcoming Holidays
      </SectionTitle>
      <Card>
        {upcoming.length === 0 ? (
          <Empty icon="sunny-outline" text="No upcoming holidays this year" />
        ) : (
          upcoming.map((h, i) => (
            <View key={h.id} style={[styles.holidayRow, i === upcoming.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={styles.holidayDate}>
                <Text style={styles.holidayDay}>{new Date(h.date).getDate()}</Text>
                <Text style={styles.holidayMon}>
                  {new Date(h.date).toLocaleDateString("en-IN", { month: "short" })}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.holidayName}>{h.name}</Text>
                <Text style={styles.holidaySub}>{fmtDate(h.date)}</Text>
              </View>
            </View>
          ))
        )}
      </Card>
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
  avatar: { width: 46, height: 46, borderRadius: radius.full },
  avatarFallback: { backgroundColor: colors.purple, alignItems: "center", justifyContent: "center" },
  avatarLetter: { color: "#fff", fontSize: 20, fontWeight: "700" },
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
  badge: {
    position: "absolute",
    top: -2,
    right: -2,
    backgroundColor: colors.red,
    borderRadius: radius.full,
    minWidth: 17,
    height: 17,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  badgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  reportTitle: { fontSize: 15, fontWeight: "700", color: colors.ink },
  reportSub: { fontSize: 12, color: colors.sub, marginTop: 2 },
  statRow: { flexDirection: "row", gap: 8, marginBottom: spacing.md },
  link: { color: colors.purple, fontSize: 13, fontWeight: "600" },
  holidayRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  holidayDate: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.yellowSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  holidayDay: { fontSize: 16, fontWeight: "700", color: colors.ink },
  holidayMon: { fontSize: 10, color: colors.sub },
  holidayName: { fontSize: 14, fontWeight: "600", color: colors.ink },
  holidaySub: { fontSize: 12, color: colors.sub },
});
