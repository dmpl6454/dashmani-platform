// Dashmani core UI primitives — "2026 iOS" grouped-inset language.
//
// Every legacy export (Screen, Card, SectionTitle, StatusPill, Button, Field, Chips,
// Empty, Loading, ErrorBanner, SuccessBanner, Stat, SeeAll, Row, TrendBars, useApi)
// keeps its name and accepts its previous props; everything new is optional/additive.
//
// Rules applied throughout this file:
// - iOS continuous corners; every pressable has accessibilityRole + accessibilityState
//   and a 44 pt hit area (hitSlop when the visual is smaller).
// - Dynamic Type: every Text has maxFontSizeMultiplier (1.6 body/title/row text,
//   1.3 dense control labels); controls use minHeight + paddingVertical, never height.
// - Inputs and tracks read their background from SurfaceContext (page / card / sheet).
// - Text on the brand gradient uses `inkOnAccent` only.
import React, { createContext, forwardRef, useContext, useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  PixelRatio,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ColorValue,
  type KeyboardTypeOptions,
  type ReturnKeyTypeOptions,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Image } from "expo-image";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { API_BASE } from "@/lib/api";
import {
  colors,
  formatStatus,
  glow,
  isDark,
  radius,
  sizes,
  spacing,
  statusColor,
  tintColor,
  toneColors,
  type,
} from "@/lib/theme";
import type { TintKey, Tone } from "@/lib/theme";
import { SkeletonForm, SkeletonList, SkeletonRow, SkeletonStatRow } from "@/components/skeleton";

// ---------- re-exported data hooks (legacy home of useApi) ----------
export { useApi, useDebounce, invalidate, useInvalidation } from "@/lib/hooks/useApi";
export type { ApiStatus, UseApiOptions, UseApiResult, InvalidationKey } from "@/lib/hooks/useApi";

// ---------- shared helpers ----------
export type IoniconName = keyof typeof Ionicons.glyphMap;

/** iOS continuous ("squircle") corners where supported. */
const continuous: ViewStyle | null = Platform.OS === "ios" ? { borderCurve: "continuous" } : null;

const ZERO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

/** Safe-area insets that never throw (zero when no provider is mounted). */
function useInsets() {
  return useContext(SafeAreaInsetsContext) ?? ZERO_INSETS;
}

function isIcon(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(Ionicons.glyphMap, name);
}

/** Any string → a valid Ionicons name (falls back when the glyph does not exist). */
function iconName(name: string | undefined, fallback: IoniconName): IoniconName {
  if (name && isIcon(name)) return name as IoniconName;
  return fallback;
}

/** Screen-reader announcement; no-op on web and where unsupported. */
function announce(message: string) {
  if (Platform.OS === "web") return;
  if (typeof AccessibilityInfo.announceForAccessibility === "function") {
    AccessibilityInfo.announceForAccessibility(message);
  }
}

/** Base hues fail contrast as text on white; map them to their readable `*Text` token. */
function readableAccent(c: string): string {
  switch (c) {
    case colors.green:
      return colors.greenText;
    case colors.red:
      return colors.redText;
    case colors.amber:
    case colors.warning:
    case colors.yellow:
      return colors.warningText;
    case colors.purple:
    case colors.pink:
      return colors.purpleText;
    case colors.blue:
      return colors.blueText;
    default:
      return c;
  }
}

/** Warm tiles (yellow/orange) need a dark glyph, not white (HG-15). */
const WARM_TILES = new Set<string>([
  colors.yellow,
  colors.amber,
  colors.warning,
  colors.tint.orange,
  colors.tint.yellow,
  colors.gradient[0],
]);

// ---------- Surface context ----------
export type Surface = "page" | "card" | "sheet";
export const SurfaceContext = createContext<Surface>("page");

/** Input / track background for the surface a control sits on. */
export function surfaceInputBg(s: Surface): string {
  if (s === "sheet") return colors.inputOnSheet;
  if (s === "card") return colors.inputOnCard;
  return colors.inputOnPage;
}

/** True inside <Screen> (lets <Loading/> skip its own page padding). */
const InScreenContext = createContext(false);

// ---------- Screen ----------
export type ScreenProps = {
  children: React.ReactNode;
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  /** 16 pt page padding (default true). Ignored when scroll={false}: FlatList hosts pad their own content. */
  padded?: boolean;
  /** default true; false → plain View host for FlatList/SectionList screens */
  scroll?: boolean;
  /** sticky bottom bar (barBg, hairline top, padding 12) */
  footer?: React.ReactNode;
  /** adds insets.bottom under the footer (stack screens). Default false. */
  footerInset?: boolean;
  scrollRef?: React.RefObject<ScrollView | null>;
  /** keyboard insets + interactive dismiss (default true) */
  keyboard?: boolean;
  /** "stack" (default) → contentInsetAdjustmentBehavior automatic; "none" → never (headerless tab roots) */
  header?: "stack" | "none";
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Screen({
  children,
  onRefresh,
  refreshing,
  padded = true,
  scroll = true,
  footer,
  footerInset = false,
  scrollRef,
  keyboard = true,
  header = "stack",
  contentStyle,
  testID,
}: ScreenProps) {
  const insets = useInsets();
  const hasFooter = footer !== undefined && footer !== null && footer !== false;
  const pad = padded ? spacing.lg : 0;
  // iOS "automatic" already adds the home-indicator inset on stack screens.
  const bottomInset = hasFooter ? 0 : Platform.OS === "ios" && header === "stack" ? 0 : insets.bottom;

  const footerNode = hasFooter ? (
    <View style={[styles.footer, { paddingBottom: spacing.md + (footerInset ? insets.bottom : 0) }]}>{footer}</View>
  ) : null;

  const body = scroll ? (
    <ScrollView
      ref={scrollRef}
      style={styles.flex}
      contentContainerStyle={[{ padding: pad, paddingBottom: spacing.xl + bottomInset }, contentStyle]}
      contentInsetAdjustmentBehavior={header === "none" ? "never" : "automatic"}
      automaticallyAdjustKeyboardInsets={Platform.OS === "ios" && keyboard && !hasFooter}
      keyboardDismissMode={keyboard ? (Platform.OS === "ios" ? "interactive" : "on-drag") : "none"}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={!!refreshing}
            onRefresh={() => {
              void onRefresh();
            }}
            tintColor={colors.sub}
            colors={[colors.purple]}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, contentStyle]}>{children}</View>
  );

  const content = (
    <InScreenContext.Provider value={true}>
      {body}
      {footerNode}
    </InScreenContext.Provider>
  );

  if (hasFooter && Platform.OS === "ios") {
    return (
      <KeyboardAvoidingView behavior="padding" style={styles.page} testID={testID}>
        {content}
      </KeyboardAvoidingView>
    );
  }
  return (
    <View style={styles.page} testID={testID}>
      {content}
    </View>
  );
}

