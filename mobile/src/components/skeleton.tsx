// Skeleton placeholders shown on first load (instead of a full-screen spinner).
// Blocks use `colors.skeleton` and pulse towards `colors.skeletonHi` on a shared
// 1100 ms loop. Static on web and when the user has Reduce Motion enabled.
// The blocks are hidden from assistive tech; each composite announces "Loading".
import React, { useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { colors, radius, sizes, spacing } from "@/lib/theme";

// ---------- shared pulse ----------
const pulse = new Animated.Value(0);
let pulseUsers = 0;
let pulseLoop: Animated.CompositeAnimation | null = null;
let reduceMotionQuery: Promise<boolean> | null = null;

function queryReduceMotion(): Promise<boolean> {
  if (Platform.OS === "web") return Promise.resolve(true);
  if (!reduceMotionQuery) {
    reduceMotionQuery = AccessibilityInfo.isReduceMotionEnabled().catch(() => false);
  }
  return reduceMotionQuery;
}

function acquirePulse() {
  pulseUsers += 1;
  if (pulseLoop) return;
  pulseLoop = Animated.loop(
    Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 550, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 550, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]),
  );
  pulseLoop.start();
}

function releasePulse() {
  pulseUsers = Math.max(0, pulseUsers - 1);
  if (pulseUsers === 0 && pulseLoop) {
    pulseLoop.stop();
    pulseLoop = null;
    pulse.setValue(0);
  }
}

function usePulse(): Animated.Value | null {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    let held = false;
    queryReduceMotion().then((reduce) => {
      if (!alive || reduce) return;
      held = true;
      acquirePulse();
      setOn(true);
    });
    return () => {
      alive = false;
      if (held) releasePulse();
    };
  }, []);
  return on ? pulse : null;
}

const hidden = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants" as const,
};

const loadingA11y = {
  accessible: true,
  accessibilityLabel: "Loading",
  accessibilityRole: "progressbar" as const,
};

// ---------- Skeleton (one block) ----------
export type SkeletonProps = {
  width?: number | `${number}%`;
  /** default 14 */
  height?: number;
  /** default 6 */
  radius?: number;
  style?: StyleProp<ViewStyle>;
};

export function Skeleton({ width = "100%", height = 14, radius: r = 6, style }: SkeletonProps) {
  const value = usePulse();
  return (
    <View
      {...hidden}
      style={[{ width, height, borderRadius: r, backgroundColor: colors.skeleton, overflow: "hidden" }, style]}
    >
      {value ? (
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.skeletonHi, opacity: value }]}
        />
      ) : null}
    </View>
  );
}

// ---------- SkeletonRow (52 pt list row) ----------
export function SkeletonRow({ lines = 1, tile = false }: { lines?: 1 | 2; tile?: boolean }) {
  return (
    <View style={styles.row} {...hidden}>
      {tile ? <Skeleton width={sizes.iconTile} height={sizes.iconTile} radius={radius.tile} style={styles.rowTile} /> : null}
      <View style={styles.rowText}>
        <Skeleton width="62%" height={14} />
        {lines === 2 ? <Skeleton width="38%" height={12} style={styles.rowSecond} /> : null}
      </View>
    </View>
  );
}

// ---------- SkeletonList (grouped card of rows) ----------
export function SkeletonList({ rows = 3, tile = false }: { rows?: number; tile?: boolean }) {
  const count = Math.max(1, Math.floor(rows));
  return (
    <View {...loadingA11y} style={styles.card}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i}>
          {i > 0 ? <View style={[styles.separator, { marginLeft: tile ? spacing.lg + sizes.iconTile + spacing.md : spacing.lg }]} /> : null}
          <SkeletonRow lines={2} tile={tile} />
        </View>
      ))}
    </View>
  );
}

// ---------- SkeletonStatRow (row of stat tiles) ----------
export function SkeletonStatRow({ count = 2 }: { count?: number }) {
  const n = Math.max(1, Math.floor(count));
  return (
    <View {...loadingA11y} style={styles.statRow}>
      {Array.from({ length: n }, (_, i) => (
        <View key={i} style={[styles.statTile, i > 0 ? { marginLeft: spacing.group } : null]} {...hidden}>
          <Skeleton width="55%" height={12} />
          <Skeleton width="40%" height={28} radius={8} style={styles.statValue} />
        </View>
      ))}
    </View>
  );
}

// ---------- SkeletonCard (title + text lines) ----------
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  const n = Math.max(0, Math.floor(lines));
  return (
    <View {...loadingA11y} style={[styles.card, styles.cardPadded]}>
      <View {...hidden}>
        <Skeleton width="45%" height={17} />
        {Array.from({ length: n }, (_, i) => (
          <Skeleton key={i} width={i === n - 1 ? "60%" : "100%"} height={13} style={styles.cardLine} />
        ))}
      </View>
    </View>
  );
}

// ---------- SkeletonForm (label + input pairs) ----------
export function SkeletonForm({ fields = 3 }: { fields?: number }) {
  const n = Math.max(1, Math.floor(fields));
  return (
    <View {...loadingA11y}>
      <View {...hidden}>
        {Array.from({ length: n }, (_, i) => (
          <View key={i} style={styles.field}>
            <Skeleton width="30%" height={12} style={styles.fieldLabel} />
            <Skeleton height={sizes.control} radius={radius.control} />
          </View>
        ))}
      </View>
    </View>
  );
}

const continuous: ViewStyle | null = Platform.OS === "ios" ? { borderCurve: "continuous" } : null;

const styles = StyleSheet.create({
  row: {
    minHeight: sizes.rowMin,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  rowTile: { marginRight: spacing.md },
  rowText: { flex: 1, justifyContent: "center" },
  rowSecond: { marginTop: 6 },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    overflow: "hidden",
    marginBottom: spacing.lg,
    ...continuous,
  },
  cardPadded: { padding: spacing.lg },
  cardLine: { marginTop: 10 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  statRow: { flexDirection: "row", marginBottom: spacing.lg },
  statTile: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: spacing.lg,
    minHeight: 88,
    ...continuous,
  },
  statValue: { marginTop: spacing.md },
  field: { marginBottom: spacing.lg },
  fieldLabel: { marginBottom: 8, marginLeft: 2 },
});
