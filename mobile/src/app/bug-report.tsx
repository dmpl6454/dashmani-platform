import React, { useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { apiFetch, fmtDate } from "@/lib/api";
import { colors, spacing } from "@/lib/theme";
import { Screen, Card, SectionTitle, StatusPill, Button, Field, Chips, ErrorBanner, SuccessBanner, Empty, Loading, useApi } from "@/components/ui";

const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

export default function BugReportScreen() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>("MEDIUM");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const { data, loading, refreshing, refresh, reload } = useApi<any[]>(() => apiFetch("/hr/bug-reports"));

  const submit = async () => {
    setError(null);
    if (!title.trim() || !description.trim()) {
      setError("Title and description are required");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/hr/bug-reports", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), description: description.trim(), severity, page: "mobile-app" }),
      });
      setTitle("");
      setDescription("");
      setSuccessMsg("Bug report submitted — thank you!");
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
      <SectionTitle>Report a Bug</SectionTitle>
      <Card>
        <ErrorBanner message={error} />
        <Field label="Title" value={title} onChangeText={setTitle} autoCapitalize="sentences" placeholder="What went wrong?" />
        <Text style={styles.label}>Severity</Text>
        <Chips options={SEVERITIES} value={severity} onChange={setSeverity} />
        <Field
          label="Description"
          value={description}
          onChangeText={setDescription}
          multiline
          autoCapitalize="sentences"
          placeholder="Steps to reproduce, what you expected, what happened…"
        />
        <Button title="Submit Bug Report" onPress={submit} loading={submitting} />
      </Card>

      <SectionTitle>My Reports</SectionTitle>
      <Card>
        {(data ?? []).length === 0 ? (
          <Empty icon="bug-outline" text="No bug reports yet" />
        ) : (
          data!.map((b: any, i: number) => (
            <View key={b.id} style={[styles.row, i === data!.length - 1 && { borderBottomWidth: 0 }]}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.title} numberOfLines={1}>
                  {b.title}
                </Text>
                <Text style={styles.sub}>
                  {b.severity} · {fmtDate(b.createdAt)}
                </Text>
              </View>
              <StatusPill status={b.status} />
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
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 14, fontWeight: "700", color: colors.ink },
  sub: { fontSize: 12, color: colors.sub, marginTop: 2 },
});
