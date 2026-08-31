import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, StatusPill, Button, Field, Chips, ErrorBanner, SuccessBanner, Empty, Loading, useApi } from "@/components/ui";

const CATEGORIES = ["GENERAL", "WORKPLACE", "HARASSMENT", "PAYROLL", "OTHER"] as const;

export default function ComplaintsScreen() {
  const [showForm, setShowForm] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]>("GENERAL");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(() => apiFetch("/hr/complaints"));

  const submit = async () => {
    setError(null);
    if (!subject.trim() || !description.trim()) {
      setError("Subject and description are required");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/hr/complaints", {
        method: "POST",
        body: JSON.stringify({ subject: subject.trim(), description: description.trim(), category }),
      });
      setSubject("");
      setDescription("");
      setShowForm(false);
      setSuccessMsg("Complaint submitted — HR has been notified");
      reload();
    } catch (e: any) {
      setError(e?.message || "Could not submit");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Loading />;

  return (
    <Screen onRefresh={refresh} refreshing={refreshing}>
      <SuccessBanner message={successMsg} />
      {!showForm && <Button title="+ Raise a Complaint" onPress={() => { setSuccessMsg(null); setShowForm(true); }} style={{ marginBottom: spacing.md }} />}

      {showForm && (
        <>
          <SectionTitle>New Complaint</SectionTitle>
          <Card>
            <ErrorBanner message={error} />
            <Field label="Subject" value={subject} onChangeText={setSubject} autoCapitalize="sentences" placeholder="Brief summary" />
            <Text style={styles.label}>Category</Text>
            <Chips options={CATEGORIES} value={category} onChange={setCategory} />
            <Field label="Description" value={description} onChangeText={setDescription} multiline autoCapitalize="sentences" placeholder="Describe the issue in detail" />
            <Button title="Submit" onPress={submit} loading={submitting} />
            <Button title="Cancel" onPress={() => setShowForm(false)} variant="ghost" style={{ marginTop: spacing.sm }} />
          </Card>
        </>
      )}

      <SectionTitle>My Complaints</SectionTitle>
      <Card>
        {(data ?? []).length === 0 ? (
          <Empty icon="megaphone-outline" text="No complaints raised" />
        ) : (
          data!.map((c: any, i: number) => (
            <View key={c.id} style={[styles.row, i === data!.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={[styles.subject, { flex: 1 }]} numberOfLines={1}>
                  {c.subject}
                </Text>
                <StatusPill status={c.status} />
              </View>
              <Text style={styles.desc} numberOfLines={2}>
                {c.description}
              </Text>
              <Text style={styles.meta}>
                {c.category} · {fmtDate(c.createdAt)}
              </Text>
              {c.adminResponse ? (
                <View style={styles.response}>
                  <Text style={styles.responseLabel}>HR Response</Text>
                  <Text style={styles.responseText}>{c.adminResponse}</Text>
                </View>
              ) : null}
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
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  subject: { fontSize: 14, fontWeight: "700", color: colors.ink },
  desc: { fontSize: 13, color: colors.sub, marginTop: 4 },
  meta: { fontSize: 11, color: colors.faint, marginTop: 4 },
  response: {
    backgroundColor: colors.purpleSoft,
    borderRadius: radius.sm,
    padding: 10,
    marginTop: 8,
  },
  responseLabel: { fontSize: 10, fontWeight: "700", color: colors.purpleDark, textTransform: "uppercase" },
  responseText: { fontSize: 13, color: colors.ink, marginTop: 2 },
});
