import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiFetch, errorMessage, fmtDate } from "@/lib/api";
import { colors, formatStatus, radius, spacing, type } from "@/lib/theme";
import { Button, Card, Chips, ErrorBanner, Field, Screen, SectionTitle, StatusPill, useApi } from "@/components/ui";
import { AsyncList } from "@/components/async";
import { toast } from "@/components/feedback";
import { haptic } from "@/lib/device";

const CATEGORIES = ["GENERAL", "WORKPLACE", "HARASSMENT", "PAYROLL", "OTHER"] as const;
type Category = (typeof CATEGORIES)[number];

const CATEGORY_LABELS: Record<Category, string> = {
  GENERAL: "General",
  WORKPLACE: "Workplace",
  HARASSMENT: "Harassment",
  PAYROLL: "Payroll",
  OTHER: "Other",
};

type Complaint = {
  id: string;
  subject: string;
  description: string;
  category: string;
  status: string;
  adminResponse: string | null;
  createdAt: string;
};

type FormErrors = { subject?: string; description?: string };

function ComplaintRow({ complaint, last }: { complaint: Complaint; last: boolean }) {
  return (
    <View style={[styles.row, last ? null : styles.rowDivider]}>
      <View style={styles.rowHead}>
        <Text maxFontSizeMultiplier={1.6} style={styles.subject} numberOfLines={2}>
          {complaint.subject}
        </Text>
        <StatusPill status={complaint.status} size="sm" />
      </View>
      <Text maxFontSizeMultiplier={1.6} style={styles.desc} numberOfLines={3}>
        {complaint.description}
      </Text>
      <Text maxFontSizeMultiplier={1.6} style={styles.meta}>
        {formatStatus(complaint.category)} · {fmtDate(complaint.createdAt)}
      </Text>
      {complaint.adminResponse ? (
        <View style={styles.response}>
          <Text maxFontSizeMultiplier={1.6} style={styles.responseLabel}>
            HR response
          </Text>
          <Text maxFontSizeMultiplier={1.6} style={styles.responseText}>
            {complaint.adminResponse}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export default function ComplaintsScreen() {
  const [showForm, setShowForm] = useState(false);
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<Category>("GENERAL");
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const state = useApi<Complaint[]>(() => apiFetch<Complaint[]>("/hr/complaints"));

  const closeForm = () => {
    setShowForm(false);
    setFieldErrors({});
    setSubmitError(null);
  };

  const submit = async () => {
    const next: FormErrors = {};
    if (!subject.trim()) next.subject = "Add a short subject";
    if (!description.trim()) next.description = "Describe the issue";
    setFieldErrors(next);
    setSubmitError(null);
    if (next.subject || next.description) return;

    setSubmitting(true);
    try {
      await apiFetch("/hr/complaints", {
        method: "POST",
        body: JSON.stringify({ subject: subject.trim(), description: description.trim(), category }),
      });
      setSubject("");
      setDescription("");
      setCategory("GENERAL");
      closeForm();
      toast.show({ message: "Complaint submitted — HR has been notified", tone: "success" });
      void haptic("success");
      void state.reload();
    } catch (e) {
      setSubmitError(errorMessage(e, "Could not submit your complaint. Please try again."));
      void haptic("error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      {showForm ? (
        <>
          <SectionTitle>New complaint</SectionTitle>
          <Card>
            <Field
              label="Subject"
              value={subject}
              onChangeText={(t) => {
                setSubject(t);
                if (fieldErrors.subject) setFieldErrors((f) => ({ ...f, subject: undefined }));
              }}
              autoCapitalize="sentences"
              placeholder="Brief summary"
              error={fieldErrors.subject}
              required
            />
            <Text maxFontSizeMultiplier={1.6} style={styles.label}>
              Category
            </Text>
            <Chips
              options={CATEGORIES}
              value={category}
              onChange={setCategory}
              labels={CATEGORY_LABELS}
              accessibilityLabel="Complaint category"
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
              placeholder="Describe the issue in detail"
              error={fieldErrors.description}
              required
            />
            <ErrorBanner message={submitError} />
            <Button title="Submit complaint" onPress={submit} loading={submitting} />
            <Button
              title="Cancel"
              onPress={closeForm}
              variant="ghost"
              disabled={submitting}
              style={styles.cancel}
            />
          </Card>
        </>
      ) : (
        <Button
          title="Raise a complaint"
          icon="add-circle-outline"
          onPress={() => setShowForm(true)}
          style={styles.raise}
        />
      )}

      <SectionTitle>My complaints</SectionTitle>
      <AsyncList
        state={state}
        grouped
        keyExtractor={(c) => c.id}
        renderItem={(c, i, all) => <ComplaintRow complaint={c} last={i === all.length - 1} />}
        empty={{
          icon: "megaphone-outline",
          title: "No complaints raised",
          text: "Anything you raise with HR will be tracked here.",
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  raise: { marginBottom: spacing.md },
  cancel: { marginTop: spacing.sm },
  label: { ...type.footnote, fontWeight: "600", color: colors.ink, marginBottom: spacing.sm },
  row: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  subject: { ...type.subhead, fontWeight: "600", color: colors.ink, flex: 1, minWidth: 0 },
  desc: { ...type.footnote, color: colors.sub, marginTop: spacing.xs },
  meta: { ...type.caption, color: colors.sub, marginTop: spacing.xs },
  response: {
    backgroundColor: colors.purpleSoft,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  responseLabel: { ...type.caption2, fontWeight: "700", color: colors.purpleText, textTransform: "uppercase" },
  responseText: { ...type.footnote, color: colors.ink, marginTop: 2 },
});