// ---------- Card ----------
export type CardVariant = "grouped" | "elevated" | "tinted" | "plain";
export type CardProps = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  variant?: CardVariant;
  tone?: Tone;
  onPress?: () => void;
  /** 16 pt padding (default true) */
  padded?: boolean;
  accessibilityLabel?: string;
  testID?: string;
};

export function Card({
  children,
  style,
  variant = "grouped",
  tone,
  onPress,
  padded = true,
  accessibilityLabel,
  testID,
}: CardProps) {
  const bg =
    variant === "plain" ? "transparent" : variant === "tinted" ? toneColors(tone ?? "brand").bg : colors.card;
  const base: StyleProp<ViewStyle> = [
    styles.card,
    continuous,
    { backgroundColor: bg, padding: padded ? spacing.lg : 0 },
    variant === "elevated" ? glow : null,
    style,
  ];

  if (onPress) {
    return (
      <SurfaceContext.Provider value="card">
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          accessibilityState={{ disabled: false }}
          testID={testID}
          style={[base, styles.cardPressable]}
        >
          {({ pressed }) => (
            <>
              {children}
              {pressed ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.pressOverlay]} /> : null}
            </>
          )}
        </Pressable>
      </SurfaceContext.Provider>
    );
  }

  return (
    <SurfaceContext.Provider value="card">
      <View style={base} accessibilityLabel={accessibilityLabel} testID={testID}>
        {children}
      </View>
    </SurfaceContext.Provider>
  );
}

// ---------- SectionTitle ----------
export type SectionTitleProps = {
  children: React.ReactNode;
  right?: React.ReactNode;
  /** "title" (default): 20/600 sentence case; "grouped": 13 pt uppercase secondary */
  variant?: "title" | "grouped";
  style?: StyleProp<ViewStyle>;
};

export function SectionTitle({ children, right, variant = "title", style }: SectionTitleProps) {
  const grouped = variant === "grouped";
  return (
    <View style={[styles.sectionRow, grouped ? styles.sectionRowGrouped : null, style]}>
      <Text
        accessibilityRole="header"
        maxFontSizeMultiplier={1.6}
        style={grouped ? styles.sectionGrouped : styles.sectionTitle}
      >
        {children}
      </Text>
      {right ? <View style={styles.sectionRight}>{right}</View> : null}
    </View>
  );
}

// ---------- StatusPill ----------
export type StatusPillProps = {
  status: string;
  label?: string;
  size?: "md" | "sm";
  /** leading dot (default true) */
  dot?: boolean;
};

export function StatusPill({ status, label, size = "md", dot = true }: StatusPillProps) {
  const c = statusColor(status);
  const text = label ?? formatStatus(status);
  const sm = size === "sm";
  return (
    <View
      accessible
      accessibilityLabel={text}
      style={[
        styles.pill,
        continuous,
        { backgroundColor: c.bg, minHeight: sm ? 18 : 22, paddingHorizontal: sm ? 7 : 9 },
      ]}
    >
      {dot ? <View style={[styles.pillDot, { backgroundColor: c.dot }]} /> : null}
      <Text
        maxFontSizeMultiplier={1.3}
        numberOfLines={1}
        style={[styles.pillText, { color: c.fg, fontSize: sm ? 11 : 12 }]}
      >
        {text}
      </Text>
    </View>
  );
}

// ---------- Button ----------
export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "tinted" | "plain" | "destructive";
export type ButtonSize = "lg" | "md" | "sm";
export type ButtonProps = {
  title: string;
  onPress: () => unknown;
  variant?: ButtonVariant;
  tone?: Tone;
  size?: ButtonSize;
  /** legacy alias of size "sm" */
  small?: boolean;
  loading?: boolean;
  disabled?: boolean;
  icon?: IoniconName;
  /** stretch to the container width (default true) */
  fullWidth?: boolean;
  /** applied to the OUTER Pressable (layout: margins, flex). A legacy backgroundColor becomes the fill. */
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
};

const BUTTON_FONT: Record<ButtonSize, number> = { lg: 17, md: 16, sm: 15 };

