import React, { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch, describeError, fieldErrorMap, fmtDay, isISODate, istDateOf } from "@/lib/api";
import { colors, spacing, toneColors, type, type Tone } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Button, Card, ErrorBanner, Screen, useApi, type IoniconName } from "@/components/ui";
import { Sheet } from "@/components/sheet";
import { AsyncBlock } from "@/components/async";
import { SkeletonCard } from "@/components/skeleton";
import { DateField } from "@/components/date-field";
import { toast } from "@/components/feedback";

type JoiningDate = { joiningDate: string | null; joiningDateApproved: boolean };

function currentOf(d: JoiningDate | null): string | null {
  return d?.joiningDate ? istDateOf(d.joiningDate) : null;
}

function StatusCard({ data, onEdit }: { data: JoiningDate; onEdit: () => void }) {
  const current = currentOf(data);
  const approved = !!data.joiningDateApproved && !!current;
  const tone: Tone = approved ? "success" : current ? "warning" : "neutral";
  const icon: IoniconName = approved ? "checkmark-circle" : current ? "time-outline" : "calendar-outline";
  const tc = toneColors(tone);
  const status = approved ? "Approved" : current ? "Awaiting admin approval" : "No joining date on record yet";

  return (
    <>
      <Card variant="tinted" tone={tone}>
        <View style={styles.row}>
          <Ionicons name={icon} size={28} color={tc.fg} />
          <View style={styles.flex}>
            <Text style={styles.label} maxFontSizeMultiplier={1.6}>
              Joining date
            </Text>
            <Text style={styles.value} maxFontSizeMultiplier={1.6}>
              {current ? fmtDay(current, { year: true }) : "Not set"}
            </Text>
            <Text style={[styles.status, { color: tc.text }]} maxFontSizeMultiplier={1.6}>
              {status}
            </Text>
          </View>
        </View>
      </Card>
      {approved ? (
        <Text style={styles.note} maxFontSizeMultiplier={1.6}>
          Your joining date is approved and locked. Contact HR to change it.
        </Text>
      ) : (
        <Button
          title={current ? "Change joining date" : "Set joining date"}
          icon="calendar-outline"
          onPress={onEdit}
        />
      )}
    </>
  );
}

export default function JoiningDateScreen() {
  const state = useApi<JoiningDate>(() => apiFetch<JoiningDate>("/hr/joining-date"));

  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [dateError, setDateError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const openForm = () => {
    setDate(currentOf(state.data) ?? "");
    setDateError(null);
    setSubmitError(null);
    setOpen(true);
  };

  const save = async () => {
    setSubmitError(null);
    if (!isISODate(date)) {
      setDateError("Pick your joining date");
      void haptic("error");
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/hr/joining-date", { method: "POST", body: JSON.stringify({ joiningDate: date }) });
      setOpen(false);
      void haptic("success");
      toast.show({ message: "Joining date submitted for admin approval", tone: "success" });
      void state.reload();
    } catch (e) {
      const fe = fieldErrorMap(e);
      if (fe.joiningDate) setDateError(fe.joiningDate);
      setSubmitError(describeError(e, "Could not save"));
      void haptic("error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncBlock state={state} skeleton={<SkeletonCard lines={3} />}>
        {(d) => <StatusCard data={d} onEdit={openForm} />}
      </AsyncBlock>

      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title="Joining date"
        subtitle="An admin approves it before it is locked"
        dismissable={!saving}
        footer={<Button title="Submit for approval" onPress={save} loading={saving} />}
      >
        <ErrorBanner message={submitError} onDismiss={() => setSubmitError(null)} />
        <DateField
          label="Joining date"
          value={date}
          onChange={(v) => {
            setDate(v);
            setDateError(null);
          }}
          error={dateError}
          required
        />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  flex: { flex: 1, minWidth: 0 },
  label: { ...type.footnote, color: colors.sub },
  value: { ...type.title3, color: colors.ink, marginTop: 2 },
  status: { ...type.subhead, fontWeight: "600", marginTop: 2 },
  note: { ...type.footnote, color: colors.sub, textAlign: "center", marginTop: spacing.xs },
});
