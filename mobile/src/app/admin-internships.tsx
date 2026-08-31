import React, { useState } from "react";
import { View, Text, StyleSheet, Modal, Pressable } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, radius, spacing, formatStatus } from "@/lib/theme";
import { Screen, Card, StatusPill, Button, Empty, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

const STATUSES = ["PENDING", "REVIEWING", "ACCEPTED", "REJECTED"] as const;

export default function AdminInternships() {
  const [statusFor, setStatusFor] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(() => apiFetch("/admin/internships"));

  const changeStatus = async (app: any, status: string) => {
    setStatusFor(null);
    try {
      await apiFetch(`/admin/internships/${app.id}/status`, { method: "POST", body: JSON.stringify({ status }) });
      setSuccessMsg(`Application → ${formatStatus(status)}`);
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
        <Card><Empty icon="school-outline" text="No internship applications" /></Card>
      ) : (
        items.map((a: any) => (
          <Card key={a.id}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.name, { flex: 1 }]} numberOfLines={1}>{a.name}</Text>
              <Pressable onPress={() => setStatusFor(a)}>
                <StatusPill status={a.status ?? "PENDING"} />
              </Pressable>
            </View>
            <Text style={styles.sub}>{a.email} {a.phone ? `· ${a.phone}` : ""}</Text>
            {a.college ? <Text style={styles.meta}>{a.college}</Text> : null}
            <Text style={styles.meta}>Applied {fmtDate(a.createdAt)}</Text>
          </Card>
        ))
      )}
      <Modal visible={!!statusFor} animationType="fade" transparent onRequestClose={() => setStatusFor(null)}>
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Application Status</Text>
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
  name: { fontSize: 15, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 3 },
  meta: { fontSize: 11, color: colors.faint, marginTop: 2 },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: spacing.xl },
  sheet: { backgroundColor: colors.cardHigh, borderRadius: radius.xl, padding: spacing.lg },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: colors.ink, marginBottom: 12 },
  optRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
});