export function Button({
  title,
  onPress,
  variant = "primary",
  tone,
  size,
  small,
  loading = false,
  disabled = false,
  icon,
  fullWidth = true,
  style,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: ButtonProps) {
  const sz: ButtonSize = size ?? (small ? "sm" : "lg");
  const flat: ViewStyle = StyleSheet.flatten(style) ?? {};
  const { backgroundColor: legacyBg, ...outerStyle } = flat;
  const inactive = disabled || loading;
  const disabledLook = disabled && !loading;

  let fg: string = colors.ink;
  let bg: ColorValue | undefined;
  let border: string | undefined;
  let gradient = false;

  if (disabledLook) {
    bg = colors.cardHigh;
    fg = colors.sub;
  } else {
    switch (variant) {
      case "primary":
        if (legacyBg) bg = legacyBg;
        else gradient = true;
        fg = colors.inkOnAccent;
        break;
      case "secondary":
      case "tinted": {
        const t = toneColors(tone ?? "brand");
        bg = legacyBg ?? t.bg;
        fg = t.text;
        break;
      }
      case "danger": {
        const t = toneColors("danger");
        bg = legacyBg ?? t.bg;
        fg = t.text;
        break;
      }
      case "destructive":
        bg = legacyBg ?? "transparent";
        border = colors.borderStrong;
        fg = colors.redText;
        break;
      case "ghost":
      case "plain":
      default:
        bg = legacyBg ?? "transparent";
        border = colors.borderStrong;
        fg = tone ? toneColors(tone).text : colors.ink;
        break;
    }
  }

  const shape: StyleProp<ViewStyle> = [
    styles.btn,
    continuous,
    {
      minHeight: sizes.button[sz],
      borderRadius: sz === "sm" ? radius.md : radius.control,
      paddingHorizontal: sz === "sm" ? spacing.md : spacing.lg,
      paddingVertical: sz === "sm" ? 4 : 6,
    },
    bg !== undefined ? { backgroundColor: bg } : null,
    border ? { borderWidth: StyleSheet.hairlineWidth, borderColor: border } : null,
  ];

  const inner = loading ? (
    <ActivityIndicator color={fg} size="small" />
  ) : (
    <View style={styles.btnContent}>
      {icon ? <Ionicons name={icon} size={sz === "sm" ? 16 : 18} color={fg} style={styles.btnIcon} /> : null}
      <Text
        maxFontSizeMultiplier={1.3}
        numberOfLines={1}
        style={[styles.btnText, { color: fg, fontSize: BUTTON_FONT[sz] }]}
      >
        {title}
      </Text>
    </View>
  );

  return (
    <Pressable
      onPress={() => {
        void onPress();
      }}
      disabled={inactive}
      hitSlop={sz === "sm" ? { top: 4, bottom: 4 } : undefined}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      testID={testID}
      style={({ pressed }) => [
        { alignSelf: fullWidth ? "stretch" : "flex-start", opacity: pressed && !inactive ? 0.85 : 1 },
        outerStyle,
      ]}
    >
      {gradient ? (
        <LinearGradient colors={colors.gradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0.6 }} style={shape}>
          {inner}
        </LinearGradient>
      ) : (
        <View style={shape}>{inner}</View>
      )}
    </Pressable>
  );
}

// ---------- IconButton ----------
export type IconButtonProps = {
  icon: IoniconName;
  label: string;
  onPress: () => void;
  /** visual size (default 44) */
  size?: number;
  /** glyph size (default 22) */
  glyph?: number;
  tint?: string;
  variant?: "plain" | "tinted" | "filled";
  badge?: number | null;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function IconButton({
  icon,
  label,
  onPress,
  size = sizes.touch,
  glyph = 22,
  tint,
  variant = "plain",
  badge,
  disabled = false,
  style,
  testID,
}: IconButtonProps) {
  const bg = variant === "filled" ? colors.purple : variant === "tinted" ? colors.purpleSoft : "transparent";
  const fg = tint ?? (variant === "filled" ? colors.inkOnAccent : variant === "tinted" ? colors.purpleText : colors.ink);
  const slop = size < sizes.touch ? Math.ceil((sizes.touch - size) / 2) : undefined;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={slop}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      testID={testID}
      style={({ pressed }) => [
        styles.iconBtn,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: bg },
        { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 },
        style,
      ]}
    >
      <Ionicons name={icon} size={glyph} color={fg} />
      {badge ? (
        <View style={styles.iconBtnBadge} pointerEvents="none">
          <Badge value={badge} />
        </View>
      ) : null}
    </Pressable>
  );
}

// ---------- Badge ----------
export type BadgeProps = {
  value?: number | string;
  /** default "danger" */
  tone?: Tone;
  /** 8 pt dot instead of a count */
  dot?: boolean;
  /** default 99 → "99+" */
  max?: number;
  accessibilityLabel?: string;
};

export function Badge({ value, tone = "danger", dot = false, max = 99, accessibilityLabel }: BadgeProps) {
  const bg = tone === "neutral" ? colors.sub : toneColors(tone).fg;
  if (dot) {
    return (
      <View
        accessible
        accessibilityLabel={accessibilityLabel ?? "New"}
        style={[styles.badgeDot, { backgroundColor: bg }]}
      />
    );
  }
  const text = typeof value === "number" && value > max ? `${max}+` : String(value ?? "");
  return (
    <View accessible accessibilityLabel={accessibilityLabel ?? text} style={[styles.badge, { backgroundColor: bg }]}>
      <Text maxFontSizeMultiplier={1.3} style={styles.badgeText} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

// ---------- Avatar ----------
export type AvatarProps = {
  name: string;
  uri?: string | null;
  /** default 40 */
  size?: number;
  /** 2 pt brand-gradient ring */
  ring?: boolean;
};

function resolveUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  if (/^(https?:|data:|file:|blob:)/i.test(uri)) return uri;
  return `${API_BASE}${uri.startsWith("/") ? "" : "/"}${uri}`;
}

export function Avatar({ name, uri, size = sizes.avatar, ring = false }: AvatarProps) {
  const surface = useContext(SurfaceContext);
  const initials =
    name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join("") || "?";
  const src = resolveUri(uri);
  const face = ring ? size - 8 : size;
  const faceNode = src ? (
    <Image source={{ uri: src }} style={{ width: face, height: face, borderRadius: face / 2 }} contentFit="cover" />
  ) : (
    <View style={[styles.avatarFallback, { width: face, height: face, borderRadius: face / 2 }]}>
      <Text maxFontSizeMultiplier={1.3} style={[styles.avatarText, { fontSize: Math.max(11, Math.round(face * 0.38)) }]}>
        {initials}
      </Text>
    </View>
  );

  if (!ring) {
    return (
      <View accessible accessibilityRole="image" accessibilityLabel={name}>
        {faceNode}
      </View>
    );
  }
  const gap = surface === "page" ? colors.bg : surface === "sheet" ? colors.surface2 : colors.card;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={name}>
      <LinearGradient
        colors={colors.gradientBrand}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.center, { width: size, height: size, borderRadius: size / 2 }]}
      >
        <View
          style={[styles.center, { width: size - 4, height: size - 4, borderRadius: (size - 4) / 2, backgroundColor: gap }]}
        >
          {faceNode}
        </View>
      </LinearGradient>
    </View>
  );
}

