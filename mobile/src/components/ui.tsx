import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  ScrollView,
  RefreshControl,
  Platform,
  ViewStyle,
  KeyboardTypeOptions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing, type, statusColor, formatStatus } from "@/lib/theme";

// iOS continuous ("squircle") corners where supported
const continuous = Platform.OS === "ios" ? ({ borderCurve: "continuous" } as any) : null;

// ---------- Screen ----------
export function Screen({
  children,
  onRefresh,
  refreshing,
  padded = true,
}: {
  children: React.ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  padded?: boolean;
}) {
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: padded ? spacing.lg : 0, paddingBottom: 120 }}
      refreshControl={
        onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.sub} /> : undefined
      }
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

// ---------- Card (inset grouped container — no border, bg contrast only) ----------
export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, continuous, style]}>{children}</View>;
}

// ---------- Section title (iOS grouped-list header: 13pt uppercase secondary) ----------
export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>
        {typeof children === "string"
          ? children.toUpperCase()
          : Array.isArray(children)
            ? children.map((c) => (typeof c === "string" || typeof c === "number" ? String(c).toUpperCase() : c))
            : children}
      </Text>
      {right}
    </View>
  );
}

// ---------- Status pill (restrained: 12pt medium on 12% tint) ----------
export function StatusPill({ status }: { status: string }) {
  const c = statusColor(status);
  return (
    <View style={[styles.pill, { backgroundColor: c.bg }]}>
      <Text style={[styles.pillText, { color: c.fg }]}>{formatStatus(status)}</Text>
    </View>
  );
}

