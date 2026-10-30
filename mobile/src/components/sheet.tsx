// Dashmani bottom sheets — a real iOS-style sheet built on RN Modal + Animated.
//
// Sheet: transparent Modal → fading scrim (tap = close) + panel that springs up
// (motion.spring). Drag the grabber/header down to dismiss (dy > 120 or vy > 0.8; native
// only — web closes via scrim / close button). Keyboard-aware (iOS padding), safe-area
// aware, max 88 % of the window, 28 pt top corners, surface2 background, provides
// SurfaceContext "sheet" so inputs inside pick the sheet input colour.
// While the keyboard is up the panel is capped to the space above it (below the status
// bar), so the header and the focused field never slide off the top of the screen; the
// body scrolls instead.
//
// PickerSheet: searchable list of choices (local filter, or debounced server search via
// onSearch); picking an item calls onSelect(item) and then onClose().
// ConfirmSheet: title + message + confirm / cancel buttons.
import React, { useContext, useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import type { KeyboardEvent } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { colors, motion, radius, spacing, type } from "@/lib/theme";
import type { TintKey } from "@/lib/theme";
import {
  Button,
  Empty,
  ErrorBanner,
  Field,
  IconButton,
  LoadFailed,
  SurfaceContext,
  type IoniconName,
} from "@/components/ui";
import { SkeletonList } from "@/components/skeleton";
import { useDebounce } from "@/lib/hooks/useApi";
import { ListGroup, ListItem } from "@/components/list";

const NATIVE_DRIVER = Platform.OS !== "web";
const ZERO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };
const DISMISS_DY = 120;
const DISMISS_VY = 0.8;
/** Gap kept between the status bar and a sheet squeezed by the keyboard. */
const KEYBOARD_TOP_GAP = 8;

/**
 * Height of the keyboard overlapping the bottom of the window (iOS only — that is where the
 * KeyboardAvoidingView below adds matching bottom padding). 0 when hidden or inactive.
 */