// ---------- Field ----------
export type FieldProps = {
  label?: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  multiline?: boolean;
  keyboardType?: KeyboardTypeOptions;
  error?: string | null;
  hint?: string;
  /** DEFAULT "none" (unchanged) */
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  autoCorrect?: boolean;
  textContentType?: TextInputProps["textContentType"];
  autoComplete?: TextInputProps["autoComplete"];
  inputMode?: TextInputProps["inputMode"];
  returnKeyType?: ReturnKeyTypeOptions;
  onSubmitEditing?: () => void;
  blurOnSubmit?: boolean;
  onBlur?: () => void;
  onFocus?: () => void;
  editable?: boolean;
  maxLength?: number;
  leading?: IoniconName;
  trailing?: React.ReactNode;
  /** with secureTextEntry: 44 pt eye button "Show password" / "Hide password" */
  revealToggle?: boolean;
  required?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
  testID?: string;
};

export const Field = forwardRef<TextInput, FieldProps>(function Field(
  {
    label,
    value,
    onChangeText,
    placeholder,
    secureTextEntry,
    multiline,
    keyboardType,
    error,
    hint,
    autoCapitalize = "none",
    autoCorrect,
    textContentType,
    autoComplete,
    inputMode,
    returnKeyType,
    onSubmitEditing,
    blurOnSubmit,
    onBlur,
    onFocus,
    editable = true,
    maxLength,
    leading,
    trailing,
    revealToggle,
    required,
    accessibilityLabel,
    style,
    inputStyle,
    testID,
  },
  ref,
) {
  const surface = useContext(SurfaceContext);
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (error) announce(error);
  }, [error]);

  const secure = !!secureTextEntry && !revealed;
  const showReveal = !!secureTextEntry && !!revealToggle;
  const borderColor = error ? colors.red : focused ? colors.purple : colors.border;
  const borderWidth = error || focused ? 1.5 : StyleSheet.hairlineWidth;
  const a11yLabel = (accessibilityLabel ?? label ?? placeholder ?? "") + (required ? ", required" : "");

  return (
    <View style={[styles.field, style]}>
      {label ? (
        <Text maxFontSizeMultiplier={1.6} style={styles.fieldLabel}>
          {label}
          {required ? <Text style={styles.fieldRequired}> *</Text> : null}
        </Text>
      ) : null}
      <View
        style={[
          styles.inputWrap,
          continuous,
          {
            backgroundColor: surfaceInputBg(surface),
            borderColor,
            borderWidth,
            minHeight: multiline ? 92 : sizes.control,
            alignItems: multiline ? "flex-start" : "center",
            paddingRight: showReveal || trailing ? 2 : 14,
          },
          editable ? null : styles.inputDisabled,
        ]}
      >
        {leading ? (
          <Ionicons
            name={leading}
            size={sizes.iconGlyph}
            color={colors.sub}
            style={[styles.inputLeading, multiline ? styles.inputLeadingTop : null]}
          />
        ) : null}
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.faint}
          secureTextEntry={secure}
          multiline={multiline}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          autoCorrect={autoCorrect}
          textContentType={textContentType}
          autoComplete={autoComplete}
          inputMode={inputMode}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing ? () => onSubmitEditing() : undefined}
          submitBehavior={blurOnSubmit === undefined ? undefined : blurOnSubmit ? "blurAndSubmit" : "submit"}
          onFocus={() => {
            setFocused(true);
            onFocus?.();
          }}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          editable={editable}
          maxLength={maxLength}
          keyboardAppearance={isDark ? "dark" : "light"}
          selectionColor={colors.purple}
          maxFontSizeMultiplier={1.6}
          accessibilityLabel={a11yLabel || undefined}
          accessibilityHint={error ?? hint}
          accessibilityState={{ disabled: !editable }}
          testID={testID}
          style={[styles.input, multiline ? styles.inputMultiline : null, inputStyle]}
        />
        {trailing}
        {showReveal ? (
          <IconButton
            icon={revealed ? "eye-off-outline" : "eye-outline"}
            label={revealed ? "Hide password" : "Show password"}
            onPress={() => setRevealed((r) => !r)}
            glyph={20}
            tint={colors.sub}
          />
        ) : null}
      </View>
      {error ? (
        <Text maxFontSizeMultiplier={1.6} accessibilityLiveRegion="polite" style={styles.fieldError}>
          {error}
        </Text>
      ) : hint ? (
        <Text maxFontSizeMultiplier={1.6} style={styles.fieldHint}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
});

