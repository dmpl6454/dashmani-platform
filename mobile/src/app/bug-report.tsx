import React, { useState } from "react";
import { StyleSheet, Text } from "react-native";
import { apiFetch, errorMessage, fmtDate } from "@/lib/api";
import { colors, formatStatus, spacing, type } from "@/lib/theme";
import type { TintKey } from "@/lib/theme";
import { Button, Card, Chips, ErrorBanner, Field, Screen, SectionTitle, StatusPill, useApi } from "@/components/ui";
import { AsyncList } from "@/components/async";
import { ListItem } from "@/components/list";
import { toast } from "@/components/feedback";
import { haptic } from "@/lib/device";

const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
type Severity = (typeof SEVERITIES)[number];

const SEVERITY_LABELS: Record<Severity, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  CRITICAL: "Critical",
};

type BugReport = {
  id: string;
  title: string;
  severity: string;
  status: string;
  resolution: string | null;
  createdAt: string;
};

type FormErrors = { title?: string; description?: string };

function severityTint(severity: string): TintKey {
  if (severity === "CRITICAL" || severity === "HIGH") return "red";
  if (severity === "MEDIUM") return "orange";
  return "gray";
}

function subtitleOf(b: BugReport): string {
  const base = `${formatStatus(b.severity)} · ${fmtDate(b.createdAt)}`;
  return b.resolution ? `${base}\n${b.resolution}` : base;
}

export default function BugReportScreen() {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("MEDIUM");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const state = useApi<BugReport[]>(() => apiFetch<BugReport[]>("/hr/bug-reports"));

  const submit = async () => {
    const next: FormErrors = {};
    if (!title.trim()) next.title = "Add a short title";
    if (!description.trim()) next.description = "Describe what happened";
    setFieldErrors(next);
    setSubmitError(null);
    if (next.title || next.description) return;

    setSubmitting(true);
    try {
      await apiFetch("/hr/bug-reports", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), description: description.trim(), severity, page: "mobile-app" }),
      });
      setTitle("");
      setDescription("");
      setSeverity("MEDIUM");
      toast.show({ message: "Bug report submitted — thank you!", tone: "success" });
      void haptic("success");
      void state.reload();
    } catch (e) {
      setSubmitError(errorMessage(e, "Could not submit your bug report. Please try again."));
      void haptic("error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <SectionTitle>Report a bug</SectionTitle>
      <Card>
        <Field
          label="Title"
          value={title}
          onChangeText={(t) => {
            setTitle(t);
            if (fieldErrors.title) setFieldErrors((f) => ({ ...f, title: undefined }));
          }}
          autoCapitalize="sentences"
          placeholder="What went wrong?"
          error={fieldErrors.title}
          required
        />
        <Text maxFontSizeMultiplier={1.6} style={styles.label}>
          Severity
        </Text>
        <Chips
          options={SEVERITIES}
          value={severity}
          onChange={setSeverity}
          labels={SEVERITY_LABELS}
          accessibilityLabel="Bug severity"
        />
        <Field
          label="Description"
          value={description}
          onChangeText={(t) => {
            setDescription(t);
            if (fieldErrors.description) setFieldErrors((f) => ({ ...f, description: undefined }));
          }}
          multiline
          autoCapitalize="sentences"
          placeholder="Steps to reproduce, what you expected, what happened…"
          error={fieldErrors.description}
          required
        />
        <ErrorBanner message={submitError} />
        <Button title="Submit bug report" icon="bug-outline" onPress={submit} loading={submitting} />
      </Card>

      <SectionTitle>My reports</SectionTitle>
      <AsyncList
        state={state}
        grouped
        keyExtractor={(b) => b.id}
        renderItem={(b) => (
          <ListItem
            title={b.title}
            subtitle={subtitleOf(b)}
            icon="bug-outline"
            tint={severityTint(b.severity)}
            trailing={<StatusPill status={b.status} size="sm" />}
          />
        )}
        empty={{
          icon: "bug-outline",
          title: "No bug reports yet",
          text: "Bugs you report will appear here with their status.",
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { ...type.footnote, fontWeight: "600", color: colors.ink, marginBottom: spacing.sm },
});
