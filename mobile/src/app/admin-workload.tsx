import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch } from "@/lib/api";
import { colors, statusColor, formatStatus } from "@/lib/theme";
import { Screen, Card, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

export default function AdminWorkload() {
  const { data, loading, refreshing, error, refresh } = useApi<any>(() => apiFetch("/workload"));

  if (loading) return <Loading />;
  const rows: any[] = Array.isArray(data) ? data : data?.items ?? data?.employees ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {rows.length === 0 ? (
        <Card><Empty icon="pulse-outline" text="No workload data" /></Card>
      ) : (
        <Card>
          {rows.map((r: any, i: number) => {
            const byPr = r.tasksByPriority ?? {};
            return (
              <View key={r.employeeId ?? r.id ?? i} style={[styles.row, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>{r.employeeName ?? r.name}</Text>
                  <Text style={styles.sub}>
                    {r.accountCount ?? r.accounts ?? 0} account(s) · {r.taskCount ?? r.openTasks ?? 0} open task(s)
                  </Text>
                </View>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {["critical", "high", "medium", "low"].map((k) => {
                    const v = byPr[k] ?? 0;
                    if (!v) return null;
                    const c = statusColor(k.toUpperCase());
                    return (
                      <View key={k} style={[styles.prPill, { backgroundColor: c.bg }]}>
                        <Text style={[styles.prText, { color: c.fg }]}>{formatStatus(k)} {v}</Text>
                      </View>
                    );
                  })}
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
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  name: { fontSize: 14, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 2 },
  prPill: { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999 },
  prText: { fontSize: 10, fontWeight: "700" },
});