// ---------- SegmentedControl ----------
export type SegmentedControlProps<T extends string> = {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  labels?: Partial<Record<T, string>>;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  labels,
  disabled = false,
  style,
}: SegmentedControlProps<T>) {
  const surface = useContext(SurfaceContext);
  // Light: iOS tertiary fill so the white selected segment reads on every surface.
  const track = isDark ? surfaceInputBg(surface) : "rgba(118,118,128,0.12)";
  return (
    <View
      accessibilityRole="tablist"
      style={[styles.segTrack, continuous, { backgroundColor: track }, disabled ? styles.dimmed : null, style]}
    >
      {options.map((opt) => {
        const active = opt === value;
        const text = labels?.[opt] ?? formatStatus(opt);
        return (
          <Pressable
            key={opt}
            onPress={() => onChange(opt)}
            disabled={disabled}
            accessibilityRole="tab"
            accessibilityLabel={text}
            accessibilityState={{ selected: active, disabled }}
            style={[styles.segItem, continuous, active ? styles.segItemActive : null]}
          >
            <Text
              maxFontSizeMultiplier={1.3}
              numberOfLines={1}
              style={[styles.segText, active ? styles.segTextActive : null]}
            >
              {text}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------- Chips (auto: ≤4 → segmented, else wrapping pills) ----------
export type ChipsProps<T extends string> = {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  labels?: Partial<Record<T, string>>;
  counts?: Partial<Record<T, number | null>>;
  mode?: "auto" | "segmented" | "pills";
  /** wrap pills onto several lines (default true; falls back to a scroller at large text sizes) */
  wrap?: boolean;
  accessibilityLabel?: string;
};

export function Chips<T extends string>({
  options,
  value,
  onChange,
  labels,
  counts,
  mode = "auto",
  wrap = true,
  accessibilityLabel,
}: ChipsProps<T>) {
  const surface = useContext(SurfaceContext);
  const labelOf = (o: T): string => {
    const base = labels?.[o] ?? formatStatus(o);
    const n = counts?.[o];
    return n === undefined || n === null ? base : `${base} · ${n}`;
  };

  const segmented = mode === "segmented" || (mode === "auto" && options.length <= 4);
  if (segmented) {
    const computed: Partial<Record<T, string>> = {};
    options.forEach((o) => {
      computed[o] = labelOf(o);
    });
    return <SegmentedControl options={options} value={value} onChange={onChange} labels={computed} />;
  }

  const idleBg = surface === "page" ? colors.card : colors.cardHigh;
  const pills = options.map((opt) => {
    const active = opt === value;
    const text = labelOf(opt);
    return (
      <Pressable
        key={opt}
        onPress={() => onChange(opt)}
        hitSlop={{ top: 4, bottom: 4 }}
        accessibilityRole="radio"
        accessibilityLabel={text}
        accessibilityState={{ selected: active, checked: active }}
        style={({ pressed }) => [
          styles.chip,
          continuous,
          active
            ? { backgroundColor: colors.purpleSoft, borderColor: colors.purple }
            : { backgroundColor: idleBg, borderColor: colors.border },
          pressed ? styles.pressedDim : null,
        ]}
      >
        <Text
          maxFontSizeMultiplier={1.3}
          numberOfLines={1}
          style={[styles.chipText, active ? styles.chipTextActive : null]}
        >
          {text}
        </Text>
      </Pressable>
    );
  });

  const scroller = !wrap || PixelRatio.getFontScale() > 1.3;
  if (scroller) {
    const fade: [string, string] = [`${colors.bg}00`, colors.bg];
    return (
      <View style={styles.chipsBlock} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipScroller}
          contentContainerStyle={styles.chipScrollContent}
        >
          {pills}
        </ScrollView>
        {surface === "page" ? (
          <LinearGradient
            pointerEvents="none"
            colors={fade}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.chipFade}
          />
        ) : null}
      </View>
    );
  }
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={[styles.chipsBlock, styles.chipWrap]}
    >
      {pills}
    </View>
  );
}

// ---------- Empty state (only for a LOADED empty answer) ----------
export type EmptyProps = {
  // `string & {}` keeps editor autocompletion for icon names while accepting any string.
  // eslint-disable-next-line @typescript-eslint/ban-types
  icon?: IoniconName | (string & {});
  title?: string;
  text: string;
  action?: { label: string; onPress: () => void };
  compact?: boolean;
  /** default "neutral" */
  tone?: Tone;
};

export function Empty({ icon = "file-tray-outline", title, text, action, compact = false, tone = "neutral" }: EmptyProps) {
  const surface = useContext(SurfaceContext);
  const t = toneColors(tone);
  const circleBg = tone === "neutral" ? (surface === "page" ? colors.card : colors.cardHigh) : t.bg;
  const glyph = tone === "neutral" ? colors.sub : t.fg;
  const circle = compact ? 44 : 64;
  return (
    <View style={[styles.empty, compact ? styles.emptyCompact : null]}>
      <View style={[styles.center, { width: circle, height: circle, borderRadius: circle / 2, backgroundColor: circleBg }]}>
        <Ionicons name={iconName(icon, "file-tray-outline")} size={compact ? 22 : 30} color={glyph} />
      </View>
      {title ? (
        <Text maxFontSizeMultiplier={1.6} accessibilityRole="header" style={styles.emptyTitle}>
          {title}
        </Text>
      ) : null}
      <Text maxFontSizeMultiplier={1.6} style={styles.emptyText}>
        {text}
      </Text>
      {action ? (
        <View style={styles.emptyAction}>
          <Button title={action.label} onPress={action.onPress} variant="tinted" size="md" fullWidth={false} />
        </View>
      ) : null}
    </View>
  );
}

// ---------- Loading (skeleton by default) ----------
export type LoadingProps = {
  /** default "list" */
  variant?: "list" | "tiles" | "form" | "spinner";
  rows?: number;
  /** render without page chrome (default: true inside a Card/Sheet) */
  inline?: boolean;
};

export function Loading({ variant = "list", rows, inline }: LoadingProps = {}) {
  const surface = useContext(SurfaceContext);
  const inScreen = useContext(InScreenContext);
  const isInline = inline ?? surface !== "page";

  if (variant === "spinner") {
    return (
      <View
        accessible
        accessibilityLabel="Loading"
        accessibilityRole="progressbar"
        style={isInline ? styles.loadingInline : styles.loadingSpinnerPage}
      >
        <ActivityIndicator size="small" color={colors.sub} />
      </View>
    );
  }

  if (isInline) {
    const n = Math.max(1, Math.floor(rows ?? 3));
    return (
      <View accessible accessibilityLabel="Loading" accessibilityRole="progressbar">
        {Array.from({ length: n }, (_, i) => (
          <SkeletonRow key={i} lines={2} />
        ))}
      </View>
    );
  }

  let content: React.ReactNode;
  if (variant === "tiles") {
    content = (
      <>
        <SkeletonStatRow count={2} />
        <SkeletonList rows={rows ?? 3} />
      </>
    );
  } else if (variant === "form") {
    content = <SkeletonForm fields={rows ?? 3} />;
  } else {
    content = <SkeletonList rows={rows ?? 4} />;
  }
  return <View style={inScreen ? styles.loadingInScreen : styles.loadingPage}>{content}</View>;
}

// ---------- LoadFailed (a failed request — never an empty claim) ----------
export type LoadFailedProps = {
  error: string | null;
  code?: string | null;
  status?: number | null;
  onRetry?: () => void;
  compact?: boolean;
};

export function LoadFailed({ error, code, status, onRetry, compact = false }: LoadFailedProps) {
  const offline = code === "NETWORK_ERROR" || code === "TIMEOUT";
  const forbidden = status === 403;
  let icon: IoniconName = "alert-circle-outline";
  let title = "Couldn't load this";
  let text = error || "Something went wrong. Try again.";
  if (offline) {
    icon = "cloud-offline-outline";
    title = "You're offline or the server is unreachable";
    text = "Check your connection and try again.";
  } else if (forbidden) {
    icon = "lock-closed-outline";
    title = "You don't have access to this";
    text = error || "Ask an admin if you think you should.";
  }
  return (
    <View accessibilityRole="alert">
      <Empty
        icon={icon}
        title={title}
        text={text}
        tone={forbidden ? "neutral" : "danger"}
        compact={compact}
        action={!forbidden && onRetry ? { label: "Try again", onPress: onRetry } : undefined}
      />
    </View>
  );
}

// ---------- Banners ----------
export type ErrorBannerProps = {
  message: string | null | undefined;
  onRetry?: () => void;
  onDismiss?: () => void;
  details?: Array<{ field: string; message: string }>;
  style?: StyleProp<ViewStyle>;
};

export function ErrorBanner({ message, onRetry, onDismiss, details, style }: ErrorBannerProps) {
  useEffect(() => {
    if (message) announce(message);
  }, [message]);
  if (!message) return null;
  return (
    <View accessibilityRole="alert" style={[styles.banner, continuous, { backgroundColor: colors.redSoft }, style]}>
      <Ionicons name="alert-circle" size={20} color={colors.red} style={styles.bannerIcon} />
      <View style={styles.bannerBody}>
        <Text maxFontSizeMultiplier={1.6} style={[styles.bannerText, { color: colors.redText }]}>
          {message}
        </Text>
        {details && details.length > 0
          ? details.map((d, i) => (
              <Text key={`${d.field}-${i}`} maxFontSizeMultiplier={1.6} style={[styles.bannerDetail, { color: colors.redText }]}>
                {`• ${d.field}: ${d.message}`}
              </Text>
            ))
          : null}
      </View>
      {onRetry ? <IconButton icon="refresh" label="Try again" onPress={onRetry} glyph={20} tint={colors.redText} /> : null}
      {onDismiss ? <IconButton icon="close" label="Dismiss" onPress={onDismiss} glyph={20} tint={colors.redText} /> : null}
    </View>
  );
}

export type SuccessBannerProps = {
  message: string | null | undefined;
  /** hide after this many ms (default 4000; null = stay) */
  autoDismissMs?: number | null;
  onDismiss?: () => void;
  style?: StyleProp<ViewStyle>;
};

export function SuccessBanner({ message, autoDismissMs = 4000, onDismiss, style }: SuccessBannerProps) {
  const current = message ?? null;
  const [state, setState] = useState<{ msg: string | null; hidden: boolean }>({ msg: current, hidden: false });
  // A new message (including the same text after a reset to null) shows again.
  if (state.msg !== current) setState({ msg: current, hidden: false });

  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (!current) return;
    announce(current);
    if (!autoDismissMs) return;
    const id = setTimeout(() => {
      setState((s) => (s.msg === current ? { msg: s.msg, hidden: true } : s));
      onDismissRef.current?.();
    }, autoDismissMs);
    return () => clearTimeout(id);
  }, [current, autoDismissMs]);

  if (!current || (state.msg === current && state.hidden)) return null;
  return (
    <View accessibilityRole="alert" style={[styles.banner, continuous, { backgroundColor: colors.greenSoft }, style]}>
      <Ionicons name="checkmark-circle" size={20} color={colors.green} style={styles.bannerIcon} />
      <View style={styles.bannerBody}>
        <Text maxFontSizeMultiplier={1.6} style={[styles.bannerText, { color: colors.greenText }]}>
          {current}
        </Text>
      </View>
      <IconButton
        icon="close"
        label="Dismiss"
        glyph={20}
        tint={colors.greenText}
        onPress={() => {
          setState({ msg: current, hidden: true });
          onDismissRef.current?.();
        }}
      />
    </View>
  );
}

// ---------- Stat (compact left-aligned tile; StatTile in list.tsx is the full one) ----------
export type StatProps = {
  label: string;
  value: string | number;
  accent?: string;
  icon?: IoniconName;
  hint?: string;
  onPress?: () => void;
};

export function Stat({ label, value, accent, icon, hint, onPress }: StatProps) {
  const valueColor = accent ? readableAccent(accent) : colors.ink;
  const body = (
    <>
      <View style={styles.statHead}>
        {icon ? <Ionicons name={icon} size={15} color={accent ?? colors.sub} style={styles.statIcon} /> : null}
        <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={styles.statLabel}>
          {label}
        </Text>
        {onPress ? <Ionicons name="chevron-forward" size={13} color={colors.faint} /> : null}
      </View>
      <Text
        maxFontSizeMultiplier={1.3}
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[styles.statValue, { color: valueColor }]}
      >
        {value}
      </Text>
      {hint ? (
        <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={styles.statHint}>
          {hint}
        </Text>
      ) : null}
    </>
  );
  const a11y = `${label}, ${value}${hint ? `, ${hint}` : ""}`;
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityState={{ disabled: false }}
        style={({ pressed }) => [styles.stat, continuous, pressed ? styles.pressedDim : null]}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View accessible accessibilityLabel={a11y} style={[styles.stat, continuous]}>
      {body}
    </View>
  );
}

