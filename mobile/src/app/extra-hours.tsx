import React, { useState } from "react";
import { addDaysISO, apiFetch, describeError, fieldErrorMap, fmtDay, isISODate, istDateOf, todayIST } from "@/lib/api";
import { haptic } from "@/lib/device";
import { Button, ErrorBanner, Field, Screen, SectionTitle, StatusPill, useApi } from "@/components/ui";
import { DateTile, ListItem } from "@/components/list";
import { Sheet } from "@/components/sheet";
import { AsyncList } from "@/components/async";
import { DateField } from "@/components/date-field";
import { toast } from "@/components/feedback";

type ExtraHour = {
  id: string;
  date: string;
  hours: number;
  description?: string | null;
  status: string;
};

type FormErrors = { date?: string; hours?: string };

function dayOf(v: string): string {
  return istDateOf(v) ?? String(v).slice(0, 10);
}

export default function ExtraHoursScreen() {
  const state = useApi<ExtraHour[]>(() => apiFetch<ExtraHour[]>("/hr/extra-hours"));

  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayIST());
  const [hours, setHours] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const today = todayIST();

  const openForm = () => {
    setErrors({});
    setSubmitError(null);
    setOpen(true);
  };

  const submit = async () => {
    const next: FormErrors = {};
    if (!isISODate(date)) next.date = "Pick the day you worked";
    const h = parseFloat(hours.replace(",", "."));
    if (!Number.isFinite(h) || h <= 0) next.hours = "Enter the hours you worked, e.g. 2.5";
    else if (h > 24) next.hours = "A day has at most 24 hours";
    setErrors(next);
    setSubmitError(null);
    if (next.date || next.hours) {
      void haptic("error");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/hr/extra-hours", {
        method: "POST",
        body: JSON.stringify({ date, hours: h, description: description.trim() || undefined }),
      });
      setHours("");
      setDescription("");
      setOpen(false);
      void haptic("success");
      toast.show({ message: "Extra hours logged for approval", tone: "success" });
      void state.reload();
    } catch (e) {
      const fe = fieldErrorMap(e);
      setErrors({ date: fe.date, hours: fe.hours });
      setSubmitError(describeError(e, "Could not log hours"));
      void haptic("error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen
      onRefresh={state.refresh}
      refreshing={state.refreshing}
      footer={<Button title="Log extra hours" icon="add" onPress={openForm} />}
      footerInset
    >
      <AsyncList
        state={state}
        grouped
        skeleton="rows"
        header={<SectionTitle>My logged hours</SectionTitle>}
        keyExtractor={(e) => e.id}
        empty={{
          icon: "hourglass-outline",
          title: "No extra hours yet",
          text: "Hours you log go to your manager for approval.",
        }}
        renderItem={(e) => {
          const ymd = dayOf(e.date);
          const desc = e.description?.trim();
          return (
            <ListItem
              leading={<DateTile date={ymd} tone="info" />}
              title={`${e.hours} h extra`}
              subtitle={`${fmtDay(ymd, { year: true })}${desc ? ` · ${desc}` : ""}`}
              trailing={<StatusPill status={e.status} size="sm" />}
            />
          );
        }}
      />

      <Sheet
        visible={open}
        onClose={() => setOpen(false)}
        title="Log extra hours"
        subtitle="Goes to your manager for approval"
        dismissable={!submitting}
        footer={<Button title="Submit for approval" onPress={submit} loading={submitting} />}
      >
        <ErrorBanner message={submitError} onDismiss={() => setSubmitError(null)} />
        <DateField
          label="Date worked"
          value={date}
          onChange={(v) => {
            setDate(v);
            setErrors((p) => ({ ...p, date: undefined }));
          }}
          error={errors.date}
          quick={[
            { label: "Today", value: today },
            { label: "Yesterday", value: addDaysISO(today, -1) },
          ]}
          required
        />
        <Field
          label="Hours"
          value={hours}
          onChangeText={(t) => {
            setHours(t);
            setErrors((p) => ({ ...p, hours: undefined }));
          }}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="e.g. 2.5"
          error={errors.hours}
          required
        />
        <Field
          label="What did you work on?"
          value={description}
          onChangeText={setDescription}
          multiline
          autoCapitalize="sentences"
          autoCorrect
        />
      </Sheet>
    </Screen>
  );
}
