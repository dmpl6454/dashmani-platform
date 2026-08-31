import React, { useState } from "react";
import { View, Text, StyleSheet, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, fmtDate, fmtMoney } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, Button, Empty, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

export default function ContractScreen() {
  const [agreeing, setAgreeing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data: contract, loading, refreshing, refresh, reload } = useApi<any>(() => apiFetch("/hr/contract"));

  const agree = () => {
    Alert.alert("Agree to contract?", "This records your digital acceptance of the employment contract.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "I Agree",
        onPress: async () => {
          setAgreeing(true);
          setError(null);
          try {
            await apiFetch(`/hr/contract/${contract.id}/agree`, { method: "POST" });
            setSuccessMsg("Contract accepted — a copy is available on the web portal");
            reload();
          } catch (e: any) {
            setError(e?.message || "Could not record agreement");
          } finally {
            setAgreeing(false);
          }
        },
      },
    ]);
  };

  if (loading) return <Loading />;

  if (!contract) {
    return (
      <Screen onRefresh={refresh} refreshing={refreshing}>
        <Card>
          <Empty icon="document-lock-outline" text="No employment contract issued yet" />
        </Card>
      </Screen>
    );
  }

  const rows: Array<[string, string]> = [
    ["Contract date", fmtDate(contract.contractDate)],
    ["Designation", contract.designation ?? "—"],
    ["Department", contract.department ?? "—"],
    ["Salary", fmtMoney(contract.salary)],
    ["Probation", `${contract.probationMonths ?? "—"} month(s)`],
    ["Notice period", `${contract.noticePeriod ?? "—"} day(s)`],
  ];

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <SuccessBanner message={successMsg} />
      <Card style={{ backgroundColor: contract.agreedAt ? colors.greenSoft : colors.amberSoft, borderColor: "transparent" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Ionicons name={contract.agreedAt ? "checkmark-circle" : "alert-circle"} size={24} color={contract.agreedAt ? colors.green : colors.amber} />
          <Text style={styles.statusText}>
            {contract.agreedAt ? `Signed on ${fmtDate(contract.agreedAt)}` : "Awaiting your agreement"}
          </Text>
        </View>
      </Card>
      <Card>
        {rows.map(([label, value], i) => (
          <View key={label} style={[styles.infoRow, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
            <Text style={styles.infoLabel}>{label}</Text>
            <Text style={styles.infoValue}>{value}</Text>
          </View>
        ))}
      </Card>
      {!contract.agreedAt && <Button title="I Agree to This Contract" onPress={agree} loading={agreeing} />}
      <Text style={styles.hint}>Read the full contract text on the web portal before agreeing.</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusText: { fontSize: 14, fontWeight: "600", color: colors.ink, flex: 1 },
  infoRow: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  infoLabel: { fontSize: 13, color: colors.sub },
  infoValue: { fontSize: 13, fontWeight: "600", color: colors.ink },
  hint: { fontSize: 11, color: colors.faint, textAlign: "center", marginTop: spacing.sm },
});