// ---------- SeeAll ----------
export function SeeAll({ onPress, label = "See All" }: { onPress: () => void; label?: string }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="link"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.seeAll, pressed ? styles.pressedDim : null]}
    >
      <Text maxFontSizeMultiplier={1.3} style={styles.seeAllText}>
        {label}
      </Text>
    </Pressable>
  );
}

// ---------- Row (legacy; restyled to the ListItem look) ----------
export type RowProps = {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  value?: string;
  onPress?: () => void;
  // `string & {}` keeps editor autocompletion for icon names while accepting any string.
  // eslint-disable-next-line @typescript-eslint/ban-types
  icon?: IoniconName | (string & {});
  iconColor?: string;
  tint?: TintKey | string;
  badge?: number | string;
  destructive?: boolean;
  disabled?: boolean;
  last?: boolean;
  accessibilityLabel?: string;
};

function rowGlyph(icon: string): IoniconName {
  const filled = icon.replace("-outline", "");
  if (isIcon(filled)) return filled as IoniconName;
  return iconName(icon, "ellipse");
}

export function Row({
  title,
  subtitle,
  right,
  value,
  onPress,
  icon,
  iconColor,
  tint,
  badge,
  destructive = false,
  disabled = false,
  last = false,
  accessibilityLabel,
}: RowProps) {
  const tileBg = tint ? tintColor(tint) : (iconColor ?? colors.purple);
  const glyphColor = WARM_TILES.has(tileBg) ? colors.inkOnAccent : "#FFFFFF";
  const hasBadge = badge !== undefined && badge !== 0 && badge !== "";

  const content = (
    <View style={[styles.row, disabled ? styles.dimmed : null]}>
      {icon ? (
        <View style={[styles.rowIcon, continuous, { backgroundColor: tileBg }]}>
          <Ionicons name={rowGlyph(String(icon))} size={sizes.iconGlyph} color={glyphColor} />
        </View>
      ) : null}
      <View style={[styles.rowBody, last ? styles.rowBodyLast : null]}>
        <View style={styles.rowText}>
          <Text
            maxFontSizeMultiplier={1.6}
            numberOfLines={1}
            style={[styles.rowTitle, destructive ? { color: colors.redText } : null]}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text maxFontSizeMultiplier={1.6} numberOfLines={2} style={styles.rowSub}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {value ? (
          <Text maxFontSizeMultiplier={1.6} numberOfLines={1} style={styles.rowValue}>
            {value}
          </Text>
        ) : null}
        {right}
        {hasBadge ? (
          <View style={styles.rowBadge}>
            <Badge value={badge} />
          </View>
        ) : null}
        {onPress ? (
          <Ionicons name="chevron-forward" size={sizes.chevron} color={colors.faint} style={styles.rowChevron} />
        ) : null}
      </View>
    </View>
  );

  if (!onPress) return content;
  const label =
    accessibilityLabel ??
    [title, subtitle, value, hasBadge ? `${badge} new` : undefined].filter((s): s is string => !!s).join(", ");
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => (pressed ? styles.pressOverlay : null)}
    >
      {content}
    </Pressable>
  );
}

