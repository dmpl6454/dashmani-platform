import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, radius, spacing, statusColor, formatStatus } from "@/lib/theme";
import { Screen, Card, StatusPill, Empty, Loading, ErrorBanner, Chips, useApi } from "@/components/ui";

const FILTERS = ["ALL", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const;
type Filter = (typeof FILTERS)[number];

export default function TasksScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("ALL");
  const { data: tasks, loading, refreshing, error, refresh } = useApi<any[]>(() => apiFetch("/hr/tasks"));

  if (loading) return <Loading />;

  const list = (tasks ?? []).filter((t) => filter === "ALL" || t.status === filter);

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <Chips options={FILTERS} value={filter} onChange={setFilter} labels={{ ALL: "All" }} />
      {list.length === 0 ? (
        <Card>
          <Empty icon="checkbox-outline" text={filter === "ALL" ? "No tasks assigned to you" : `No ${formatStatus(filter)} tasks`} />
        </Card>
      ) : (
        list.map((t) => {
          const pr = statusColor(t.priority ?? "");
          return (
            <Pressable key={t.id} onPress={() => router.push(`/task/${t.id}`)}>
              <Card>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.title} numberOfLines={2}>
                      {t.title}
                    </Text>
                  </View>
                  <StatusPill status={t.status} />
                </View>
                {t.description ? (
                  <Text style={styles.desc} numberOfLines={2}>
                    {t.description}
                  </Text>
                ) : null}
                <View style={styles.metaRow}>
                  {t.priority ? (
                    <View style={[styles.prBadge, { backgroundColor: pr.bg }]}>
                      <Text style={[styles.prText, { color: pr.fg }]}>{formatStatus(t.priority)}</Text>
                    </View>
                  ) : null}
                  {t.dueDate ? (
                    <Text style={styles.meta}>
                      <Ionicons name="calendar-outline" size={12} color={colors.sub} /> Due {fmtDate(t.dueDate)}
                    </Text>
                  ) : null}
                  {t.account?.displayName ? (
                    <Text style={styles.meta} numberOfLines={1}>
                      <Ionicons name="at-outline" size={12} color={colors.sub} /> {t.account.displayName}
                    </Text>
                  ) : null}
                  {(t.comments?.length ?? 0) > 0 ? (
                    <Text style={styles.meta}>
                      <Ionicons name="chatbubble-outline" size={12} color={colors.sub} /> {t.comments.length}
                    </Text>
                  ) : null}
                </View>
              </Card>
            </Pressable>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 15, fontWeight: "700", color: colors.ink },
  desc: { fontSize: 13, color: colors.sub, marginTop: 6 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap" },
  meta: { fontSize: 12, color: colors.sub },
  prBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full },
  prText: { fontSize: 10, fontWeight: "700" },
});
