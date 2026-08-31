import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate, fmtMoney } from "@/lib/api";
import { colors } from "@/lib/theme";
import { Screen, Card, Empty, Loading, ErrorBanner, useApi } from "@/components/ui";
import { formatStatus } from "@/lib/theme";

export default function OfferLettersScreen() {
  const { data, loading, refreshing, error, refresh } = useApi<any[]>(() => apiFetch("/hr/offer-letters"));

  if (loading) return <Loading />;
  const items = data ?? [];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {items.length === 0 ? (
        <Card>
          <Empty icon="mail-open-outline" text="No offer or appointment letters yet" />
        </Card>
      ) : (
        items.map((o: any) => (
          <Card key={o.id}>
            <Text style={styles.type}>{formatStatus(o.letterType ?? "OFFER")} Letter</Text>
            <View style={styles.row}><Text style={styles.label}>Designation</Text><Text style={styles.value}>{o.designation}</Text></View>
            {o.department ? <View style={styles.row}><Text style={styles.label}>Department</Text><Text style={styles.value}>{o.department}</Text></View> : null}
            <View style={styles.row}><Text style={styles.label}>Salary</Text><Text style={styles.value}>{fmtMoney(o.salary)}</Text></View>
            <View style={styles.row}><Text style={styles.label}>Joining date</Text><Text style={styles.value}>{fmtDate(o.joiningDate)}</Text></View>
            <View style={styles.row}><Text style={styles.label}>Issued</Text><Text style={styles.value}>{fmtDate(o.offerDate)}</Text></View>
            <Text style={styles.hint}>Open the full letter on hr.digitalsukoon.com</Text>
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  type: { fontSize: 15, fontWeight: "700", color: colors.purple, marginBottom: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  label: { fontSize: 13, color: colors.sub },
  value: { fontSize: 13, fontWeight: "600", color: colors.ink },
  hint: { fontSize: 11, color: colors.faint, marginTop: 8, textAlign: "center" },
});
