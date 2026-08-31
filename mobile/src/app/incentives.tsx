import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate, fmtMoney, MONTHS } from "@/lib/api";
import { colors } from "@/lib/theme";
import { Screen, Card, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";

export default function IncentivesScreen() {
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(() => apiFetch("/hr/incentives"));

  if (loading) return <Loading />;

  const items = data ?? [];
  const total = items.reduce((s, i) => s + (i.amount || 0), 0);

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {items.length > 0 && (
        <Card style={{ backgroundColor: colors.greenSoft, borderColor: "transparent", alignItems: "center" }}>
          <Text style={styles.totalLabel}>Total earned</Text>
          <Text style={styles.totalValue}>{fmtMoney(total)}</Text>
        </Card>
      )}
      {items.length === 0 ? (
        <Card>
          <Empty icon="gift-outline" text="No incentives awarded yet" />
        </Card>
      ) : (
        <Card>
          {items.map((inc: any, i: number) => (
            <View key={inc.id} style={[styles.row, i === items.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.reason}>{inc.reason}</Text>
                <Text style={styles.sub}>
                  {inc.month && inc.year ? `${MONTHS[inc.month - 1]} ${inc.year}` : fmtDate(inc.createdAt)}
                </Text>
              </View>
              <Text style={styles.amount}>{fmtMoney(inc.amount)}</Text>
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  totalLabel: { fontSize: 12, color: colors.green, fontWeight: "600" },
  totalValue: { fontSize: 26, fontWeight: "700", color: colors.green, marginTop: 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  reason: { fontSize: 14, fontWeight: "600", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 2 },
  amount: { fontSize: 15, fontWeight: "700", color: colors.green },
});
