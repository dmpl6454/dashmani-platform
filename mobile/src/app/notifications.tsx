import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter, type Href } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, errorMessage, timeAgo } from "@/lib/api";
import { colors, radius, sizes, spacing, tintColor, type } from "@/lib/theme";
import { Screen, invalidate, useApi } from "@/components/ui";
import { HeaderButton } from "@/components/list";
import { AsyncList } from "@/components/async";
import { toast } from "@/components/feedback";
import { haptic } from "@/lib/device";
import { useBadges } from "@/lib/hooks/shared";
import { notificationGlyph, routeForNotification } from "@/lib/notifications";

type AppNotification = {
  id: string;
  type?: string | null;
  title: string;
  message?: string | null;
  read: boolean;
  createdAt: string;
  metadata?: unknown;
};

function metaOf(n: AppNotification): Record<string, unknown> | null {
  const m = n.metadata;
  return m !== null && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : null;
}

function destinationOf(n: AppNotification): string | null {
  return routeForNotification({ type: n.type ?? undefined, metadata: metaOf(n) });
}

type RowProps = {
  n: AppNotification;
  last: boolean;
  expanded: boolean;
  onPress: () => void;
};

function NotificationRow({ n, last, expanded, onPress }: RowProps) {
  const glyph = notificationGlyph(n.type ?? undefined);
  const tint = tintColor(glyph.tint);
  const routed = destinationOf(n) !== null;
  const unread = !n.read;
  const when = timeAgo(n.createdAt);
  const label = [unread ? "Unread" : null, n.title, n.message, when].filter((s): s is string => !!s).join(", ");
  let hint: string | undefined;
  if (routed) hint = "Opens the related screen";
  else if (n.message) hint = expanded ? "Collapses the message" : "Shows the full message";

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={routed ? undefined : { expanded }}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      <View style={styles.row}>
        <View style={styles.tile}>
          <View style={[StyleSheet.absoluteFill, styles.tileWash, { backgroundColor: tint }]} />
          <Ionicons name={glyph.icon} size={sizes.iconGlyph} color={tint} />
        </View>
        <View style={[styles.body, last ? null : styles.hairline]}>
          <View style={styles.text}>
            <View style={styles.titleRow}>
              <Text
                maxFontSizeMultiplier={1.6}
                numberOfLines={2}
                style={[styles.title, unread ? styles.titleUnread : null]}
              >
                {n.title}
              </Text>
              <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={styles.time}>
                {when}
              </Text>
            </View>
            {n.message ? (
              <Text maxFontSizeMultiplier={1.6} numberOfLines={expanded ? undefined : 2} style={styles.message}>
                {n.message}
              </Text>
            ) : null}
          </View>
          {unread ? <View accessible accessibilityLabel="Unread" style={styles.dot} /> : null}
          {routed ? (
            <Ionicons name="chevron-forward" size={sizes.chevron} color={colors.faint} style={styles.chevron} />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const router = useRouter();
  const state = useApi<AppNotification[]>(() => apiFetch<AppNotification[]>("/hr/notifications"));
  const { unread: badgeUnread } = useBadges();
  const [markingAll, setMarkingAll] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Rows read during this visit stay under "New" so nothing jumps while the person reads.
  const [readNow, setReadNow] = useState<Record<string, boolean>>({});

  const items = state.data;
  const localUnread = items ? items.filter((n) => !n.read).length : 0;
  // The list is capped at 50 rows; the server count covers older unread rows too.
  const unread = badgeUnread ?? localUnread;

  const isNew = (n: AppNotification) => !n.read || !!readNow[n.id];
  const sectionOf = (n: AppNotification) => (isNew(n) ? "New" : "Earlier");
  const ordered = items ? [...items.filter(isNew), ...items.filter((n) => !isNew(n))] : undefined;

  const setRead = (ids: Set<string>, read: boolean) => {
    state.mutate((list) => (list ? list.map((x) => (ids.has(x.id) ? { ...x, read } : x)) : list));
  };

  const markAll = async (): Promise<void> => {
    if (markingAll) return;
    const wasUnread = new Set((state.data ?? []).filter((n) => !n.read).map((n) => n.id));
    setMarkingAll(true);
    state.mutate((list) => (list ? list.map((x) => ({ ...x, read: true })) : list));
    try {
      await apiFetch("/hr/notifications/read-all", { method: "PUT" });
      void haptic("success");
      toast.show({ message: "All caught up", tone: "success" });
    } catch (e: unknown) {
      setRead(wasUnread, false);
      void haptic("error");
      toast.show({ message: errorMessage(e, "Couldn't mark them as read. Try again."), tone: "danger" });
    } finally {
      setMarkingAll(false);
      invalidate("notifications");
    }
  };

  const open = (n: AppNotification) => {
    const to = destinationOf(n);
    if (!n.read) {
      const only = new Set([n.id]);
      setReadNow((s) => ({ ...s, [n.id]: true }));
      setRead(only, true);
      apiFetch(`/hr/notifications/${n.id}/read`, { method: "PUT" }).then(
        () => invalidate("notifications"),
        (e: unknown) => {
          setRead(only, false);
          toast.show({ message: errorMessage(e, "Couldn't mark it as read."), tone: "danger" });
        },
      );
    }
    if (to) router.push(to as Href);
    else setExpanded((s) => ({ ...s, [n.id]: !s[n.id] }));
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderButton
              icon="checkmark-done-outline"
              label={unread > 0 ? `Mark all ${unread} as read` : "Mark all as read"}
              onPress={() => {
                void markAll();
              }}
              disabled={markingAll || unread === 0}
            />
          ),
        }}
      />
      <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
        <AsyncList
          state={state}
          items={ordered}
          grouped
          sectionOf={sectionOf}
          keyExtractor={(n) => n.id}
          renderItem={(n, i, all) => {
            const next = all[i + 1];
            const last = !next || sectionOf(next) !== sectionOf(n);
            return <NotificationRow n={n} last={last} expanded={!!expanded[n.id]} onPress={() => open(n)} />;
          }}
          empty={{
            icon: "notifications-off-outline",
            title: "No notifications",
            text: "Updates about your tasks, leave and reports will show up here.",
          }}
        />
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  pressed: { backgroundColor: colors.pressOverlay },
  row: { flexDirection: "row", alignItems: "flex-start", paddingLeft: spacing.lg, minHeight: sizes.rowMin },
  tile: {
    width: sizes.iconTile,
    height: sizes.iconTile,
    borderRadius: radius.tile,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.md,
    marginRight: spacing.md,
  },
  tileWash: { opacity: 0.16 },
  body: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    paddingRight: spacing.lg,
  },
  hairline: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  text: { flex: 1, minWidth: 0, paddingRight: spacing.sm },
  titleRow: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  title: { ...type.body, color: colors.ink, flex: 1 },
  titleUnread: { fontWeight: "600" },
  time: { ...type.footnote, color: colors.tertiary },
  message: { ...type.subhead, color: colors.sub, marginTop: 2, lineHeight: 20 },
  dot: { width: 6, height: 6, borderRadius: radius.full, backgroundColor: colors.purple, marginLeft: spacing.xs },
  chevron: { marginLeft: spacing.xs },
});
