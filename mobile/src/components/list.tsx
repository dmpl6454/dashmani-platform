// Dashmani list primitives — "2026 iOS" grouped-inset rows, stat tiles, date tiles and
// in-content large titles. Built on the primitives in `@/components/ui`.
//
// - ListItem: 52 pt row, 32 pt tinted icon tile (radius 8), inset hairline, chevron / checkmark.
// - ListGroup: grouped card of rows; marks the last ListItem / Row `last` automatically.
// - StatTile / StatGrid: left-aligned 28 pt tabular stat tiles in a 2/3-column grid.
//   `compact` is a StatTile prop, never a StatGrid prop:
//   <StatGrid columns={3}><StatTile compact … /></StatGrid>
// - DateTile: 44 pt day/month tile. A bare YYYY-MM-DD is split (never `new Date(ymd)`);
//   an ISO instant is shown on its IST (Asia/Kolkata) calendar day.
// - LargeTitle: 34 pt title drawn in content on tab roots (ONLY with <Screen header="none">).
// - HeaderButton: 44 pt icon button for a Stack `headerRight`.
import React, { useContext } from "react";
import { Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { fmtDay, istDateOf } from "@/lib/api";
import { colors, radius, sizes, spacing, tintColor, toneColors, type } from "@/lib/theme";
import type { TintKey, Tone } from "@/lib/theme";
import { Badge, Card, IconButton, Row, SectionTitle, SurfaceContext, type IoniconName } from "@/components/ui";

/** iOS continuous ("squircle") corners where supported. */
const continuous: ViewStyle | null = Platform.OS === "ios" ? { borderCurve: "continuous" } : null;

const ZERO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

/** Warm tiles (yellow / orange) need a dark glyph, not white. */
const WARM_TILES = new Set<string>([
  colors.yellow,
  colors.amber,
  colors.warning,
  colors.tint.orange,
  colors.tint.yellow,
  colors.gradient[0],
]);

function glyphOn(bg: string): string {
  return WARM_TILES.has(bg) ? colors.inkOnAccent : "#FFFFFF";
}

// ---------- ListItem ----------
export type ListItemProps = {
  title: string;
  subtitle?: string;
  /** secondary value on the right (15 pt, secondary colour) */
  detail?: string;
  icon?: IoniconName;
  /** icon tile colour: a TintKey or a raw colour (default "brand") */
  tint?: TintKey | string;
  /** custom leading node (replaces the icon tile), e.g. an Avatar or DateTile */
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onPress?: () => void;
  /** default: shown when pressable and not a selection row */
  chevron?: boolean;
  /** selection row: true → brand checkmark; false → no checkmark (no chevron either way by default) */
  selected?: boolean;
  badge?: number | string;
  destructive?: boolean;
  disabled?: boolean;
  /** hides the bottom hairline (ListGroup sets it on the last row) */
  last?: boolean;
  /** max lines for the title (default 1) and subtitle (default 2) */
  lines?: 1 | 2;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
};

export function ListItem({
  title,
  subtitle,
  detail,
  icon,
  tint,
  leading,
  trailing,
  onPress,
  chevron,
  selected,
  badge,
  destructive = false,
  disabled = false,
  last = false,
  lines,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: ListItemProps) {
  const tileBg = tintColor(tint ?? "brand");
  const hasBadge = badge !== undefined && badge !== null && badge !== 0 && badge !== "";
  const showChevron = chevron ?? (!!onPress && selected === undefined);

  const leadNode =
    leading ??
    (icon ? (
      <View style={[styles.tile, continuous, { backgroundColor: tileBg }]}>
        <Ionicons name={icon} size={sizes.iconGlyph} color={glyphOn(tileBg)} />
      </View>
    ) : null);

  const content = (
    <View style={[styles.item, disabled ? styles.dimmed : null]} testID={onPress ? undefined : testID}>
      {leadNode ? <View style={styles.lead}>{leadNode}</View> : null}
      <View style={[styles.body, last ? styles.bodyLast : null]}>
        <View style={styles.text}>
          <Text
            maxFontSizeMultiplier={1.6}
            numberOfLines={lines ?? 1}
            style={[styles.title, destructive ? styles.titleDestructive : null]}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text maxFontSizeMultiplier={1.6} numberOfLines={lines ?? 2} style={styles.subtitle}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {detail ? (
          <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={styles.detail}>
            {detail}
          </Text>
        ) : null}
        {trailing}
        {hasBadge ? (
          <View style={styles.badge}>
            <Badge value={badge} />
          </View>
        ) : null}
        {selected ? <Ionicons name="checkmark" size={20} color={colors.purple} style={styles.check} /> : null}
        {showChevron ? (
          <Ionicons name="chevron-forward" size={sizes.chevron} color={colors.faint} style={styles.chevron} />
        ) : null}
      </View>
    </View>
  );

  if (!onPress) return content;

  const label =
    accessibilityLabel ??
    [title, subtitle, detail, hasBadge ? `${badge} new` : undefined].filter((s): s is string => !!s).join(", ");

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected: selected === undefined ? undefined : selected }}
      testID={testID}
      style={({ pressed }) => (pressed && !disabled ? styles.pressed : null)}
    >
      {content}
    </Pressable>
  );
}

