import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate, todayIST } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, StatusPill, Button, Field, ErrorBanner, SuccessBanner, Empty, Loading, useApi } from "@/components/ui";

export default function ExtraHoursScreen() {
  const [showForm, setShowForm] = useState(false);
  const [date, setDate] = useState(todayIST());
  const [hours, setHours] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(() => apiFetch("/hr/extra-hours"));

  const submit = async () => {
    setError(null);
    const h = parseFloat(hours);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !h || h <= 0) {
      setError("Enter a valid date (YYYY-MM-DD) and hours");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/hr/extra-hours", {
        method: "POST",
        body: JSON.stringify({ date, hours: h, description: description || undefined }),
      });
      setHours("");
      setDescription("");
      setShowForm(false);
      setSuccessMsg("Extra hours logged for approval");
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not log hours");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Loading />;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <SuccessBanner message={successMsg} />
      {!showForm && <Button title="+ Log Extra Hours" onPress={() => { setSuccessMsg(null); setShowForm(true); }} style={{ marginBottom: spacing.md }} />}

      {showForm && (
        <>
          <SectionTitle>Log Hours</SectionTitle>
          <Card>
            <ErrorBanner message={error} />
            <Field label="Date (YYYY-MM-DD)" value={date} onChangeText={setDate} placeholder={todayIST()} />
            <Field label="Hours" value={hours} onChangeText={setHours} keyboardType="decimal-pad" placeholder="e.g. 2.5" />
            <Field label="What did you work on?" value={description} onChangeText={setDescription} multiline autoCapitalize="sentences" />
            <Button title="Submit" onPress={submit} loading={submitting} />
            <Button title="Cancel" onPress={() => setShowForm(false)} variant="ghost" style={{ marginTop: spacing.sm }} />
          </Card>
        </>
      )}

      <SectionTitle>My Logged Hours</SectionTitle>
      <Card>
        {(data ?? []).length === 0 ? (
          <Empty icon="hourglass-outline" text="No extra hours logged yet" />
        ) : (
          data!.map((e: any, i: number) => (
            <View key={e.id} style={[styles.row, i === data!.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.title}>
                  {e.hours}h · {fmtDate(e.date)}
                </Text>
                {e.description ? (
                  <Text style={styles.sub} numberOfLines={2}>
                    {e.description}
                  </Text>
                ) : null}
              </View>
              <StatusPill status={e.status} />
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 14, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 2 },
});