// ---------- Button (iOS filled / tinted / plain) ----------
export function Button({
  title,
  onPress,
  variant = "primary",
  loading,
  disabled,
  style,
  small,
}: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  small?: boolean;
}) {
  const bg =
    variant === "primary"
      ? colors.purple
      : variant === "danger"
        ? colors.redSoft
        : variant === "secondary"
          ? colors.purpleSoft
          : colors.card;
  const fg =
    variant === "primary" ? "#fff" : variant === "danger" ? colors.red : variant === "secondary" ? colors.purple : colors.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.btn,
        continuous,
        small && styles.btnSmall,
        { backgroundColor: bg, opacity: disabled || loading ? 0.4 : pressed ? 0.7 : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <Text style={[styles.btnText, small && { fontSize: 15 }, { color: fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

// ---------- Field ----------
export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  multiline,
  keyboardType,
  error,
  autoCapitalize = "none",
}: {
  label?: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
  error?: string;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
}) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        secureTextEntry={secureTextEntry}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        style={[
          styles.input,
          continuous,
          multiline && { height: 92, textAlignVertical: "top", paddingTop: 12 },
          error ? { borderWidth: 1, borderColor: colors.red } : null,
        ]}
      />
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

// ---------- Segmented control (iOS style; >4 options → quiet scrollable pills) ----------
export function Chips<T extends string>({
  options,
  value,
  onChange,
  labels,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  labels?: Partial<Record<T, string>>;
}) {
  if (options.length <= 4) {
    return (
      <View style={[styles.segTrack, continuous]}>
        {options.map((opt) => {
          const active = opt === value;
          return (
            <Pressable key={opt} onPress={() => onChange(opt)} style={[styles.segItem, continuous, active && styles.segItemActive]}>
              <Text style={[styles.segText, active && styles.segTextActive]} numberOfLines={1}>
                {labels?.[opt] ?? formatStatus(opt)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginBottom: spacing.md, flexGrow: 0 }}
      contentContainerStyle={{ gap: 8 }}
    >
      {options.map((opt) => {
        const active = opt === value;
        return (
          <Pressable key={opt} onPress={() => onChange(opt)} style={[styles.chip, continuous, active && { backgroundColor: colors.purple }]}>
            <Text style={[styles.chipText, active && { color: "#fff", fontWeight: "600" }]}>
              {labels?.[opt] ?? formatStatus(opt)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ---------- Empty state ----------
export function Empty({ icon = "file-tray-outline", text }: { icon?: any; text: string }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={26} color={colors.faint} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

// ---------- Loading ----------
export function Loading() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="small" color={colors.sub} />
    </View>
  );
}

// ---------- Banners ----------
export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={[styles.banner, continuous, { backgroundColor: colors.redSoft }]}>
      <Ionicons name="alert-circle" size={16} color={colors.red} />
      <Text style={[styles.bannerText, { color: colors.red }]}>{message}</Text>
    </View>
  );
}

export function SuccessBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={[styles.banner, continuous, { backgroundColor: colors.greenSoft }]}>
      <Ionicons name="checkmark-circle" size={16} color={colors.green} />
      <Text style={[styles.bannerText, { color: colors.green }]}>{message}</Text>
    </View>
  );
}

// ---------- Stat (Health-app style: large numeral with tabular figures) ----------
export function Stat({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <View style={[styles.stat, continuous]}>
      <Text style={[styles.statValue, accent ? { color: accent } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.statLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// ---------- Row (Settings-style: 29pt icon tile, chevron, inset hairline) ----------
export function Row({
  title,
  subtitle,
  right,
  onPress,
  icon,
  iconColor,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  icon?: any;
  iconColor?: string;
}) {
  const content = (
    <View style={styles.row}>
      {icon ? (
        <View style={[styles.rowIcon, continuous, iconColor ? { backgroundColor: iconColor } : null]}>
          <Ionicons name={String(icon).replace("-outline", "") as any} size={16} color="#fff" />
        </View>
      ) : null}
      <View style={styles.rowBody}>
        <View style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.rowSub} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right}
        {onPress ? <Ionicons name="chevron-forward" size={15} color={colors.faint} /> : null}
      </View>
    </View>
  );
  if (onPress)
    return (
      <Pressable onPress={onPress} style={({ pressed }) => (pressed ? { backgroundColor: "rgba(255,255,255,0.04)" } : null)}>
        {content}
      </Pressable>
    );
  return content;
}

// ---------- TrendBars (quiet inline bar chart, Health-style) ----------
export function TrendBars({ data, height = 56, tint }: { data: number[]; height?: number; tint?: string }) {
  const max = Math.max(...data, 1);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 3, height }}>
      {data.map((v, i) => (
        <View
          key={i}
          style={{
            flex: 1,
            height: Math.max(3, (v / max) * height),
            borderRadius: 2,
            backgroundColor: i === data.length - 1 ? (tint ?? colors.purple) : colors.cardHigh,
          }}
        />
      ))}
    </View>
  );
}

// ---------- useApi hook ----------
export function useApi<T>(fetcher: () => Promise<T>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (asRefresh = false) => {
    if (asRefresh) setRefreshing(true);
    setError(null);
    try {
      setData(await fetcher());
    } catch (e: any) {
      setError(e?.message || "Something went wrong");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading, refreshing, error, refresh: () => load(true), reload: () => load(false), setData };
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
    marginTop: 4,
    paddingHorizontal: 4,
  },
  sectionTitle: { fontSize: 13, color: colors.sub, letterSpacing: 0.3 },
  pill: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: radius.full,
    alignSelf: "flex-start",
  },
  pillText: { fontSize: 12, fontWeight: "500" },
  btn: {
    height: 50,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  btnSmall: { height: 38, paddingHorizontal: spacing.md, borderRadius: radius.md },
  btnText: { fontSize: 17, fontWeight: "600" },
  fieldLabel: { fontSize: 13, color: colors.sub, marginBottom: 6, paddingLeft: 2 },
  input: {
    borderRadius: radius.md,
    backgroundColor: colors.cardHigh,
    paddingHorizontal: 14,
    height: 46,
    fontSize: 17,
    color: colors.ink,
  },
  fieldError: { color: colors.red, fontSize: 13, marginTop: 5, paddingLeft: 2 },
  segTrack: {
    flexDirection: "row",
    backgroundColor: colors.cardHigh,
    borderRadius: radius.md,
    padding: 2,
    marginBottom: spacing.md,
  },
  segItem: {
    flex: 1,
    height: 32,
    borderRadius: radius.md - 2,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  segItemActive: {
    backgroundColor: "#636366",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  segText: { fontSize: 13, fontWeight: "500", color: colors.sub },
  segTextActive: { color: colors.ink, fontWeight: "600" },
  chip: {
    paddingHorizontal: 14,
    height: 32,
    justifyContent: "center",
    borderRadius: radius.full,
    backgroundColor: colors.card,
  },
  chipText: { fontSize: 14, color: colors.sub },
  empty: { alignItems: "center", paddingVertical: 30, gap: 8 },
  emptyText: { fontSize: 15, color: colors.faint },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg, minHeight: 160 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: radius.md,
    padding: 12,
    marginBottom: spacing.md,
  },
  bannerText: { fontSize: 14, flex: 1 },
  stat: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingVertical: 14,
    paddingHorizontal: 8,
    alignItems: "center",
  },
  statValue: { fontSize: 24, fontWeight: "600", color: colors.ink, fontVariant: ["tabular-nums"] },
  statLabel: { fontSize: 12, color: colors.sub, marginTop: 3 },
  row: { flexDirection: "row", alignItems: "center", minHeight: 46 },
  rowIcon: {
    width: 29,
    height: 29,
    borderRadius: 7,
    backgroundColor: colors.purple,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  rowBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowTitle: { fontSize: 16, color: colors.ink },
  rowSub: { fontSize: 13, color: colors.sub, marginTop: 1 },
});