// ---------- ListGroup ----------
export type ListGroupProps = {
  children: React.ReactNode;
  /** 13 pt uppercase group header */
  title?: string;
  /** 13 pt secondary note under the group */
  footer?: string;
  style?: StyleProp<ViewStyle>;
};

export function ListGroup({ children, title, footer, style }: ListGroupProps) {
  const surface = useContext(SurfaceContext);
  const items = React.Children.toArray(children);
  let lastIdx = -1;
  items.forEach((c, i) => {
    if (React.isValidElement(c)) lastIdx = i;
  });
  const rows = items.map((c, i) => {
    if (i !== lastIdx || !React.isValidElement<{ last?: boolean }>(c)) return c;
    if (c.type !== ListItem && c.type !== Row) return c;
    if (c.props.last !== undefined) return c;
    return React.cloneElement(c, { last: true });
  });

  return (
    <View style={[styles.group, style]}>
      {title ? (
        <SectionTitle variant="grouped" style={styles.groupTitle}>
          {title}
        </SectionTitle>
      ) : null}
      <Card
        padded={false}
        style={[styles.groupCard, surface === "sheet" ? { backgroundColor: colors.inputOnSheet } : null]}
      >
        {rows}
      </Card>
      {footer ? (
        <Text maxFontSizeMultiplier={1.6} style={styles.groupFooter}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

// ---------- StatTile ----------
export type StatTileProps = {
  label: string;
  value: string | number;
  icon?: IoniconName;
  /** icon / progress tone (default "brand") */
  tone?: Tone;
  /** value colour (default ink) */
  valueColor?: string;
  delta?: { value: string; tone?: Tone };
  /** 0..1 → 4 pt progress bar */
  progress?: number;
  hint?: string;
  onPress?: () => void;
  /** 72 pt tile with a 22 pt value (3-column grids) */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

export function StatTile({
  label,
  value,
  icon,
  tone = "brand",
  valueColor,
  delta,
  progress,
  hint,
  onPress,
  compact = false,
  style,
  accessibilityLabel,
}: StatTileProps) {
  const t = toneColors(tone);
  const dt = toneColors(delta?.tone ?? "neutral");
  const pct =
    progress === undefined || progress === null || !Number.isFinite(progress)
      ? null
      : Math.max(0, Math.min(1, progress));

  const body = (
    <>
      <View style={styles.statHead}>
        {icon ? <Ionicons name={icon} size={compact ? 16 : 20} color={t.fg} style={styles.statIcon} /> : null}
        <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={styles.statLabel}>
          {label}
        </Text>
        {onPress ? <Ionicons name="chevron-forward" size={14} color={colors.faint} /> : null}
      </View>
      <View style={styles.statValueRow}>
        <Text
          maxFontSizeMultiplier={1.3}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.6}
          style={[styles.statValue, compact ? styles.statValueCompact : null, { color: valueColor ?? colors.ink }]}
        >
          {value}
        </Text>
        {delta ? (
          <View style={[styles.delta, continuous, { backgroundColor: dt.bg }]}>
            <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={[styles.deltaText, { color: dt.text }]}>
              {delta.value}
            </Text>
          </View>
        ) : null}
      </View>
      {pct !== null ? (
        <View style={styles.progressTrack}>
          <View style={{ flex: pct, backgroundColor: t.fg, borderRadius: 2 }} />
          <View style={{ flex: 1 - pct }} />
        </View>
      ) : null}
      {hint ? (
        <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={styles.statHint}>
          {hint}
        </Text>
      ) : null}
    </>
  );

  const a11y =
    accessibilityLabel ??
    [
      `${label}, ${value}`,
      delta ? delta.value : undefined,
      pct !== null ? `${Math.round(pct * 100)} percent` : undefined,
      hint,
    ]
      .filter((s): s is string => !!s)
      .join(", ");

  const tileStyle: StyleProp<ViewStyle> = [styles.stat, continuous, compact ? styles.statCompact : null];

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityState={{ disabled: false }}
        style={[tileStyle, style]}
      >
        {({ pressed }) => (
          <>
            {body}
            {pressed ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.pressed]} /> : null}
          </>
        )}
      </Pressable>
    );
  }
  return (
    <View accessible accessibilityLabel={a11y} style={[tileStyle, style]}>
      {body}
    </View>
  );
}

