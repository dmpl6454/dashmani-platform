// DateField — iOS / Android implementation. The ONLY file that imports
// @react-native-community/datetimepicker (the web export resolves date-field.tsx).
// Value is always a date-only string "YYYY-MM-DD" (or ""); it is converted to and from a
// local Date with getFullYear/getMonth/getDate — never toISOString.
import React, { useContext, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker from "@react-native-community/datetimepicker";
import { fmtDay, isISODate, todayIST } from "@/lib/api";
import { colors, isDark, radius, sizes, spacing } from "@/lib/theme";
import { Button, IconButton, SurfaceContext, surfaceInputBg } from "@/components/ui";

export type DateFieldProps = {
  label?: string;
  /** YYYY-MM-DD or "" */
  value: string;
  onChange: (v: string) => void;
  /** YYYY-MM-DD */
  minimumDate?: string;
  /** YYYY-MM-DD */
  maximumDate?: string;
  placeholder?: string;
  error?: string | null;
  /** quick picks under the field, e.g. [{ label: "Today", value: todayIST() }] */
  quick?: Array<{ label: string; value: string }>;
  required?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  hint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local calendar day of a Date as YYYY-MM-DD (no time-zone conversion). */
function toYmd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** YYYY-MM-DD → a local Date at noon (noon keeps DST edges on the same day). */
function fromYmd(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function pretty(ymd: string): string {
  return fmtDay(ymd, { weekday: true, year: true });
}

function clampYmd(ymd: string, min?: string, max?: string): string {
  if (min && isISODate(min) && ymd < min) return min;
  if (max && isISODate(max) && ymd > max) return max;
  return ymd;
}

export function DateField({
  label,
  value,
  onChange,
  minimumDate,
  maximumDate,
  placeholder,
  error,
  quick,
  required,
  disabled = false,
  accessibilityLabel,
  hint,
  style,
  testID,
}: DateFieldProps) {
  const surface = useContext(SurfaceContext);
  const [open, setOpen] = useState(false);

  const valid = isISODate(value);
  const shown = valid ? pretty(value) : "";
  const minValid = minimumDate && isISODate(minimumDate) ? minimumDate : undefined;
  const maxValid = maximumDate && isISODate(maximumDate) ? maximumDate : undefined;
  const pickerValue = fromYmd(valid ? value : clampYmd(todayIST(), minValid, maxValid));
  const minDate = minValid ? fromYmd(minValid) : undefined;
  const maxDate = maxValid ? fromYmd(maxValid) : undefined;

  const name = accessibilityLabel ?? label ?? "Date";
  const a11y = `${name}, ${shown || "not set"}${required ? ", required" : ""}`;
  const borderColor = error ? colors.red : open ? colors.purple : colors.border;
  const borderWidth = error || open ? 1.5 : StyleSheet.hairlineWidth;

  const pick = (d: Date) => {
    const ymd = clampYmd(toYmd(d), minValid, maxValid);
    if (ymd !== value) onChange(ymd);
  };

  const calendarBg = surface === "page" ? colors.card : surfaceInputBg(surface);

  return (
    <View style={[styles.field, style]} testID={testID}>
      {label ? (
        <Text maxFontSizeMultiplier={1.6} style={styles.label}>
          {label}
          {required ? <Text style={styles.required}> *</Text> : null}
        </Text>
      ) : null}
      <View
        style={[
          styles.inputWrap,
          Platform.OS === "ios" ? styles.continuous : null,
          { backgroundColor: surfaceInputBg(surface), borderColor, borderWidth },
          disabled ? styles.disabled : null,
        ]}
      >
        <Pressable
          onPress={() => setOpen((o) => !o)}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={a11y}
          accessibilityHint={error ?? (open ? "Hides the calendar" : "Opens a calendar")}
          accessibilityState={{ disabled, expanded: open }}
          style={styles.press}
        >
          <Ionicons
            name="calendar-outline"
            size={sizes.iconGlyph}
            color={open ? colors.purple : colors.sub}
            style={styles.lead}
          />
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={1.6}
            style={[styles.valueText, shown ? null : styles.placeholder]}
          >
            {shown || placeholder || "Select a date"}
          </Text>
        </Pressable>
        {valid && !required && !disabled ? (
          <IconButton
            icon="close-circle"
            label={`Clear ${label ?? "date"}`}
            onPress={() => {
              setOpen(false);
              onChange("");
            }}
            glyph={18}
            tint={colors.faint}
          />
        ) : null}
      </View>

      {open && !disabled && Platform.OS === "ios" ? (
        <View style={[styles.calendar, styles.continuous, { backgroundColor: calendarBg }]}>
          <DateTimePicker
            value={pickerValue}
            mode="date"
            display="inline"
            themeVariant={isDark ? "dark" : "light"}
            accentColor={colors.purple}
            minimumDate={minDate}
            maximumDate={maxDate}
            onValueChange={(_event: unknown, date: Date) => pick(date)}
          />
          <Button
            title="Done"
            variant="plain"
            tone="brand"
            size="sm"
            fullWidth={false}
            onPress={() => setOpen(false)}
            style={styles.done}
          />
        </View>
      ) : null}

      {open && !disabled && Platform.OS !== "ios" ? (
        <DateTimePicker
          value={pickerValue}
          mode="date"
          display="default"
          minimumDate={minDate}
          maximumDate={maxDate}
          onValueChange={(_event: unknown, date: Date) => {
            setOpen(false);
            pick(date);
          }}
          onDismiss={() => setOpen(false)}
        />
      ) : null}

      {error ? (
        <Text maxFontSizeMultiplier={1.6} accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      ) : hint ? (
        <Text maxFontSizeMultiplier={1.6} style={styles.hint}>
          {hint}
        </Text>
      ) : null}

      {quick && quick.length > 0 ? (
        <View style={styles.quick}>
          {quick.map((q) => {
            const active = q.value === value;
            return (
              <Pressable
                key={`${q.label}-${q.value}`}
                onPress={() => {
                  setOpen(false);
                  if (q.value !== value) onChange(q.value);
                }}
                disabled={disabled}
                hitSlop={{ top: 6, bottom: 6 }}
                accessibilityRole="button"
                accessibilityLabel={isISODate(q.value) ? `${q.label}, ${pretty(q.value)}` : q.label}
                accessibilityState={{ selected: active, disabled }}
                style={({ pressed }) => [
                  styles.chip,
                  active ? styles.chipActive : null,
                  pressed ? styles.pressed : null,
                  disabled ? styles.disabled : null,
                ]}
              >
                <Text maxFontSizeMultiplier={1.3} style={[styles.chipText, active ? styles.chipTextActive : null]}>
                  {q.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.md },
  label: { fontSize: 13, fontWeight: "500", color: colors.sub, marginBottom: 6, paddingLeft: 2 },
  required: { color: colors.redText },
  continuous: { borderCurve: "continuous" },
  inputWrap: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: sizes.control,
    borderRadius: radius.control,
    paddingLeft: 14,
    paddingRight: 2,
  },
  press: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    minHeight: sizes.control - 2,
    paddingVertical: 12,
    paddingRight: 12,
  },
  lead: { marginRight: 8 },
  valueText: { flex: 1, fontSize: 17, color: colors.ink },
  placeholder: { color: colors.faint },
  disabled: { opacity: 0.5 },
  calendar: {
    marginTop: spacing.sm,
    borderRadius: radius.card,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    overflow: "hidden",
  },
  done: { alignSelf: "flex-end", marginTop: spacing.xs },
  error: { color: colors.redText, fontSize: 13, marginTop: 6, paddingLeft: 2 },
  hint: { color: colors.sub, fontSize: 13, marginTop: 6, paddingLeft: 2 },
  quick: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: spacing.sm },
  chip: {
    minHeight: 32,
    paddingHorizontal: 12,
    paddingVertical: 4,
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.purpleSoft, borderColor: colors.purple },
  chipText: { fontSize: 15, color: colors.ink },
  chipTextActive: { color: colors.purpleText, fontWeight: "600" },
  pressed: { opacity: 0.7 },
});
