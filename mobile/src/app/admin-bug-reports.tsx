import React, { useState } from "react";
import { View, Text, StyleSheet, Modal, Pressable } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, radius, spacing, formatStatus } from "@/lib/theme";
import { Screen, Card, StatusPill, Button, Empty, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

const STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "WONT_FIX"] as const;

export default function AdminBugReports() {
  const [statusFor, setStatusFor] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(() => apiFetch("/admin/bug-reports"));

  const changeStatus = async (bug: any, status: string) => {
    setStatusFor(null);
    setError(null);
    try {
      await apiFetch(`/admin/bug-reports/${bug.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      setSuccessMsg(`Bug → ${formatStatus(status)}`);
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not update");
    }
  };

  if (loading) return <Loading />;
  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <SuccessBanner message={successMsg} />
      {items.length === 0 ? (
        <Card>
          <Empty icon="bug-outline" text="No bug reports" />
        </Card>
      ) : (
        items.map((b: any) => (
          <Card key={b.id}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.title, { flex: 1 }]} numberOfLines={2}>
                {b.title}
              </Text>
              <Pressable onPress={() => setStatusFor(b)}>
                <StatusPill status={b.status} />
              </Pressable>
            </View>
            <Text style={styles.meta}>
              {b.reporter?.name ?? b.reportedByUser?.name ?? "Employee"} · {b.severity} · {fmtDate(b.createdAt)}
              {b.page ? ` · ${b.page}` : ""}
            </Text>
            <Text style={styles.desc} numberOfLines={4}>
              {b.description}
            </Text>
            <Text style={styles.tapHint}>Tap the status pill to change it</Text>
          </Card>
        ))
      )}

      <Modal visible={!!statusFor} animationType="fade" transparent onRequestClose={() => setStatusFor(null)}>
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Update Bug Status</Text>
            {STATUSES.map((s) => (
              <Pressable key={s} style={styles.optRow} onPress={() => changeStatus(statusFor, s)}>
                <StatusPill status={s} />
              </Pressable>
            ))}
            <Button title="Cancel" onPress={() => setStatusFor(null)} variant="ghost" small style={{ marginTop: spacing.sm }} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 15, fontWeight: "700", color: colors.ink },
  meta: { fontSize: 12, color: colors.faint, marginTop: 4 },
  desc: { fontSize: 13, color: colors.ink, marginTop: 8, lineHeight: 19 },
  tapHint: { fontSize: 10, color: colors.faint, marginTop: 8 },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: spacing.xl },
  sheet: { backgroundColor: colors.cardHigh, borderRadius: radius.xl, padding: spacing.lg },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: colors.ink, marginBottom: 12 },
  optRow: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
});
