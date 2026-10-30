import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { apiFetch, errorMessage, fmtDate } from "@/lib/api";
import { colors, formatStatus, spacing, statusTone, type, type TintKey, type Tone } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Button, Card, Screen, StatusPill, useApi, type IoniconName } from "@/components/ui";
import { AsyncList } from "@/components/async";
import { PickerSheet } from "@/components/sheet";
import { toast } from "@/components/feedback";

const STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "WONT_FIX"] as const;
type BugStatus = (typeof STATUSES)[number];
const STATUS_LIST: BugStatus[] = [...STATUSES];

const STATUS_ICON: Record<BugStatus, IoniconName> = {
  OPEN: "ellipse-outline",
  IN_PROGRESS: "time-outline",
  RESOLVED: "checkmark-circle-outline",
  CLOSED: "lock-closed-outline",
  WONT_FIX: "remove-circle-outline",
};

const TONE_TINT: Record<Tone, TintKey> = {
  neutral: "gray",
  brand: "brand",
  success: "green",
  warning: "orange",
  danger: "red",
  info: "blue",
};

type Person = { name?: string | null } | null;

type Bug = {
  id: string;
  title: string;
  description?: string | null;
  severity?: string | null;
  status: string;
  createdAt: string;
  page?: string | null;
  reporter?: Person;
  reportedByUser?: Person;
};

function metaLine(b: Bug): string {
  return [
    b.reporter?.name ?? b.reportedByUser?.name ?? "Employee",
    b.severity ? formatStatus(b.severity) : null,
    fmtDate(b.createdAt),
    b.page || null,
  ]
    .filter((s): s is string => !!s)
    .join(" · ");
}

export default function AdminBugReports() {
  const state = useApi<Bug[]>(() => apiFetch<Bug[]>("/admin/bug-reports"));

  const [statusFor, setStatusFor] = useState<Bug | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const changeStatus = async (bug: Bug, status: BugStatus) => {
    if (status === bug.status) return;
    setUpdatingId(bug.id);
    try {
      await apiFetch(`/admin/bug-reports/${bug.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      void haptic("success");
      toast.show({ message: `Marked ${formatStatus(status)}`, tone: "success" });
      await state.reload();
    } catch (e) {
      void haptic("error");
      toast.show({ message: errorMessage(e, "Could not update the status"), tone: "danger" });
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        skeleton="cards"
        keyExtractor={(b) => b.id}
        empty={{
          icon: "bug-outline",
          title: "No bug reports",
          text: "Bugs employees report from the app appear here.",
          tone: "success",
        }}
        renderItem={(b) => {
          const busy = updatingId === b.id;
          return (
            <Card>
              <View style={styles.head}>
                <Text style={styles.title} numberOfLines={2} maxFontSizeMultiplier={1.6}>
                  {b.title}
                </Text>
                {busy ? (
                  <ActivityIndicator color={colors.sub} accessibilityLabel="Updating status" />
                ) : (
                  <Pressable
                    onPress={() => setStatusFor(b)}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={`Status ${formatStatus(b.status)}. Change status`}
                  >
                    <StatusPill status={b.status} size="sm" />
                  </Pressable>
                )}
              </View>
              <Text style={styles.meta} maxFontSizeMultiplier={1.6}>
                {metaLine(b)}
              </Text>
              {b.description ? (
                <Text style={styles.desc} numberOfLines={4} maxFontSizeMultiplier={1.6}>
                  {b.description}
                </Text>
              ) : null}
              <Button
                title="Change status"
                icon="swap-vertical-outline"
                variant="plain"
                size="sm"
                fullWidth={false}
                disabled={busy}
                onPress={() => setStatusFor(b)}
                accessibilityLabel={`Change status of ${b.title}`}
                style={styles.action}
              />
            </Card>
          );
        }}
      />

      <PickerSheet<BugStatus>
        visible={!!statusFor}
        onClose={() => setStatusFor(null)}
        title="Update status"
        items={STATUS_LIST}
        keyOf={(s) => s}
        labelOf={(s) => formatStatus(s)}
        iconOf={(s) => STATUS_ICON[s]}
        tintOf={(s) => TONE_TINT[statusTone(s)]}
        selectedKey={statusFor?.status ?? null}
        searchable={false}
        onSelect={(s) => {
          const bug = statusFor;
          if (bug) void changeStatus(bug, s);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  title: { ...type.headline, color: colors.ink, flex: 1 },
  meta: { ...type.footnote, color: colors.sub, marginTop: spacing.xs },
  desc: { ...type.subhead, color: colors.ink, marginTop: spacing.sm, lineHeight: 21 },
  action: { marginTop: spacing.sm },
});
