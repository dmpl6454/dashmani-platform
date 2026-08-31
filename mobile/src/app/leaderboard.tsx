import React from "react";
import { View, Text, StyleSheet, Image } from "react-native";
import { apiFetch, API_BASE } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

export default function LeaderboardScreen() {
  const { user } = useAuth();
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(() => apiFetch("/hr/leaderboard"));

  if (loading) return <Loading />;

  const rows = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {rows.length === 0 ? (
        <Card>
          <Empty icon="trophy-outline" text="No leaderboard data yet" />
        </Card>
      ) : (
        <Card>
          {rows.map((e: any, i: number) => {
            const me = e.employee?.id === user?.id;
            const img = e.employee?.profileImageUrl
              ? e.employee.profileImageUrl.startsWith("http")
                ? e.employee.profileImageUrl
                : `${API_BASE}${e.employee.profileImageUrl}`
              : null;
            const medal = e.rank === 1 ? "🥇" : e.rank === 2 ? "🥈" : e.rank === 3 ? "🥉" : null;
            return (
              <View
                key={e.employee?.id ?? i}
                style={[
                  styles.row,
                  me && { backgroundColor: colors.purpleSoft, borderRadius: radius.sm, paddingHorizontal: 8 },
                  i === rows.length - 1 && { borderBottomWidth: 0 },
                ]}
              >
                <Text style={styles.rank}>{medal ?? `#${e.rank}`}</Text>
                {img ? (
                  <Image source={{ uri: img }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarLetter}>{(e.employee?.name || "?").charAt(0)}</Text>
                  </View>
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.name, me && { color: colors.purpleDark }]} numberOfLines={1}>
                    {e.employee?.name} {me ? "(You)" : ""}
                  </Text>
                  <Text style={styles.meta}>
                    {e.totalReports ?? 0} reports · {e.totalLinks ?? 0} links
                  </Text>
                </View>
                <View style={styles.streak}>
                  <Text style={styles.streakVal}>{e.currentStreak ?? 0}🔥</Text>
                  <Text style={styles.streakLabel}>streak</Text>
                </View>
              </View>
            );
          })}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rank: { width: 36, fontSize: 14, fontWeight: "800", color: colors.sub, textAlign: "center" },
  avatar: { width: 36, height: 36, borderRadius: radius.full },
  avatarFallback: { backgroundColor: colors.yellow, alignItems: "center", justifyContent: "center" },
  avatarLetter: { fontSize: 15, fontWeight: "800", color: colors.inkOnAccent },
  name: { fontSize: 14, fontWeight: "700", color: colors.ink },
  meta: { fontSize: 12, color: colors.sub, marginTop: 1 },
  streak: { alignItems: "center" },
  streakVal: { fontSize: 14, fontWeight: "700", color: colors.ink },
  streakLabel: { fontSize: 10, color: colors.sub },
});
