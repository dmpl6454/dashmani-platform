import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { router } from "expo-router";
import { apiFetch, fmtDateTime } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

/**
 * Where tapping a notification goes in the app. Pipeline rows carry `metadata.path`
 * ("/pipeline/<id>", the same path the HR web bell opens); "task assigned" rows open the
 * Tasks tab (the API does not put the task id on the row).
 * Anything else just marks the row read.
 */
function destinationOf(n: any): string | null {
  const path: unknown = n?.metadata?.path;
  if (typeof path === "string") {
    const m = /^\/pipeline(?:\/([0-9a-f-]{36}))?\/?$/i.exec(path);
    if (m) return m[1] ? `/pipeline/${m[1]}` : "/pipeline";
  }
  if (n?.type === "TASK_ASSIGNED") return "/tasks";
  return null;
}

export default function NotificationsScreen() {
  const [markingAll, setMarkingAll] = useState(false);
  const { data, loading, refreshing, error, refresh, setData } = useApi<any[]>(() => apiFetch("/hr/notifications"));

  const markAll = async () => {
    setMarkingAll(true);
    try {
      await apiFetch("/hr/notifications/read-all", { method: "PUT" });
      setData((data ?? []).map((n) => ({ ...n, read: true })));
    } catch {
      // ignore
    } finally {
      setMarkingAll(false);
    }
  };

  const markOne = async (n: any) => {
    if (!n.read) {
      setData((data ?? []).map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      apiFetch(`/hr/notifications/${n.id}/read`, { method: "PUT" }).catch(() => {});
    }
    const to = destinationOf(n);
    if (to) router.push(to as never);
  };

  if (loading) return <Loading />;

  const items = data ?? [];
  const unread = items.filter((n) => !n.read).length;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {unread > 0 && (
        <Pressable onPress={markAll} disabled={markingAll}>
          <Text style={styles.markAll}>{markingAll ? "Marking…" : `Mark all ${unread} as read`}</Text>
        </Pressable>
      )}
      {items.length === 0 ? (
        <Card>
          <Empty icon="notifications-off-outline" text="No notifications" />
        </Card>
      ) : (
        <Card>
          {items.map((n: any, i: number) => (
            <Pressable key={n.id} onPress={() => markOne(n)}>
              <View style={[styles.row, i === items.length - 1 && { borderBottomWidth: 0 }]}>
                {!n.read && <View style={styles.dot} />}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.title, !n.read && { fontWeight: "700" }]}>{n.title}</Text>
                  <Text style={styles.message}>{n.message}</Text>
                  <Text style={styles.time}>{fmtDateTime(n.createdAt)}</Text>
                </View>
              </View>
            </Pressable>
          ))}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  markAll: { color: colors.purple, fontWeight: "600", fontSize: 13, marginBottom: spacing.sm, textAlign: "right" },
  row: {
    flexDirection: "row",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    alignItems: "flex-start",
  },
  dot: { width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.purple, marginTop: 6 },
  title: { fontSize: 14, fontWeight: "600", color: colors.ink },
  message: { fontSize: 13, color: colors.sub, marginTop: 2, lineHeight: 18 },
  time: { fontSize: 11, color: colors.faint, marginTop: 4 },
});
