import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable, Modal, ScrollView } from "react-native";
import { apiFetch, fmtMoney, MONTHS } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, StatusPill, Empty, Loading, ErrorBanner, Button, useApi } from "@/components/ui";

export default function SalarySlipsScreen() {
  const [selected, setSelected] = useState<any | null>(null);
  const { data: slips, loading, refreshing, error, refresh } = useApi<any[]>(() => apiFetch("/hr/salary-slips"));

  if (loading) return <Loading />;

  const earnRows = (s: any) => [
    ["Basic Salary", s.basicSalary],
    ["HRA", s.hra],
    ["Conveyance", s.conveyance],
    ["Medical Allowance", s.medicalAllowance],
    ["Special Allowance", s.specialAllowance],
    ["Other Earnings", s.otherEarnings],
  ];
  const dedRows = (s: any) => [
    ["PF", s.pf],
    ["ESI", s.esi],
    ["Tax", s.tax],
    ["Other Deductions", s.otherDeductions],
  ];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      {(slips ?? []).length === 0 ? (
        <Card>
          <Empty icon="cash-outline" text="No salary slips yet" />
        </Card>
      ) : (
        slips!.map((s) => (
          <Pressable key={s.id} onPress={() => setSelected(s)}>
            <Card>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.month}>
                    {MONTHS[(s.month ?? 1) - 1]} {s.year}
                  </Text>
                  <Text style={styles.net}>{fmtMoney(s.netSalary)} net</Text>
                </View>
                <StatusPill status={s.status} />
              </View>
            </Card>
          </Pressable>
        ))
      )}

      <Modal visible={!!selected} animationType="slide" transparent onRequestClose={() => setSelected(null)}>
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <View style={styles.handle} />
            {selected && (
              <ScrollView>
                <Text style={styles.sheetTitle}>
                  {MONTHS[(selected.month ?? 1) - 1]} {selected.year}
                </Text>
                <Text style={styles.section}>Earnings</Text>
                {earnRows(selected).map(([label, val]) => (
                  <View key={String(label)} style={styles.lineRow}>
                    <Text style={styles.lineLabel}>{label}</Text>
                    <Text style={styles.lineVal}>{fmtMoney(val as number)}</Text>
                  </View>
                ))}
                <Text style={styles.section}>Deductions</Text>
                {dedRows(selected).map(([label, val]) => (
                  <View key={String(label)} style={styles.lineRow}>
                    <Text style={styles.lineLabel}>{label}</Text>
                    <Text style={[styles.lineVal, { color: colors.red }]}>−{fmtMoney(val as number).replace("₹", "₹")}</Text>
                  </View>
                ))}
                <View style={[styles.lineRow, styles.netRow]}>
                  <Text style={styles.netLabel}>Net Salary</Text>
                  <Text style={styles.netVal}>{fmtMoney(selected.netSalary)}</Text>
                </View>
                {selected.remarks ? <Text style={styles.remarks}>Note: {selected.remarks}</Text> : null}
              </ScrollView>
            )}
            <Button title="Close" onPress={() => setSelected(null)} variant="ghost" style={{ marginTop: spacing.md }} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  month: { fontSize: 15, fontWeight: "700", color: colors.ink },
  net: { fontSize: 13, color: colors.purple, marginTop: 2, fontWeight: "600" },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
    maxHeight: "80%",
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginBottom: 12 },
  sheetTitle: { fontSize: 18, fontWeight: "800", color: colors.ink, marginBottom: 8 },
  section: { fontSize: 13, fontWeight: "700", color: colors.sub, marginTop: 14, marginBottom: 4, textTransform: "uppercase" },
  lineRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  lineLabel: { fontSize: 14, color: colors.ink },
  lineVal: { fontSize: 14, fontWeight: "600", color: colors.ink },
  netRow: { borderBottomWidth: 0, marginTop: 8, backgroundColor: colors.yellowSoft, borderRadius: radius.sm, paddingHorizontal: 10 },
  netLabel: { fontSize: 15, fontWeight: "800", color: colors.ink },
  netVal: { fontSize: 16, fontWeight: "800", color: colors.ink },
  remarks: { fontSize: 12, color: colors.sub, marginTop: 10 },
});
