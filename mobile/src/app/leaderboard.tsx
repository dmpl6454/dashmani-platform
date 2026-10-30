import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors, spacing, type } from "@/lib/theme";
import { Avatar, Screen, useApi } from "@/components/ui";
import { ListItem, StatGrid, StatTile } from "@/components/list";
import { AsyncList } from "@/components/async";

type LeaderEntry = {
  rank: number;
  employee?: { id: string; name?: string | null; profileImageUrl?: string | null } | null;
  totalReports?: number | null;
  totalLinks?: number | null;
  currentStreak?: number | null;
};

export default function LeaderboardScreen() {
  const { user } = useAuth();
  const myId = user?.id ?? null;
  const state = useApi<LeaderEntry[]>(() => apiFetch<LeaderEntry[]>("/hr/leaderboard"));

  const mine = myId ? (state.data ?? []).find((e) => e.employee?.id === myId) : undefined;

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        grouped
        keyExtractor={(e, i) => e.employee?.id ?? String(i)}
        empty={{
          icon: "trophy-outline",
          title: "No rankings yet",
          text: "Submit your daily report to get on the board.",
        }}
        header={
          mine ? (
            <StatGrid>
              <StatTile label="Your rank" value={`#${mine.rank}`} icon="trophy-outline" tone="warning" />
              <StatTile label="Day streak" value={mine.currentStreak ?? 0} icon="flame-outline" tone="brand" />
            </StatGrid>
          ) : null
        }
        renderItem={(e) => {
          const me = !!myId && e.employee?.id === myId;
          const name = e.employee?.name || "Unknown";
          return (
            <ListItem
              leading={
                <View style={styles.lead}>
                  <Text style={[styles.rank, e.rank <= 3 ? styles.rankTop : null]}>{e.rank}</Text>
                  <Avatar name={name} uri={e.employee?.profileImageUrl} size={36} ring={me} />
                </View>
              }
              title={me ? `${name} (You)` : name}
              subtitle={`${e.totalReports ?? 0} reports · ${e.totalLinks ?? 0} links`}
              trailing={
                <View style={styles.streak}>
                  <Text style={styles.streakVal}>{e.currentStreak ?? 0}</Text>
                  <Text style={styles.streakLabel}>day streak</Text>
                </View>
              }
            />
          );
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  lead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  rank: { ...type.subhead, ...type.numeric, width: 28, fontWeight: "600", color: colors.sub, textAlign: "center" },
  rankTop: { color: colors.warningText, fontWeight: "700" },
  streak: { alignItems: "center", minWidth: 56 },
  streakVal: { ...type.subhead, ...type.numeric, fontWeight: "700", color: colors.ink },
  streakLabel: { ...type.caption2, color: colors.sub },
});
