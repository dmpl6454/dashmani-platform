import React, { useState } from "react";
import { View, Text, StyleSheet, Alert } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, Button, Empty, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

export default function AdminDevices() {
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(() => apiFetch("/admin/devices/all"));

  const markReturned = (d: any) => {
    Alert.alert("Mark returned?", `${d.deviceType ?? "Device"} from ${d.employee?.name ?? "employee"}`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Returned",
        onPress: async () => {
          setActing(d.id);
          try {
            await apiFetch(`/admin/devices/${d.id}/return`, { method: "POST" });
            setSuccessMsg("Device marked returned");
            reload();
          } catch (e: any) {
            setError(e?.message || "Failed");
          } finally {
            setActing(null);
          }
        },
      },
    ]);
  };

  if (loading) return <Loading />;
  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <SuccessBanner message={successMsg} />
      {items.length === 0 ? (
        <Card><Empty icon="laptop-outline" text="No devices assigned" /></Card>
      ) : (
        items.map((d: any) => (
          <Card key={d.id}>
            <Text style={styles.name}>{d.deviceType ?? d.name ?? "Device"} {d.model ? `· ${d.model}` : ""}</Text>
            <Text style={styles.sub}>
              {d.employee?.name ?? "Unassigned"} · assigned {fmtDate(d.assignedAt)}
            </Text>
            {d.serialNumber ? <Text style={styles.meta}>SN: {d.serialNumber}</Text> : null}
            {d.returnedAt ? (
              <Text style={styles.returned}>Returned {fmtDate(d.returnedAt)}</Text>
            ) : (
              <Button title="Mark Returned" small variant="ghost" loading={acting === d.id} onPress={() => markReturned(d)} style={{ marginTop: spacing.sm }} />
            )}
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: 14, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 3 },
  meta: { fontSize: 11, color: colors.faint, marginTop: 2 },
  returned: { fontSize: 12, color: colors.green, fontWeight: "600", marginTop: 6 },
});
