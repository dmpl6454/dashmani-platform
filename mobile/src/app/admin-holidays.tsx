import React, { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { apiFetch, errorMessage, fmtDay, isISODate, todayIST } from "@/lib/api";
import { colors, formatStatus, sizes, spacing, type } from "@/lib/theme";
import { haptic } from "@/lib/device";
import { Button, Chips, ErrorBanner, Field, IconButton, Screen, useApi } from "@/components/ui";
import { AsyncList } from "@/components/async";
import { DateTile, ListItem } from "@/components/list";
import { Sheet } from "@/components/sheet";
import { confirm, toast } from "@/components/feedback";
import { DateField } from "@/components/date-field";

const TYPES = ["PUBLIC", "RESTRICTED", "COMPANY"] as const;
type HolidayType = (typeof TYPES)[number];
const TYPE_LABELS: Record<HolidayType, string> = { PUBLIC: "Public", RESTRICTED: "Restricted", COMPANY: "Company" };

type Holiday = {
  id: string;
  name: string;
  date: string;
  type?: string | null;
};

/**
 * The holiday's calendar day. The API serialises the @db.Date column as "YYYY-MM-DDT00:00:00.000Z";
 * keep the date part as-is instead of parsing it as an instant (AD-22).
 */
function dayOf(date: string): string {
  const head = date.slice(0, 10);
  return isISODate(head) ? head : date;
}

export default function AdminHolidays() {
  const state = useApi<Holiday[]>(() => apiFetch<Holiday[]>("/admin/holidays"));

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState(todayIST());
  const [holidayType, setHolidayType] = useState<HolidayType>("PUBLIC");
  const [nameError, setNameError] = useState<string | null>(null);
  const [dateError, setDateError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const openForm = () => {
    setNameError(null);
    setDateError(null);
    setFormError(null);
    setShowForm(true);
  };

  const closeForm = () => {
    if (!saving) setShowForm(false);
  };

  const add = async () => {
    const trimmed = name.trim();
    const nErr = trimmed ? null : "Enter the holiday's name";
    const dErr = isISODate(date) ? null : "Pick a date";
    setNameError(nErr);
    setDateError(dErr);
    setFormError(null);
    if (nErr || dErr) return;
    setSaving(true);
    try {
      await apiFetch("/admin/holidays", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, date, type: holidayType }),
      });
      setName("");
      setShowForm(false);
      void haptic("success");
      toast.show({ message: `${trimmed} added`, tone: "success" });
      await state.reload();
    } catch (e) {
      void haptic("error");
      setFormError(errorMessage(e, "Could not add the holiday"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (h: Holiday) => {
    const ok = await confirm({
      title: "Delete holiday?",
      message: `Remove "${h.name}" (${fmtDay(dayOf(h.date), { year: true })})?`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setDeletingId(h.id);
    try {
      await apiFetch(`/admin/holidays/${h.id}`, { method: "DELETE" });
      void haptic("success");
      toast.show({ message: "Holiday removed", tone: "success" });
      await state.reload();
    } catch (e) {
      void haptic("error");
      toast.show({ message: errorMessage(e, "Could not delete the holiday"), tone: "danger" });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Screen onRefresh={state.refresh} refreshing={state.refreshing}>
      <AsyncList
        state={state}
        grouped
        keyExtractor={(h) => h.id}
        sectionOf={(h) => dayOf(h.date).slice(0, 4)}
        header={
          <Button title="Add holiday" icon="add" size="md" onPress={openForm} style={styles.add} />
        }
        empty={{
          icon: "sunny-outline",
          title: "No holidays yet",
          text: "Add the year's public and company holidays so employees can plan their leave.",
          action: { label: "Add holiday", onPress: openForm },
        }}
        renderItem={(h) => {
          const day = dayOf(h.date);
          const busy = deletingId === h.id;
          return (
            <ListItem
              leading={<DateTile date={day} />}
              title={h.name}
              subtitle={`${fmtDay(day, { year: true })}${h.type ? ` · ${formatStatus(h.type)}` : ""}`}
              trailing={
                busy ? (
                  <View style={styles.busy} accessibilityLabel={`Deleting ${h.name}`}>
                    <ActivityIndicator color={colors.sub} />
                  </View>
                ) : (
                  <IconButton
                    icon="trash-outline"
                    label={`Delete ${h.name}`}
                    tint={colors.red}
                    glyph={20}
                    disabled={deletingId !== null}
                    onPress={() => {
                      void remove(h);
                    }}
                  />
                )
              }
            />
          );
        }}
      />

      <Sheet
        visible={showForm}
        onClose={closeForm}
        title="New holiday"
        dismissable={!saving}
        footer={<Button title="Add holiday" onPress={add} loading={saving} />}
      >
        <Field
          label="Name"
          value={name}
          onChangeText={(t) => {
            setName(t);
            if (nameError) setNameError(null);
          }}
          autoCapitalize="words"
          placeholder="e.g. Diwali"
          error={nameError}
          returnKeyType="done"
          required
        />
        <DateField
          label="Date"
          value={date}
          onChange={(v) => {
            setDate(v);
            if (dateError) setDateError(null);
          }}
          error={dateError}
          required
        />
        <Text style={styles.label} maxFontSizeMultiplier={1.6}>
          Type
        </Text>
        <Chips
          options={TYPES}
          value={holidayType}
          onChange={setHolidayType}
          labels={TYPE_LABELS}
          accessibilityLabel="Holiday type"
        />
        <ErrorBanner message={formError} onDismiss={() => setFormError(null)} style={styles.formError} />
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  add: { marginBottom: spacing.md },
  busy: { width: sizes.touch, height: sizes.touch, alignItems: "center", justifyContent: "center" },
  label: { ...type.footnote, fontWeight: "500", color: colors.sub, marginTop: spacing.sm, marginBottom: 6 },
  formError: { marginTop: spacing.md },
});
