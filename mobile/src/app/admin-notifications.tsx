import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { apiFetch, errorMessage, fmtDateTime } from "@/lib/api";
import { colors, radius, sizes, spacing, tintColor, type } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { routeForNotification, notificationGlyph } from "@/lib/notifications";
import { Button, Screen, useApi } from "@/components/ui";
import { AsyncList } from "@/components/async";
import { toast } from "@/components/feedback";

type AdminNotification = {
  id: string;
  type?: string | null;
  title: string;
  message: string;
  read: boolean;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
};

/**
 * routeForNotification answers with employee-portal routes; map each one onto the admin
 * screen that handles the same thing. Anything without an admin counterpart has no route
 * (the full message is already shown inline).
 */
function adminRouteFor(n: AdminNotification): string | null {
  const route = routeForNotification({ type: n.type ?? undefined, metadata: n.metadata ?? null });
  if (!route) return null;
  if (route.startsWith("/task/") || route === "/(tabs)/tasks") return "/admin-tasks";
  if (route === "/(tabs)/leave") return "/(admin)/approvals?tab=LEAVES";
  if (route === "/expenses") return "/(admin)/approvals?tab=EXPENSES";
  if (route === "/extra-hours") return "/(admin)/approvals?tab=EXTRA_HOURS";
  if (route === "/documents") return "/(admin)/approvals?tab=DOCUMENTS";
  if (route === "/bug-report") return "/admin-bug-reports";
  if (route === "/complaints") return "/admin-complaints";
  if (route === "/(tabs)/report") return "/(admin)/reports";
  return null;
}

function NotificationRow({ n, last, onPress }: { n: AdminNotification; last: boolean; onPress: () => void }) {
  const glyph = notificationGlyph(n.type ?? undefined);
  const route = adminRouteFor(n);
  const unread = !n.read;
  const when = fmtDateTime(n.createdAt);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${unread ? "Unread. " : ""}${n.title}. ${n.message}. ${when}`}
      accessibilityHint={route ? "Opens the related screen" : unread ? "Marks as read" : undefined}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
    >
      <View style={styles.tile}>
        <Ionicons name={glyph.icon} size={sizes.iconGlyph} color={tintColor(glyph.tint)} />
      </View>
      <View style={[styles.body, last ? null : styles.divider]}>
        <View style={styles.text}>
          <Text maxFontSizeMultiplier={1.6} style={[styles.title, unread ? styles.titleUnread : null]}>
            {n.title}
          </Text>
          <Text maxFontSizeMultiplier={1.6} style={styles.message}>
            {n.message}
          </Text>
          <Text maxFontSizeMultiplier={1.6} style={styles.time}>
            {when}
          </Text>
        </View>
        <View style={styles.side}>
          {unread ? <View style={styles.dot} /> : null}
          {route ? <Ionicons name="chevron-forward" size={sizes.chevron} color={colors.faint} /> : null}
        </View>
      </View>
    </Pressable>
  );
}

export default function AdminNotifications() {
  const [markingAll, setMarkingAll] = useState(false);
  const list = useApi<AdminNotification[]>(async () => {
    const rows = await apiFetch<AdminNotification[]>("/admin/notifications");
    return Array.isArray(rows) ? rows : [];
  });

  const items = list.data ?? [];
  const unread = items.filter((n) => !n.read).length;

  const markAll = async () => {
    setMarkingAll(true);
    try {
      await apiFetch("/admin/notifications/read-all", { method: "PUT" });
      list.mutate((prev) => (prev ? prev.map((n) => ({ ...n, read: true })) : prev));
      void haptic("success");
    } catch (e) {
      void haptic("error");
      toast.show({ message: errorMessage(e, "Could not mark notifications as read"), tone: "danger" });
    } finally {
      setMarkingAll(false);
    }
  };

  const openNotification = (n: AdminNotification) => {
    if (!n.read) {
      list.mutate((prev) => (prev ? prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)) : prev));
      apiFetch(`/admin/notifications/${n.id}/read`, { method: "PUT" }).catch(() => undefined);
    }
    const route = adminRouteFor(n);
    if (route) router.push(route as never);
  };

  return (
    <Screen onRefresh={list.refresh} refreshing={list.refreshing}>
      <AsyncList
        state={list}
        grouped
        header={
          unread > 0 ? (
            <Button
              title={`Mark all ${unread} as read`}
              variant="plain"
              size="sm"
              fullWidth={false}
              loading={markingAll}
              onPress={markAll}
              style={styles.markAll}
            />
          ) : null
        }
        keyExtractor={(n) => n.id}
        renderItem={(n, i, all) => (
          <NotificationRow n={n} last={i === all.length - 1} onPress={() => openNotification(n)} />
        )}
        empty={{ icon: "notifications-off-outline", title: "No notifications", text: "You're all caught up." }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  markAll: { alignSelf: "flex-end", marginBottom: spacing.sm },
  row: { flexDirection: "row", alignItems: "flex-start", paddingLeft: spacing.lg },
  pressed: { opacity: 0.6 },
  tile: {
    width: sizes.iconTile,
    height: sizes.iconTile,
    borderRadius: radius.tile,
    backgroundColor: colors.cardHigh,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.md,
    marginRight: spacing.md,
  },
  body: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-start", paddingVertical: spacing.md, paddingRight: spacing.lg },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  text: { flex: 1, minWidth: 0 },
  title: { ...type.body, color: colors.ink },
  titleUnread: { fontWeight: "600" },
  message: { ...type.subhead, color: colors.sub, marginTop: 2, lineHeight: 20 },
  time: { ...type.footnote, color: colors.tertiary, marginTop: spacing.xs },
  side: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginLeft: spacing.sm, minHeight: 22 },
  dot: { width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.purple },
});
