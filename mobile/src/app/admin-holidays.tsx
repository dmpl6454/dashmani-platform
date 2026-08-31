import React, { useState } from "react";
import { View, Text, StyleSheet, Alert, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, fmtDate, todayIST } from "@/lib/api";
import { colors, radius, spacing, formatStatus } from "@/lib/theme";
import { Screen, Card, SectionTitle, Button, Field, Chips, Empty, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

const TYPES = ["PUBLIC", "RESTRICTED", "COMPANY"] as const;

export default function AdminHolidays() {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState(todayIST());
  const [type, setType] = useState<(typeof TYPES)[number]>("PUBLIC");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(() => apiFetch("/admin/holidays"));

  const add = async () => {
    setError(null);
    if (!name.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("Enter a name and a valid date (YYYY-MM-DD)");
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/admin/holidays", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), date, type }),
      });
      setName("");
      setShowForm(false);
      setSuccessMsg("Holiday added");
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not add holiday");
    } finally {
      setSaving(false);
    }
  };

  const remove = (h: any) => {
    Alert.alert("Delete holiday?", `Remove "${h.name}" (${fmtDate(h.date)})?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await apiFetch(`/admin/holidays/${h.id}`, { method: "DELETE" });
            setSuccessMsg("Holiday removed");
            reload();
          } catch (e: any) {
            setError(e?.message || "Could not delete");
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
      {!showForm && <Button title="+ Add Holiday" onPress={() => { setSuccessMsg(null); setShowForm(true); }} style={{ marginBottom: spacing.md }} />}

      {showForm && (
        <>
          <SectionTitle>New Holiday</SectionTitle>
          <Card>
            <Field label="Name" value={name} onChangeText={setName} autoCapitalize="words" placeholder="e.g. Diwali" />
            <Field label="Date (YYYY-MM-DD)" value={date} onChangeText={setDate} />
            <Text style={styles.label}>Type</Text>
            <Chips options={TYPES} value={type} onChange={setType} />
            <Button title="Add" onPress={add} loading={saving} />
            <Button title="Cancel" onPress={() => setShowForm(false)} variant="ghost" style={{ marginTop: spacing.sm }} />
          </Card>
        </>
      )}

      <SectionTitle>Holidays ({items.length})</SectionTitle>
      <Card>
        {items.length === 0 ? (
          <Empty icon="sunny-outline" text="No holidays configured" />
        ) : (
          items.map((h: any, i: number) => (
            <View key={h.id} style={[styles.row, i === items.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={styles.dateBox}>
                <Text style={styles.day}>{new Date(h.date).getDate()}</Text>
                <Text style={styles.mon}>{new Date(h.date).toLocaleDateString("en-IN", { month: "short" })}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>{h.name}</Text>
                <Text style={styles.sub}>
                  {fmtDate(h.date)} · {formatStatus(h.type ?? "")}
                </Text>
              </View>
              <Pressable onPress={() => remove(h)} hitSlop={8}>
                <Ionicons name="trash-outline" size={18} color={colors.red} />
              </Pressable>
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: "600", color: colors.ink, marginBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dateBox: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.yellowSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  day: { fontSize: 16, fontWeight: "700", color: colors.ink },
  mon: { fontSize: 10, color: colors.sub },
  name: { fontSize: 14, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 1 },
});