// ---------- StatGrid ----------
export type StatGridProps = {
  children: React.ReactNode;
  /** default 2 */
  columns?: 2 | 3;
  style?: StyleProp<ViewStyle>;
};

export function StatGrid({ children, columns = 2, style }: StatGridProps) {
  const cells = React.Children.toArray(children);
  const width: `${number}%` = columns === 3 ? "33.3333%" : "50%";
  return (
    <View style={[styles.grid, style]}>
      {cells.map((c, i) => (
        <View
          key={React.isValidElement(c) && c.key !== null ? c.key : String(i)}
          style={[styles.cell, { width }]}
        >
          {c}
        </View>
      ))}
    </View>
  );
}

// ---------- DateTile ----------
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type DateTileProps = {
  /** YYYY-MM-DD (split, never parsed as an instant) or an ISO instant (shown in IST) */
  date: string;
  /** default "warning" */
  tone?: Tone;
};

export function DateTile({ date, tone = "warning" }: DateTileProps) {
  const t = toneColors(tone);
  // istDateOf splits a bare YYYY-MM-DD and shifts an instant to its Asia/Kolkata day by hand,
  // so the result never depends on the device time zone or on Intl support.
  const ymd = istDateOf(date);
  const parts = ymd ? ymd.split("-") : [];
  const valid = parts.length === 3;
  const day = valid ? String(Number(parts[2])) : "—";
  const month = valid ? (MON[Number(parts[1]) - 1] ?? "") : "";
  const label = ymd ? fmtDay(ymd, { weekday: true, year: true }) : "Date unknown";
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.dateTile, continuous, { backgroundColor: t.bg }]}
    >
      <Text maxFontSizeMultiplier={1.2} style={[styles.dateDay, { color: t.text }]}>
        {day}
      </Text>
      {month ? (
        <Text maxFontSizeMultiplier={1.2} style={[styles.dateMonth, { color: t.text }]}>
          {month}
        </Text>
      ) : null}
    </View>
  );
}

// ---------- LargeTitle ----------
export type LargeTitleProps = {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
};

/** 34 pt in-content title for headerless tab roots. Use ONLY with <Screen header="none">. */
export function LargeTitle({ title, subtitle, right, style }: LargeTitleProps) {
  const insets = useContext(SafeAreaInsetsContext) ?? ZERO_INSETS;
  const top = (Platform.OS === "web" ? 0 : insets.top) + spacing.sm;
  return (
    <View style={[styles.large, { paddingTop: top }, style]}>
      <View style={styles.largeText}>
        <Text accessibilityRole="header" maxFontSizeMultiplier={1.3} numberOfLines={2} style={styles.largeTitle}>
          {title}
        </Text>
        {subtitle ? (
          <Text maxFontSizeMultiplier={1.6} style={styles.largeSub}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.largeRight}>{right}</View> : null}
    </View>
  );
}

