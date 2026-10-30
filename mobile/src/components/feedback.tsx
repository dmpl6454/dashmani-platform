// Dashmani app-wide feedback: bottom toasts and promise-based confirmation sheets.
//
//   toast.show({ message: "Report submitted", tone: "success" })
//   if (await confirm({ title: "Delete link?", confirmLabel: "Delete", destructive: true })) { … }
//
// Both are module-level emitters, safe to call before the hosts mount: <ToastHost/> and
// <ConfirmHost/> are mounted once in app/_layout and pick up whatever is pending.
// One toast at a time (a new one replaces the current one). Confirmations queue.
import React, { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { colors, glow, motion, radius, spacing, toneColors } from "@/lib/theme";
import type { Tone } from "@/lib/theme";
import type { IoniconName } from "@/components/ui";
import { ConfirmSheet } from "@/components/sheet";

const NATIVE_DRIVER = Platform.OS !== "web";
const ZERO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

/** Screen-reader announcement; no-op on web and where unsupported. */
function announce(message: string) {
  if (Platform.OS === "web") return;
  if (typeof AccessibilityInfo.announceForAccessibility === "function") {
    AccessibilityInfo.announceForAccessibility(message);
  }
}

// ---------- Toast store ----------
export type ToastOptions = {
  message: string;
  /** default "neutral" */
  tone?: Tone;
  /** default 3000; 0 = stays until dismissed */
  durationMs?: number;
  action?: { label: string; onPress: () => void };
};

type ActiveToast = ToastOptions & { id: number };

let toastCurrent: ActiveToast | null = null;
let toastSeq = 0;
const toastListeners = new Set<() => void>();

function emitToast() {
  Array.from(toastListeners).forEach((l) => l());
}

function subscribeToast(cb: () => void): () => void {
  toastListeners.add(cb);
  return () => {
    toastListeners.delete(cb);
  };
}

function getToast(): ActiveToast | null {
  return toastCurrent;
}

/** Hide the current toast (or only toast `id`, when given). */
function hideToast(id?: number) {
  if (!toastCurrent) return;
  if (id !== undefined && toastCurrent.id !== id) return;
  toastCurrent = null;
  emitToast();
}

export const toast: { show: (o: ToastOptions) => void; hide: () => void } = {
  show(o: ToastOptions) {
    if (!o || !o.message) return;
    toastSeq += 1;
    toastCurrent = { ...o, id: toastSeq };
    emitToast();
  },
  hide() {
    hideToast();
  },
};

const TOAST_ICON: Record<Tone, IoniconName | null> = {
  neutral: null,
  brand: null,
  success: "checkmark-circle",
  warning: "warning",
  danger: "alert-circle",
  info: "information-circle",
};

// ---------- ToastHost ----------
/** Mount once at the app root (above the navigator). */
export function ToastHost() {
  const insets = useContext(SafeAreaInsetsContext) ?? ZERO_INSETS;
  const active = useSyncExternalStore(subscribeToast, getToast, getToast);
  const [shown, setShown] = useState<ActiveToast | null>(active);
  if (active && active !== shown) setShown(active);
  const [anim] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!active) {
      Animated.timing(anim, {
        toValue: 0,
        duration: motion.fast,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: NATIVE_DRIVER,
      }).start(({ finished }) => {
        if (finished) setShown(null);
      });
      return;
    }
    announce(active.message);
    Animated.timing(anim, {
      toValue: 1,
      duration: motion.base,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: NATIVE_DRIVER,
    }).start();
    const ms = active.durationMs ?? 3000;
    if (ms <= 0) return;
    const id = setTimeout(() => hideToast(active.id), ms);
    return () => clearTimeout(id);
  }, [active, anim]);

  if (!shown) return null;
  const t = shown;
  const tone: Tone = t.tone ?? "neutral";
  const icon = TOAST_ICON[tone];
  const tc = toneColors(tone);
  const action = t.action;

  return (
    <View pointerEvents="box-none" style={[styles.toastHost, { bottom: insets.bottom + 64 }]}>
      <Animated.View
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        style={[
          styles.toast,
          glow,
          {
            opacity: anim,
            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
          },
        ]}
      >
        <Pressable
          onPress={() => hideToast(t.id)}
          accessibilityRole="button"
          accessibilityLabel={t.message}
          accessibilityHint="Dismisses the message"
          style={styles.toastBody}
        >
          {icon ? <Ionicons name={icon} size={20} color={tc.fg} style={styles.toastIcon} /> : null}
          <Text maxFontSizeMultiplier={1.6} style={styles.toastText}>
            {t.message}
          </Text>
        </Pressable>
        {action ? (
          <Pressable
            onPress={() => {
              hideToast(t.id);
              action.onPress();
            }}
            hitSlop={{ top: 4, bottom: 4 }}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            style={({ pressed }) => [styles.toastAction, pressed ? styles.pressed : null]}
          >
            <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={styles.toastActionText}>
              {action.label}
            </Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </View>
  );
}

// ---------- Confirm store ----------
export type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel: string;
  /** default "Cancel" */
  cancelLabel?: string;
  destructive?: boolean;
};

