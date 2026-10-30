import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { apiFetch, errorMessage, fmtDate } from "@/lib/api";
import { colors, formatStatus, radius, spacing, toneColors, type } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Button, Card, ErrorBanner, Field, Screen, StatusPill, useApi } from "@/components/ui";
import { AsyncList } from "@/components/async";
import { Sheet } from "@/components/sheet";
import { toast } from "@/components/feedback";

type Complaint = {
  id: string;
  subject: string;
  description?: string | null;
  category?: string | null;
  status: string;
  createdAt: string;
  adminResponse?: string | null;
  employee?: { name?: string | null } | null;
};

const success = toneColors("success");

function metaLine(c: Complaint): string {
  return [c.employee?.name ?? "Employee", c.category ? formatStatus(c.category) : null, fmtDate(c.createdAt)]
    .filter((s): s is string => !!s)
    .join(" · ");
}

export default function AdminComplaints() {
  const state = useApi<Complaint[]>(() => apiFetch<Complaint[]>("/admin/complaints"));

  const [respondTo, setRespondTo] = useState<Complaint | null>(null);
  const [response, setResponse] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const openRespond = (c: Complaint) => {
    setInputError(null);
    setSubmitError(null);
    setRespondTo(c);
  };

  const closeRespond = () => {
    if (!saving) setRespondTo(null);
  };

  const submit = async () => {
    if (!respondTo) return;
    const text = response.trim();
    if (!text) {
      setInputError("Write a response first");
      return;
    }
    setSaving(true);
    setInputError(null);
    setSubmitError(null);
    try {
      await apiFetch(`/admin/complaints/${respondTo.id}/respond`, {
        method: "POST",
        body: JSON.stringify({ response: text, status: "RESOLVED" }),
      });
      setRespondTo(null);
      setResponse("");
      void haptic("success");
      toast.show({ message: "Response sent — complaint resolved", tone: "success" });
      await state.reload();
    } catch (e) {
      void haptic("error");
      setSubmitError(errorMessage(e, "Could not send the response"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        skeleton="cards"
        keyExtractor={(c) => c.id}
        empty={{
          icon: "megaphone-outline",
          title: "No complaints",
          text: "Complaints employees raise from the app appear here.",
          tone: "success",
        }}
        renderItem={(c) => (
          <Card>
            <View style={styles.head}>
              <Text style={styles.subject} numberOfLines={2} maxFontSizeMultiplier={1.6}>
                {c.subject}
              </Text>
              <StatusPill status={c.status} size="sm" />
            </View>
            <Text style={styles.meta} maxFontSizeMultiplier={1.6}>
              {metaLine(c)}
            </Text>
            {c.description ? (
              <Text style={styles.desc} maxFontSizeMultiplier={1.6}>
                {c.description}
              </Text>
            ) : null}
            {c.adminResponse ? (
              <View style={styles.responseBox}>
                <Text style={styles.responseLabel} maxFontSizeMultiplier={1.3}>
                  Response
                </Text>
                <Text style={styles.responseText} maxFontSizeMultiplier={1.6}>
                  {c.adminResponse}
                </Text>
              </View>
            ) : (
              <Button
                title="Respond & resolve"
                icon="chatbubble-ellipses-outline"
                variant="tinted"
                size="md"
                fullWidth={false}
                onPress={() => openRespond(c)}
                style={styles.action}
              />
            )}
          </Card>
        )}
      />

      <Sheet
        visible={!!respondTo}
        onClose={closeRespond}
        title="Respond to complaint"
        subtitle={respondTo?.subject}
        dismissable={!saving}
        footer={<Button title="Send & resolve" onPress={submit} loading={saving} />}
      >
        {respondTo?.description ? (
          <Text style={styles.sheetDesc} numberOfLines={4} maxFontSizeMultiplier={1.6}>
            {respondTo.description}
          </Text>
        ) : null}
        <Field
          label="Response"
          value={response}
          onChangeText={(t) => {
            setResponse(t);
            if (inputError) setInputError(null);
          }}
          multiline
          autoCapitalize="sentences"
          autoCorrect
          placeholder="Your response to the employee…"
          error={inputError}
          hint="The employee is emailed your response and the complaint is marked resolved."
        />
        <ErrorBanner message={submitError} onDismiss={() => setSubmitError(null)} style={styles.sheetError} />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  subject: { ...type.headline, color: colors.ink, flex: 1 },
  meta: { ...type.footnote, color: colors.sub, marginTop: spacing.xs },
  desc: { ...type.subhead, color: colors.ink, marginTop: spacing.sm, lineHeight: 21 },
  responseBox: { backgroundColor: success.bg, borderRadius: radius.control, padding: spacing.md, marginTop: spacing.md },
  responseLabel: { ...type.caption, fontWeight: "600", color: success.text },
  responseText: { ...type.subhead, color: colors.ink, marginTop: 2 },
  action: { marginTop: spacing.md },
  sheetDesc: { ...type.subhead, color: colors.sub, marginBottom: spacing.md },
  sheetError: { marginTop: spacing.md },
});
