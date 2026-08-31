import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, Button, Field, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

export default function JoiningDateScreen() {
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any>(() => apiFetch("/hr/joining-date"));

  useEffect(() => {
    if (data?.joiningDate) setDate(String(data.joiningDate).slice(0, 10));
  }, [data?.joiningDate]);

  const save = async () => {
    setError(null);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Date must be YYYY-MM-DD");
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/hr/joining-date", { method: "POST", body: JSON.stringify({ joiningDate: date }) });
      setSuccessMsg("Joining date submitted for admin approval");
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not save");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading />;

  const approved = data?.joiningDateApproved;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <ErrorBanner message={error} />
      <SuccessBanner message={successMsg} />
      <Card style={{ backgroundColor: approved ? colors.greenSoft : colors.amberSoft, borderColor: "transparent" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Ionicons name={approved ? "checkmark-circle" : "time-outline"} size={24} color={approved ? colors.green : colors.amber} />
          <Text style={styles.statusText}>
            {data?.joiningDate
              ? `${fmtDate(data.joiningDate)} · ${approved ? "Approved" : "Awaiting approval"}`
              : "No joining date on record — set it below"}
          </Text>
        </View>
      </Card>
      <Card>
        <Field label="Joining date (YYYY-MM-DD)" value={date} onChangeText={setDate} placeholder="2025-01-15" />
        <Button title="Submit for Approval" onPress={save} loading={saving} disabled={approved} />
        {approved ? <Text style={styles.note}>Your joining date is approved and locked. Contact HR to change it.</Text> : null}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusText: { fontSize: 14, fontWeight: "600", color: colors.ink, flex: 1 },
  note: { fontSize: 11, color: colors.faint, textAlign: "center", marginTop: spacing.sm },
});