function useKeyboardOverlap(active: boolean, windowHeight: number): number {
  const [overlap, setOverlap] = useState(0);
  useEffect(() => {
    if (!active || Platform.OS !== "ios") {
      setOverlap(0);
      return;
    }
    const onShow = (e: KeyboardEvent) => {
      const { screenY, height } = e.endCoordinates;
      const fromScreenY = windowHeight - screenY;
      setOverlap(Math.max(0, Number.isFinite(fromScreenY) && screenY > 0 ? fromScreenY : height));
    };
    const onHide = () => setOverlap(0);
    const subs = [
      Keyboard.addListener("keyboardWillShow", onShow),
      Keyboard.addListener("keyboardWillChangeFrame", onShow),
      Keyboard.addListener("keyboardWillHide", onHide),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [active, windowHeight]);
  return overlap;
}

// ---------- Sheet ----------
export type SheetProps = {
  visible: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  /** pinned under the content (e.g. the primary action) */
  footer?: React.ReactNode;
  /** "auto" (default) sizes to content up to 88 %; "large" is always 88 % */
  detent?: "auto" | "large";
  /** content scrolls (default true) */
  scroll?: boolean;
  /** scrim tap / drag / close button / back button close the sheet (default true) */
  dismissable?: boolean;
  testID?: string;
};

export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  footer,
  detent = "auto",
  scroll = true,
  dismissable = true,
  testID,
}: SheetProps) {
  const insets = useContext(SafeAreaInsetsContext) ?? ZERO_INSETS;
  const { height } = useWindowDimensions();

  // Stay mounted while the close animation runs.
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);

  const keyboardOverlap = useKeyboardOverlap(mounted, height);

  const [translateY] = useState(() => new Animated.Value(Dimensions.get("window").height));
  const [scrim] = useState(() => new Animated.Value(0));

  const latest = useRef({ onClose, dismissable, visible });
  useEffect(() => {
    latest.current = { onClose, dismissable, visible };
  });

  useEffect(() => {
    if (!mounted) return;
    if (visible) {
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          friction: motion.spring.friction,
          tension: motion.spring.tension,
          useNativeDriver: NATIVE_DRIVER,
        }),
        Animated.timing(scrim, { toValue: 1, duration: 200, useNativeDriver: NATIVE_DRIVER }),
      ]).start();
      return;
    }
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: height,
        duration: motion.base,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: NATIVE_DRIVER,
      }),
      Animated.timing(scrim, { toValue: 0, duration: 200, useNativeDriver: NATIVE_DRIVER }),
    ]).start(({ finished }) => {
      if (finished) setMounted(false);
    });
  }, [visible, mounted, height, translateY, scrim]);

  const [pan] = useState(() => {
    const springBack = () => {
      Animated.spring(translateY, {
        toValue: 0,
        friction: motion.spring.friction,
        tension: motion.spring.tension,
        useNativeDriver: NATIVE_DRIVER,
      }).start();
    };
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => NATIVE_DRIVER && g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_e, g) => {
        translateY.setValue(Math.max(0, g.dy));
      },
      onPanResponderRelease: (_e, g) => {
        const l = latest.current;
        if (l.dismissable && (g.dy > DISMISS_DY || g.vy > DISMISS_VY)) {
          l.onClose();
          // The parent may refuse to close (e.g. busy): snap back if still visible.
          setTimeout(() => {
            if (latest.current.visible) springBack();
          }, 150);
          return;
        }
        springBack();
      },
      onPanResponderTerminate: () => springBack(),
    });
  });

  if (!mounted) return null;

  // 88 % of the window, but never taller than the room left above the keyboard (the KAV pads
  // the bottom by the keyboard height) minus the status bar — otherwise the panel overflows
  // upward and hides its header and the field being typed in.
  const fullHeight = Math.round(height * 0.88);
  const maxHeight =
    keyboardOverlap > 0
      ? Math.max(0, Math.min(fullHeight, Math.round(height - keyboardOverlap - insets.top - KEYBOARD_TOP_GAP)))
      : fullHeight;
  const bodyStyle = detent === "large" ? styles.bodyFill : styles.bodyAuto;
  const showHeaderRow = !!title || !!subtitle || dismissable;

  const body = scroll ? (
    <ScrollView
      style={bodyStyle}
      contentContainerStyle={styles.bodyContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[bodyStyle, styles.bodyContent]}>{children}</View>
  );

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={() => {
        if (dismissable) onClose();
      }}
    >
      <SurfaceContext.Provider value="sheet">
        <View style={styles.root}>
          <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: scrim }]}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={dismissable ? onClose : undefined}
              accessible={dismissable}
              accessibilityRole="button"
              accessibilityLabel="Close"
            />
          </Animated.View>
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            style={styles.kav}
            pointerEvents="box-none"
          >
            <Animated.View
              accessibilityViewIsModal
              testID={testID}
              style={[
                styles.panel,
                {
                  maxHeight,
                  paddingBottom: insets.bottom + spacing.lg,
                  transform: [{ translateY }],
                },
                detent === "large" ? { height: maxHeight } : null,
              ]}
            >
              <View {...pan.panHandlers} style={styles.header}>
                <View
                  style={styles.grabber}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                />
                {showHeaderRow ? (
                  <View style={styles.titleRow}>
                    <View style={styles.titleText}>
                      {title ? (
                        <Text accessibilityRole="header" maxFontSizeMultiplier={1.6} style={styles.title}>
                          {title}
                        </Text>
                      ) : null}
                      {subtitle ? (
                        <Text maxFontSizeMultiplier={1.6} style={styles.subtitle}>
                          {subtitle}
                        </Text>
                      ) : null}
                    </View>
                    {dismissable ? (
                      <IconButton
                        icon="close"
                        label="Close"
                        onPress={onClose}
                        size={30}
                        glyph={16}
                        tint={colors.sub}
                        style={styles.close}
                      />
                    ) : null}
                  </View>
                ) : null}
              </View>
              {body}
              {footer ? <View style={styles.footer}>{footer}</View> : null}
            </Animated.View>
          </KeyboardAvoidingView>
        </View>
      </SurfaceContext.Provider>
    </Modal>
  );
}

// ---------- PickerSheet ----------
export type PickerSheetProps<T> = {
  visible: boolean;
  onClose: () => void;
  title: string;
  items: T[];
  keyOf: (t: T) => string;
  labelOf: (t: T) => string;
  subtitleOf?: (t: T) => string | undefined;
  iconOf?: (t: T) => IoniconName | undefined;
  tintOf?: (t: T) => TintKey | string | undefined;
  selectedKey?: string | null;
  /** called with the picked item; the sheet then calls onClose() */
  onSelect: (t: T) => void;
  /** search field (default: on for server search or more than 10 items) */
  searchable?: boolean;
  /** server search (debounced 300 ms); when set, items are NOT filtered locally */
  onSearch?: (q: string) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyText?: string;
  /** sections; an item goes in the first group it matches, the rest are listed last */
  groups?: Array<{ title: string; match: (t: T) => boolean }>;
};

