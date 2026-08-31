import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtMoney, MONTHS } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, StatusPill, Button, Empty, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

export default function AdminSalarySlips() {
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(() => apiFetch("/admin/salary-slips"));

  const approve = async (slip: any) => {
    setActing(slip.id);
    setError(null);
    try {
      await apiFetch(`/admin/salary-slips/${slip.id}/approve`, { method: "POST" });
      setSuccessMsg("Slip approved");
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not approve");
    } finally {
      setActing(null);
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
          <Empty icon="cash-outline" text="No salary slips" />
        </Card>
      ) : (
        items.map((s: any) => (
          <Card key={s.id}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.who} numberOfLines={1}>
                  {s.employee?.name ?? "Employee"}
                </Text>
                <Text style={styles.period}>
                  {MONTHS[(s.month ?? 1) - 1]} {s.year} · Net {fmtMoney(s.netSalary)}
                </Text>
              </View>
              <StatusPill status={s.status} />
            </View>
            {s.status === "DRAFT" || s.status === "PENDING" ? (
              <Button
                title="Approve"
                small
                loading={acting === s.id}
                onPress={() => approve(s)}
                style={{ marginTop: spacing.md, backgroundColor: colors.green }}
              />
            ) : null}
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  who: { fontSize: 15, fontWeight: "700", color: colors.ink },
  period: { fontSize: 13, color: colors.sub, marginTop: 2 },
});
