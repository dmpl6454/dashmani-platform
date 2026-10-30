import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { apiFetch } from "@/lib/api";
import { colors, spacing, type } from "@/lib/theme";
import { useApi } from "@/lib/hooks/useApi";
import { Avatar, Screen } from "@/components/ui";
import { ListItem } from "@/components/list";
import { AsyncList } from "@/components/async";

type LeaderboardEntry = {
  rank?: number;
  employee?: { id?: string; name?: string | null; profileImageUrl?: string | null } | null;
  totalReports?: number;
  totalLinks?: number;
  currentStreak?: number;
};

export default function AdminLeaderboard() {
  const router = useRouter();
  const state = useApi<LeaderboardEntry[]>(() => apiFetch<LeaderboardEntry[]>("/admin/reports/leaderboard"));

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        grouped
        keyExtractor={(e, i) => e.employee?.id ?? String(i)}
        empty={{
          icon: "trophy-outline",
          title: "No leaderboard data",
          text: "Rankings appear once employees submit daily reports.",
        }}
        renderItem={(e, i) => {
          const rank = e.rank ?? i + 1;
          const name = e.employee?.name || "Unknown";
          const reports = e.totalReports ?? 0;
          const links = e.totalLinks ?? 0;
          const streak = e.currentStreak ?? 0;
          const empId = e.employee?.id;
          return (
            <ListItem
              leading={
                <View style={styles.lead}>
                  <Text maxFontSizeMultiplier={1.3} style={[styles.rank, rank <= 3 ? styles.rankTop : null]}>
                    {rank}
                  </Text>
                  <Avatar name={name} uri={e.employee?.profileImageUrl} size={36} ring={rank <= 3} />
                </View>
              }
              title={name}
              subtitle={`${reports} reports · ${links} links`}
              trailing={
                <View style={styles.streak}>
                  <Text maxFontSizeMultiplier={1.3} style={styles.streakVal}>
                    {streak}
                  </Text>
                  <Text maxFontSizeMultiplier={1.3} style={styles.streakLabel}>
                    day streak
                  </Text>
                </View>
              }
              onPress={
                empId
                  ? () => router.push(`/admin-employee/${empId}?name=${encodeURIComponent(e.employee?.name ?? "")}`)
                  : undefined
              }
              accessibilityLabel={`Rank ${rank}, ${name}, ${reports} reports, ${links} links, ${streak} day streak`}
            />
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  lead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rank: { ...type.subhead, ...type.numeric, width: 24, fontWeight: "600", color: colors.sub, textAlign: "center" },
  rankTop: { color: colors.warningText, fontWeight: "700" },
  streak: { alignItems: "center", marginLeft: spacing.sm },
  streakVal: { ...type.headline, ...type.numeric, color: colors.ink },
  streakLabel: { ...type.caption2, color: colors.sub },
});
