// DateField — WEB / default implementation (no native date picker is bundled here).
// iOS / Android resolve `date-field.native.tsx` instead (same props).
// Value is always a date-only string "YYYY-MM-DD" (or ""), never an instant.
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { fmtDay, isISODate } from "@/lib/api";
import { colors, radius, spacing } from "@/lib/theme";
import { Field } from "@/components/ui";

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

function pretty(ymd: string): string {
  return fmtDay(ymd, { weekday: true, year: true });
}

/** "20261029", "2026/10/29", "2026-1-9" → "2026-10-29" / "2026-01-09"; anything else unchanged. */
function normalize(t: string): string {
  const s = t.trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return s;
}

function rangeError(v: string, min?: string, max?: string): string | null {
  if (min && isISODate(min) && v < min) return `Pick ${pretty(min)} or later`;
  if (max && isISODate(max) && v > max) return `Pick ${pretty(max)} or earlier`;
  return null;
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
  const [text, setText] = useState(value);
  const [synced, setSynced] = useState(value);
  const [localError, setLocalError] = useState<string | null>(null);
  if (value !== synced) {
    setSynced(value);
    setText(value);
    setLocalError(null);
  }

  const onChangeText = (t: string) => {
    setText(t);
    setLocalError(null);
    if (!t.trim()) {
      if (value !== "") onChange("");
      return;
    }
    const n = normalize(t);
    if (isISODate(n) && !rangeError(n, minimumDate, maximumDate) && n !== value) onChange(n);
  };

  const onBlur = () => {
    if (!text.trim()) return;
    const n = normalize(text);
    if (!isISODate(n)) {
      setLocalError("Enter a date as YYYY-MM-DD");
      return;
    }
    const r = rangeError(n, minimumDate, maximumDate);
    if (r) {
      setLocalError(r);
      return;
    }
    setText(n);
    if (n !== value) onChange(n);
  };

  const shownError = error || localError;
  const shownHint = hint ?? (isISODate(value) ? pretty(value) : undefined);
  const hasQuick = !!quick && quick.length > 0;

  return (
    <View style={style}>
      <Field
        label={label}
        value={text}
        onChangeText={onChangeText}
        onBlur={onBlur}
        placeholder={placeholder ?? "YYYY-MM-DD"}
        inputMode="numeric"
        maxLength={10}
        leading="calendar-outline"
        error={shownError}
        hint={shownHint}
        required={required}
        editable={!disabled}
        accessibilityLabel={accessibilityLabel ?? label}
        testID={testID}
        style={hasQuick ? styles.fieldWithQuick : undefined}
      />
      {hasQuick && quick ? (
        <View style={styles.quick}>
          {quick.map((q) => {
            const active = q.value === value;
            return (
              <Pressable
                key={`${q.label}-${q.value}`}
                onPress={() => {
                  setText(q.value);
                  setLocalError(null);
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
  fieldWithQuick: { marginBottom: spacing.sm },
  quick: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: spacing.md },
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
  disabled: { opacity: 0.5 },
});
