import React, { useState } from "react";
import { View, Text, StyleSheet, Modal } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, StatusPill, Button, Field, Empty, Loading, ErrorBanner, SuccessBanner, useApi } from "@/components/ui";

export default function AdminComplaints() {
  const [respondTo, setRespondTo] = useState<any | null>(null);
  const [response, setResponse] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(() => apiFetch("/admin/complaints"));

  const submit = async () => {
    if (!respondTo || !response.trim()) {
      setError("Write a response first");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/admin/complaints/${respondTo.id}/respond`, {
        method: "POST",
        body: JSON.stringify({ response: response.trim(), status: "RESOLVED" }),
      });
      setRespondTo(null);
      setResponse("");
      setSuccessMsg("Response sent — complaint resolved");
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not respond");
    } finally {
      setSaving(false);
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
          <Empty icon="megaphone-outline" text="No complaints" />
        </Card>
      ) : (
        items.map((c: any) => (
          <Card key={c.id}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={[styles.subject, { flex: 1 }]} numberOfLines={1}>
                {c.subject}
              </Text>
              <StatusPill status={c.status} />
            </View>
            <Text style={styles.meta}>
              {c.employee?.name ?? "Employee"} · {c.category} · {fmtDate(c.createdAt)}
            </Text>
            <Text style={styles.desc}>{c.description}</Text>
            {c.adminResponse ? (
              <View style={styles.responseBox}>
                <Text style={styles.responseLabel}>Response</Text>
                <Text style={styles.responseText}>{c.adminResponse}</Text>
              </View>
            ) : (
              <Button
                title="Respond & Resolve"
                small
                onPress={() => {
                  setSuccessMsg(null);
                  setRespondTo(c);
                }}
                style={{ marginTop: spacing.md }}
              />
            )}
          </Card>
        ))
      )}

      <Modal visible={!!respondTo} animationType="slide" transparent onRequestClose={() => setRespondTo(null)}>
        <View style={styles.scrim}>
          <View style={styles.sheet}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>Respond to Complaint</Text>
            <Text style={styles.sheetSub} numberOfLines={2}>
              {respondTo?.subject}
            </Text>
            <ErrorBanner message={error} />
            <Field
              value={response}
              onChangeText={setResponse}
              multiline
              autoCapitalize="sentences"
              placeholder="Your response to the employee…"
            />
            <Button title="Send & Resolve" onPress={submit} loading={saving} />
            <Button title="Cancel" onPress={() => setRespondTo(null)} variant="ghost" style={{ marginTop: spacing.sm }} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subject: { fontSize: 15, fontWeight: "700", color: colors.ink },
  meta: { fontSize: 12, color: colors.faint, marginTop: 4 },
  desc: { fontSize: 13, color: colors.ink, marginTop: 8, lineHeight: 19 },
  responseBox: { backgroundColor: colors.greenSoft, borderRadius: radius.sm, padding: 10, marginTop: 10 },
  responseLabel: { fontSize: 10, fontWeight: "700", color: colors.green, textTransform: "uppercase" },
  responseText: { fontSize: 13, color: colors.ink, marginTop: 2 },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.cardHigh,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: "center", marginBottom: 12 },
  sheetTitle: { fontSize: 18, fontWeight: "800", color: colors.ink },
  sheetSub: { fontSize: 13, color: colors.sub, marginVertical: 8 },
});