// ---------- HeaderButton ----------
export type HeaderButtonProps = {
  icon: IoniconName;
  label: string;
  onPress: () => void;
  badge?: number | null;
  disabled?: boolean;
};

/** 44 pt icon button for a Stack `headerRight` / `headerLeft`. */
export function HeaderButton({ icon, label, onPress, badge, disabled = false }: HeaderButtonProps) {
  return (
    <IconButton
      icon={icon}
      label={label}
      onPress={onPress}
      badge={badge}
      disabled={disabled}
      glyph={22}
      tint={colors.purple}
    />
  );
}

// ---------- styles ----------
const styles = StyleSheet.create({
  dimmed: { opacity: 0.5 },
  pressed: { backgroundColor: colors.pressOverlay },

  item: { flexDirection: "row", alignItems: "center", minHeight: sizes.rowMin, paddingLeft: spacing.lg },
  lead: { marginRight: spacing.md },
  tile: {
    width: sizes.iconTile,
    height: sizes.iconTile,
    borderRadius: radius.tile,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    minHeight: sizes.rowMin,
    paddingVertical: 10,
    paddingRight: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  bodyLast: { borderBottomWidth: 0 },
  text: { flex: 1, minWidth: 0, paddingRight: spacing.sm },
  title: { fontSize: 17, color: colors.ink },
  titleDestructive: { color: colors.redText },
  subtitle: { fontSize: 15, color: colors.sub, marginTop: 2 },
  detail: { fontSize: 15, color: colors.sub, marginRight: 6, maxWidth: "45%" },
  badge: { marginRight: 6 },
  check: { marginLeft: 4 },
  chevron: { marginLeft: 2 },

  group: { marginBottom: spacing.section },
  groupTitle: { marginTop: spacing.xs },
  groupCard: { marginBottom: 0, overflow: "hidden" },
  groupFooter: { fontSize: 13, color: colors.sub, marginTop: 6, paddingHorizontal: spacing.lg, lineHeight: 18 },

  stat: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    backgroundColor: colors.surface1,
    borderRadius: radius.card,
    padding: 14,
    minHeight: 92,
    overflow: "hidden",
  },
  statCompact: { minHeight: 72, paddingVertical: 12 },
  statHead: { flexDirection: "row", alignItems: "center" },
  statIcon: { marginRight: 6 },
  statLabel: { flex: 1, fontSize: 13, color: colors.sub },
  statValueRow: { flexDirection: "row", alignItems: "center", marginTop: 6 },
  statValue: { flexShrink: 1, fontSize: 28, fontWeight: "700", ...type.numeric },
  statValueCompact: { fontSize: 22 },
  delta: {
    marginLeft: spacing.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  deltaText: { fontSize: 12, fontWeight: "600", ...type.numeric },
  progressTrack: {
    flexDirection: "row",
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.cardHigh,
    marginTop: 10,
    overflow: "hidden",
  },
  statHint: { fontSize: 12, color: colors.sub, marginTop: 4 },

  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginHorizontal: -(spacing.group / 2),
    marginBottom: spacing.lg - spacing.group,
  },
  cell: { flexDirection: "row", paddingHorizontal: spacing.group / 2, marginBottom: spacing.group },

  dateTile: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  dateDay: { fontSize: 17, fontWeight: "700", lineHeight: 20, ...type.numeric },
  dateMonth: { fontSize: 11, fontWeight: "500", textTransform: "uppercase", lineHeight: 13 },

  large: { flexDirection: "row", alignItems: "center", marginBottom: spacing.md },
  largeText: { flex: 1, minWidth: 0 },
  largeTitle: { ...type.largeTitle, color: colors.ink },
  largeSub: { fontSize: 15, color: colors.sub, marginTop: 2 },
  largeRight: { marginLeft: spacing.sm, justifyContent: "center", minHeight: sizes.touch },
});