// ---------- TrendBars ----------
export type TrendBarsProps = {
  data: number[];
  height?: number;
  tint?: string;
  accessibilityLabel?: string;
};

export function TrendBars({ data, height = 56, tint, accessibilityLabel }: TrendBarsProps) {
  const max = Math.max(...data, 1);
  const latest = data.length > 0 ? data[data.length - 1] : 0;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel ?? `Trend of ${data.length} values, latest ${latest}`}
      style={[styles.trend, { height }]}
    >
      {data.map((v, i) => (
        <View
          key={i}
          style={{
            flex: 1,
            height: Math.max(3, (v / max) * height),
            borderRadius: 2,
            backgroundColor: i === data.length - 1 ? (tint ?? colors.purple) : colors.chartMuted,
          }}
        />
      ))}
    </View>
  );
}

// ---------- styles ----------
const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { flex: 1, backgroundColor: colors.bg },
  center: { alignItems: "center", justifyContent: "center" },
  dimmed: { opacity: 0.5 },
  pressedDim: { opacity: 0.7 },
  pressOverlay: { backgroundColor: colors.pressOverlay },

  footer: {
    backgroundColor: colors.barBg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },

  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: spacing.lg,
    marginBottom: spacing.group,
  },
  cardPressable: { overflow: "hidden" },

  sectionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.section,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  sectionRowGrouped: { marginTop: spacing.lg, marginBottom: 6 },
  sectionTitle: { ...type.title3, color: colors.ink, flexShrink: 1 },
  sectionGrouped: {
    fontSize: 13,
    fontWeight: "400",
    color: colors.sub,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    flexShrink: 1,
  },
  sectionRight: { minHeight: sizes.touch, justifyContent: "center", marginLeft: spacing.sm },

  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  pillDot: { width: 6, height: 6, borderRadius: 3, marginRight: 5 },
  pillText: { fontWeight: "600" },

  btn: { alignItems: "center", justifyContent: "center" },
  btnContent: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  btnIcon: { marginRight: 6 },
  btnText: { fontWeight: "600" },

  iconBtn: { alignItems: "center", justifyContent: "center" },
  iconBtnBadge: { position: "absolute", top: 2, right: 2 },

  badge: {
    minWidth: 18,
    minHeight: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700", ...type.numeric },
  badgeDot: { width: 8, height: 8, borderRadius: 4 },

  avatarFallback: { backgroundColor: colors.purpleSoft, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.purpleText, fontWeight: "600" },

  field: { marginBottom: spacing.md },
  fieldLabel: { fontSize: 13, fontWeight: "500", color: colors.sub, marginBottom: 6, paddingLeft: 2 },
  fieldRequired: { color: colors.redText },
  inputWrap: {
    flexDirection: "row",
    borderRadius: radius.control,
    paddingLeft: 14,
  },
  inputDisabled: { opacity: 0.6 },
  inputLeading: { marginRight: 8 },
  inputLeadingTop: { marginTop: 14 },
  input: {
    flex: 1,
    fontSize: 17,
    color: colors.ink,
    paddingVertical: 12,
    minHeight: sizes.control - 2,
  },
  inputMultiline: { minHeight: 90, textAlignVertical: "top", paddingTop: 12 },
  fieldError: { color: colors.redText, fontSize: 13, marginTop: 6, paddingLeft: 2 },
  fieldHint: { color: colors.sub, fontSize: 13, marginTop: 6, paddingLeft: 2 },

  segTrack: {
    flexDirection: "row",
    minHeight: sizes.touch,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 3,
    marginBottom: spacing.md,
  },
  segItem: {
    flex: 1,
    minHeight: 36,
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: radius.control - 3,
    alignItems: "center",
    justifyContent: "center",
  },
  segItemActive: {
    backgroundColor: colors.segActiveBg,
    shadowColor: "#000",
    shadowOpacity: isDark ? 0.25 : 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  segText: { fontSize: 13, fontWeight: "500", color: colors.sub },
  segTextActive: { color: colors.ink, fontWeight: "600" },

  chipsBlock: { marginBottom: spacing.md },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipScroller: { flexGrow: 0 },
  chipScrollContent: { gap: 8, paddingRight: spacing.xl },
  chipFade: { position: "absolute", top: 0, bottom: 0, right: 0, width: 24 },
  chip: {
    minHeight: 36,
    paddingHorizontal: 14,
    paddingVertical: 6,
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { fontSize: 15, color: colors.ink },
  chipTextActive: { color: colors.purpleText, fontWeight: "600" },

  empty: { alignItems: "center", paddingVertical: 32, paddingHorizontal: spacing.lg },
  emptyCompact: { paddingVertical: spacing.lg },
  emptyTitle: { fontSize: 17, fontWeight: "600", color: colors.ink, marginTop: spacing.md, textAlign: "center" },
  emptyText: { fontSize: 15, color: colors.sub, marginTop: 6, textAlign: "center", lineHeight: 20 },
  emptyAction: { marginTop: spacing.lg, alignItems: "center" },

  loadingPage: { flex: 1, backgroundColor: colors.bg, padding: spacing.lg },
  loadingInScreen: { paddingTop: 0 },
  loadingSpinnerPage: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
    minHeight: 160,
  },
  loadingInline: { alignItems: "center", justifyContent: "center", paddingVertical: spacing.lg },

  banner: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.control,
    paddingLeft: 12,
    paddingRight: 4,
    paddingVertical: 6,
    minHeight: sizes.touch,
    marginBottom: spacing.md,
  },
  bannerIcon: { marginRight: 10 },
  bannerBody: { flex: 1, paddingVertical: 6, paddingRight: 8 },
  bannerText: { fontSize: 15, lineHeight: 20 },
  bannerDetail: { fontSize: 13, marginTop: 3 },

  stat: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    paddingVertical: 12,
    paddingHorizontal: 14,
    minHeight: 72,
    justifyContent: "center",
  },
  statHead: { flexDirection: "row", alignItems: "center" },
  statIcon: { marginRight: 5 },
  statLabel: { flex: 1, fontSize: 13, color: colors.sub },
  statValue: { fontSize: 22, fontWeight: "700", marginTop: 4, ...type.numeric },
  statHint: { fontSize: 12, color: colors.sub, marginTop: 2 },

  seeAll: { minHeight: sizes.touch, justifyContent: "center", paddingHorizontal: 4 },
  seeAllText: { fontSize: 15, fontWeight: "500", color: colors.purpleText },

  row: { flexDirection: "row", alignItems: "center", minHeight: sizes.rowMin },
  rowIcon: {
    width: sizes.iconTile,
    height: sizes.iconTile,
    borderRadius: radius.tile,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  rowBody: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    minHeight: sizes.rowMin,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowBodyLast: { borderBottomWidth: 0 },
  rowText: { flex: 1, minWidth: 0, paddingRight: 8 },
  rowTitle: { fontSize: 17, color: colors.ink },
  rowSub: { fontSize: 15, color: colors.sub, marginTop: 2 },
  rowValue: { fontSize: 15, color: colors.sub, marginRight: 6, maxWidth: "45%" },
  rowBadge: { marginRight: 6 },
  rowChevron: { marginLeft: 2 },

  trend: { flexDirection: "row", alignItems: "flex-end", gap: 3 },
});