type ConfirmRequest = ConfirmOptions & { id: number; resolve: (ok: boolean) => void };

let confirmQueue: ConfirmRequest[] = [];
let confirmSeq = 0;
const confirmListeners = new Set<() => void>();

function emitConfirm() {
  Array.from(confirmListeners).forEach((l) => l());
}

function subscribeConfirm(cb: () => void): () => void {
  confirmListeners.add(cb);
  return () => {
    confirmListeners.delete(cb);
  };
}

function confirmHead(): ConfirmRequest | null {
  return confirmQueue.length > 0 ? confirmQueue[0] : null;
}

function settleConfirm(id: number, ok: boolean) {
  const req = confirmQueue.find((r) => r.id === id);
  if (!req) return;
  confirmQueue = confirmQueue.filter((r) => r.id !== id);
  emitConfirm();
  req.resolve(ok);
}

/** Ask for confirmation in a bottom sheet. Resolves true on confirm, false on cancel / dismiss. */
export function confirm(o: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    confirmSeq += 1;
    confirmQueue = [...confirmQueue, { ...o, id: confirmSeq, resolve }];
    emitConfirm();
  });
}

// ---------- ConfirmHost ----------
/** Mount once at the app root; renders the pending `confirm()` request. */
export function ConfirmHost() {
  const head = useSyncExternalStore(subscribeConfirm, confirmHead, confirmHead);
  // Keep the last request's text on screen while the sheet animates out.
  const [last, setLast] = useState<ConfirmRequest | null>(head);
  if (head && head !== last) setLast(head);
  const req = head ?? last;
  if (!req) return null;
  return (
    <ConfirmSheet
      visible={head !== null}
      onClose={() => {
        if (head) settleConfirm(head.id, false);
      }}
      onConfirm={() => {
        if (head) settleConfirm(head.id, true);
      }}
      title={req.title}
      message={req.message}
      confirmLabel={req.confirmLabel}
      cancelLabel={req.cancelLabel}
      destructive={req.destructive}
    />
  );
}

// ---------- styles ----------
const styles = StyleSheet.create({
  pressed: { opacity: 0.6 },
  toastHost: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    alignItems: "center",
    zIndex: 1000,
    elevation: 1000,
  },
  toast: {
    width: "100%",
    maxWidth: 560,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface2,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    minHeight: 48,
    paddingRight: spacing.xs,
    ...(Platform.OS === "ios" ? { borderCurve: "continuous" as const } : null),
  },
  toastBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: spacing.sm,
  },
  toastIcon: { marginRight: 10 },
  toastText: { flex: 1, fontSize: 15, lineHeight: 20, color: colors.ink },
  toastAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md },
  toastActionText: { fontSize: 15, fontWeight: "600", color: colors.purpleText },
});