export function PickerSheet<T>({
  visible,
  onClose,
  title,
  items,
  keyOf,
  labelOf,
  subtitleOf,
  iconOf,
  tintOf,
  selectedKey,
  onSelect,
  searchable,
  onSearch,
  loading = false,
  error = null,
  onRetry,
  emptyText,
  groups,
}: PickerSheetProps<T>) {
  const [query, setQuery] = useState("");
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (visible && query) setQuery("");
  }

  const debounced = useDebounce(query.trim(), 300);
  const onSearchRef = useRef(onSearch);
  useEffect(() => {
    onSearchRef.current = onSearch;
  });
  const sentRef = useRef("");
  useEffect(() => {
    const fn = onSearchRef.current;
    if (!fn || debounced === sentRef.current) return;
    sentRef.current = debounced;
    fn(debounced);
  }, [debounced]);

  const showSearch = searchable ?? (!!onSearch || items.length > 10);
  const q = query.trim().toLowerCase();
  const shown =
    onSearch || !q
      ? items
      : items.filter(
          (it) =>
            labelOf(it).toLowerCase().includes(q) || (subtitleOf?.(it) ?? "").toLowerCase().includes(q),
        );

  const renderRow = (it: T) => {
    const k = keyOf(it);
    return (
      <ListItem
        key={k}
        title={labelOf(it)}
        subtitle={subtitleOf?.(it)}
        icon={iconOf?.(it)}
        tint={tintOf?.(it)}
        selected={selectedKey != null && k === selectedKey}
        chevron={false}
        onPress={() => {
          onSelect(it);
          onClose();
        }}
      />
    );
  };

  let content: React.ReactNode;
  if (shown.length === 0) {
    if (loading) {
      content = <SkeletonList rows={4} />;
    } else if (error) {
      content = <LoadFailed error={error} onRetry={onRetry} compact />;
    } else {
      content = (
        <Empty
          compact
          icon={q ? "search-outline" : "file-tray-outline"}
          text={emptyText ?? (q ? `No results for "${query.trim()}"` : "Nothing to choose from yet.")}
        />
      );
    }
  } else if (groups && groups.length > 0) {
    const used = new Set<string>();
    const sections = groups
      .map((g) => {
        const rows = shown.filter((it) => !used.has(keyOf(it)) && g.match(it));
        rows.forEach((it) => used.add(keyOf(it)));
        return { title: g.title, rows };
      })
      .filter((s) => s.rows.length > 0);
    const rest = shown.filter((it) => !used.has(keyOf(it)));
    content = (
      <>
        {sections.map((s) => (
          <ListGroup key={s.title} title={s.title}>
            {s.rows.map(renderRow)}
          </ListGroup>
        ))}
        {rest.length > 0 ? <ListGroup title={sections.length > 0 ? "Other" : undefined}>{rest.map(renderRow)}</ListGroup> : null}
      </>
    );
  } else {
    content = <ListGroup>{shown.map(renderRow)}</ListGroup>;
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title}
      detent={showSearch || items.length > 8 ? "large" : "auto"}
    >
      {showSearch ? (
        <Field
          value={query}
          onChangeText={setQuery}
          placeholder="Search"
          leading="search"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={`Search ${title}`}
        />
      ) : null}
      {error && shown.length > 0 ? <ErrorBanner message={error} onRetry={onRetry} /> : null}
      {content}
    </Sheet>
  );
}

// ---------- ConfirmSheet ----------
export type ConfirmSheetProps = {
  visible: boolean;
  onClose: () => void;
  title: string;
  message?: string;
  confirmLabel: string;
  /** default "Cancel" */
  cancelLabel?: string;
  destructive?: boolean;
  /** spinner on the confirm button; the sheet cannot be dismissed meanwhile */
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
};

export function ConfirmSheet({
  visible,
  onClose,
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  onConfirm,
}: ConfirmSheetProps) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title} scroll={false} dismissable={!busy}>
      {message ? (
        <Text maxFontSizeMultiplier={1.6} style={styles.confirmMessage}>
          {message}
        </Text>
      ) : null}
      <Button
        title={confirmLabel}
        onPress={onConfirm}
        variant={destructive ? "danger" : "primary"}
        loading={busy}
        style={styles.confirmPrimary}
      />
      <Button title={cancelLabel} onPress={onClose} variant="plain" disabled={busy} style={styles.confirmCancel} />
    </Sheet>
  );
}

// ---------- styles ----------
const styles = StyleSheet.create({
  root: { flex: 1 },
  scrim: { backgroundColor: colors.scrim },
  kav: { flex: 1, justifyContent: "flex-end" },
  panel: {
    width: "100%",
    maxWidth: 640,
    alignSelf: "center",
    // Shrink to the room the KAV leaves above the keyboard instead of overflowing upward.
    flexShrink: 1,
    backgroundColor: colors.surface2,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    overflow: "hidden",
    ...(Platform.OS === "ios" ? { borderCurve: "continuous" as const } : null),
  },
  header: { paddingTop: 6 },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: colors.borderStrong,
    marginBottom: 6,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    paddingBottom: spacing.sm,
    minHeight: 44,
  },
  titleText: { flex: 1, minWidth: 0, paddingRight: spacing.sm },
  title: { ...type.title3, color: colors.ink },
  subtitle: { fontSize: 15, color: colors.sub, marginTop: 2 },
  close: { backgroundColor: colors.surface3, marginRight: 7 },
  bodyAuto: { flexGrow: 0, flexShrink: 1 },
  bodyFill: { flex: 1 },
  bodyContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.sm },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  confirmMessage: { fontSize: 15, lineHeight: 20, color: colors.sub, marginBottom: spacing.lg },
  confirmPrimary: { marginTop: spacing.xs },
  confirmCancel: { marginTop: spacing.sm },
});
