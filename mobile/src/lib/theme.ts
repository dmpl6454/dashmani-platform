// Dashmani design system — "2026 iOS" grouped-inset language, Dashmani logo palette.
// TWO schemes, resolved from the system appearance at app launch:
//   light → #F2F2F7 grouped ground + white cards
//   dark  → #000 ground + #1C1C1E cards
// The warm brand sweep (orange → pink, straight from the logo) is reserved for
// the single primary action per screen and identity accents (avatar ring).
// Everything else is tinted (soft background + deep text) or plain.
//
// ⚠️ `ink` is the PRIMARY TEXT color. Never use it as a background.
// ⚠️ Text drawn on the brand gradient (or any solid accent) uses `inkOnAccent`
//    ONLY — never white, never `ink`.
// ⚠️ Tinted text on a soft tint uses the matching `*Text` token (via
//    `toneColors`), never the base hue — the base hues fail contrast on white.
import { Appearance, type FontVariant } from "react-native";

const scheme = Appearance.getColorScheme?.() ?? "dark";
export const isDark = scheme !== "light";

// Brand hues lifted from the logo. ⚠️ Purple/violet is deliberately EXCLUDED
// from the UI palette (owner decision) — the tint is the logo PINK, gradients
// run warm orange → pink, and pink→blue blends are avoided because their
// midpoint reads as purple.
const BRAND = {
  orange: "#F9A64A",
  pink: "#F0568C",
  pinkDeep: "#D92E6E",
  blue: "#64AEF0",
};

/** System-style tint hues (nested under `colors.tint`). */
export type TintKey = "brand" | "blue" | "green" | "orange" | "red" | "pink" | "teal" | "gray" | "yellow" | "indigo";

const TINT_KEYS: readonly TintKey[] = ["brand", "blue", "green", "orange", "red", "pink", "teal", "gray", "yellow", "indigo"];

type Palette = {
  // ---- legacy keys (every one is read somewhere in mobile/src) ----
  bg: string;
  card: string;
  cardHigh: string;
  ink: string;
  sub: string;
  faint: string;
  border: string;
  borderStrong: string;
  barBg: string;
  segActiveBg: string;
  inkOnAccent: string;
  purple: string;
  purpleDark: string;
  purpleSoft: string;
  green: string;
  greenSoft: string;
  red: string;
  redSoft: string;
  amber: string;
  amberSoft: string;
  blue: string;
  blueSoft: string;
  yellow: string;
  yellowSoft: string;
  pink: string;
  pinkSoft: string;
  // ---- surfaces ----
  /** = card */
  surface1: string;
  /** sheets / modals */
  surface2: string;
  /** control sitting on a sheet */
  surface3: string;
  inputOnPage: string;
  inputOnCard: string;
  inputOnSheet: string;
  // ---- text ----
  /** secondary meta text ≥ 13 pt */
  tertiary: string;
  purpleText: string;
  greenText: string;
  redText: string;
  blueText: string;
  warningText: string;
  amberText: string;
  // ---- semantic ----
  warning: string;
  warningSoft: string;
  pressOverlay: string;
  scrim: string;
  skeleton: string;
  skeletonHi: string;
  chartMuted: string;
  tint: Record<TintKey, string>;
};

const dark: Palette = {
  bg: "#000000",
  card: "#1C1C1E",
  cardHigh: "#2C2C2E",
  ink: "#FFFFFF",
  sub: "rgba(235,235,245,0.6)",
  faint: "rgba(235,235,245,0.38)",
  border: "rgba(84,84,88,0.36)",
  borderStrong: "rgba(84,84,88,0.65)",
  barBg: "rgba(16,16,18,0.94)",
  segActiveBg: "#636366",
  inkOnAccent: "#0B0B0F",
  // ⚠️ token names kept for compatibility — these are the PINK tint now
  purple: "#F0568C",
  purpleDark: "#D92E6E",
  purpleSoft: "rgba(240,86,140,0.16)",
  green: "#30D158",
  greenSoft: "rgba(48,209,88,0.15)",
  red: "#FF453A",
  redSoft: "rgba(255,69,58,0.15)",
  // compat alias of `warning` (was a yellow in dark mode)
  amber: "#FF9F0A",
  amberSoft: "rgba(255,159,10,0.16)",
  blue: "#0A84FF",
  blueSoft: "rgba(10,132,255,0.15)",
  yellow: BRAND.orange,
  yellowSoft: "rgba(249,166,74,0.15)",
  pink: BRAND.pink,
  pinkSoft: "rgba(240,86,140,0.15)",

  surface1: "#1C1C1E",
  surface2: "#2C2C2E",
  surface3: "#3A3A3C",
  inputOnPage: "#1C1C1E",
  inputOnCard: "#2C2C2E",
  inputOnSheet: "#3A3A3C",

  tertiary: "rgba(235,235,245,0.5)",
  purpleText: "#F0568C",
  greenText: "#30D158",
  redText: "#FF453A",
  blueText: "#0A84FF",
  warningText: "#FF9F0A",
  amberText: "#FF9F0A",

  warning: "#FF9F0A",
  warningSoft: "rgba(255,159,10,0.16)",
  pressOverlay: "rgba(255,255,255,0.06)",
  scrim: "rgba(0,0,0,0.5)",
  skeleton: "rgba(235,235,245,0.08)",
  skeletonHi: "rgba(235,235,245,0.16)",
  chartMuted: "rgba(240,86,140,0.45)",
  tint: {
    brand: "#F0568C",
    blue: "#0A84FF",
    green: "#30D158",
    orange: "#FF9F0A",
    red: "#FF453A",
    pink: "#FF375F",
    teal: "#40C8E0",
    gray: "#98989D",
    yellow: "#FFD60A",
    indigo: "#5E5CE6",
  },
};

const light: Palette = {
  bg: "#F2F2F7", // grouped ground
  card: "#FFFFFF", // white grouped card
  cardHigh: "#F2F2F7", // control on a card
  ink: "#0B0B0F",
  sub: "#6C6C70", // ≥ 4.7:1 on white and on #F2F2F7
  faint: "rgba(60,60,67,0.45)", // decorative only (hairlines, placeholder glyphs)
  border: "rgba(60,60,67,0.18)",
  borderStrong: "rgba(60,60,67,0.29)",
  barBg: "rgba(249,249,249,0.94)",
  segActiveBg: "#FFFFFF",
  inkOnAccent: "#0B0B0F",
  // ⚠️ token names kept for compatibility — these are the PINK tint now
  purple: "#DB2E6E", // logo pink, deepened for white-bg contrast
  purpleDark: "#C02059",
  purpleSoft: "rgba(219,46,110,0.11)",
  green: "#34C759",
  greenSoft: "rgba(52,199,89,0.14)",
  red: "#FF3B30",
  redSoft: "rgba(255,59,48,0.12)",
  // compat alias of `warning`
  amber: "#FF9500",
  amberSoft: "rgba(255,149,0,0.14)",
  blue: "#007AFF",
  blueSoft: "rgba(0,122,255,0.12)",
  yellow: "#F59A38",
  yellowSoft: "rgba(249,166,74,0.16)",
  pink: "#E9447F",
  pinkSoft: "rgba(240,86,140,0.13)",

  surface1: "#FFFFFF",
  surface2: "#FFFFFF",
  surface3: "#F2F2F7",
  inputOnPage: "#FFFFFF",
  inputOnCard: "#F2F2F7",
  inputOnSheet: "#F2F2F7",

  tertiary: "#76767A",
  purpleText: "#C02059",
  greenText: "#136A31",
  redText: "#B3261E",
  blueText: "#0A5BBD",
  warningText: "#8A4B00",
  amberText: "#8A4B00",

  warning: "#FF9500",
  warningSoft: "rgba(255,149,0,0.14)",
  pressOverlay: "rgba(0,0,0,0.05)",
  scrim: "rgba(0,0,0,0.35)",
  skeleton: "rgba(60,60,67,0.10)",
  skeletonHi: "rgba(60,60,67,0.18)",
  chartMuted: "rgba(219,46,110,0.45)",
  tint: {
    brand: "#F0568C",
    blue: "#007AFF",
    green: "#34C759",
    orange: "#FF9500",
    red: "#FF3B30",
    pink: "#FF2D55",
    teal: "#30B0C7",
    gray: "#8E8E93",
    yellow: "#FFCC00",
    indigo: "#5856D6",
  },
};

const palette: Palette = isDark ? dark : light;

export const colors = {
  ...palette,
  /** Primary action gradient — logo orange → pink (no violet stop), both schemes.
   *  Label on it: `inkOnAccent` only. */
  gradient: [BRAND.orange, BRAND.pink] as [string, string],
  /** Warm brand sweep — identity accents (avatar ring). The full aurora lives only
   *  in the actual logo artwork; UI gradients stay purple-free. */
  gradientBrand: [BRAND.orange, BRAND.pink, BRAND.pinkDeep, BRAND.pink] as [string, string, string, string],
  gradientGold: ["#FFC066", BRAND.orange] as [string, string],
};

// Apple type scale (SF Pro renders natively on iOS)
export const type = {
  largeTitle: { fontSize: 34, fontWeight: "700" as const, letterSpacing: 0.2 },
  title1: { fontSize: 28, fontWeight: "700" as const },
  title2: { fontSize: 22, fontWeight: "700" as const },
  title3: { fontSize: 20, fontWeight: "600" as const },
  headline: { fontSize: 17, fontWeight: "600" as const },
  body: { fontSize: 17, fontWeight: "400" as const },
  callout: { fontSize: 16, fontWeight: "400" as const },
  subhead: { fontSize: 15, fontWeight: "400" as const },
  footnote: { fontSize: 13, fontWeight: "400" as const },
  caption: { fontSize: 12, fontWeight: "400" as const },
  caption2: { fontSize: 11, fontWeight: "400" as const },
  /** Spread into numeric text so digits line up (stat tiles, money, counts). */
  numeric: { fontVariant: ["tabular-nums"] as FontVariant[] },
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  /** gap between grouped sections */
  section: 24,
  /** gap inside a group (tiles in a grid) */
  group: 12,
  /** grouped-inset horizontal page margin */
  inset: 16,
};

// iOS continuous-corner radii — cards 16, controls 12, sheets 28
export const radius = {
  sm: 8,
  md: 10,
  lg: 12,
  xl: 20,
  full: 999,
  card: 16,
  control: 12,
  tile: 8,
  sheet: 28,
  pill: 999,
};

/** Fixed component metrics (pt). */
export const sizes = {
  touch: 44,
  control: 48,
  rowMin: 52,
  iconTile: 32,
  iconGlyph: 18,
  chevron: 16,
  icon: 20,
  avatar: 40,
  button: { lg: 50, md: 44, sm: 36 },
};

/** Durations (ms) and the shared spring for RN Animated. */
export const motion = {
  fast: 160,
  base: 240,
  slow: 360,
  spring: { friction: 9, tension: 80 },
};

/** Soft elevation for floating surfaces */
export const glow = {
  shadowColor: "#000",
  shadowOpacity: isDark ? 0.3 : 0.08,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 4 },
  elevation: 3,
};

function isTintKey(v: string): v is TintKey {
  return (TINT_KEYS as readonly string[]).includes(v);
}

/** Tint key → hue for the current scheme; any other string (a raw colour) is returned as-is. */
export function tintColor(v: TintKey | string): string {
  return isTintKey(v) ? colors.tint[v] : v;
}

export type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

/** Tone → { fg: base hue (icons, dots), bg: soft tint, text: readable text on bg }. Always defined. */
export function toneColors(tone: Tone): { fg: string; bg: string; text: string } {
  switch (tone) {
    case "neutral":
      return { fg: colors.ink, bg: colors.cardHigh, text: colors.ink };
    case "success":
      return { fg: colors.green, bg: colors.greenSoft, text: colors.greenText };
    case "warning":
      return { fg: colors.warning, bg: colors.warningSoft, text: colors.warningText };
    case "danger":
      return { fg: colors.red, bg: colors.redSoft, text: colors.redText };
    case "info":
      return { fg: colors.blue, bg: colors.blueSoft, text: colors.blueText };
    case "brand":
    default:
      return { fg: colors.purple, bg: colors.purpleSoft, text: colors.purpleText };
  }
}

const SUCCESS_STATUSES = ["APPROVED", "DONE", "PAID", "RESOLVED", "ACTIVE", "PRESENT", "SENT", "HIRED", "ACCEPTED"];
const WARNING_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "IN_REVIEW",
  "TODO",
  "OPEN",
  "DRAFT",
  "LATE",
  "HALF_DAY",
  "REVIEWING",
  "RECEIVED",
  "PENDING_APPROVAL",
  "ONBOARDING",
  "SUBMITTED",
  "SCHEDULED",
  "UNDER_REVIEW",
];
const DANGER_STATUSES = ["REJECTED", "CANCELLED", "ABSENT", "CLOSED", "CRITICAL", "WONT_FIX"];

/** Status enum → semantic tone. */
export function statusTone(status: string): Tone {
  const s = (status || "").toUpperCase();
  if (SUCCESS_STATUSES.includes(s)) return "success";
  if (WARNING_STATUSES.includes(s)) return "warning";
  if (DANGER_STATUSES.includes(s)) return "danger";
  return "brand";
}

/** Status → restrained tinted pill: `bg` soft tint, `fg` readable text, `dot` base hue. */
export function statusColor(status: string): { bg: string; fg: string; dot: string } {
  const t = toneColors(statusTone(status));
  return { bg: t.bg, fg: t.text, dot: t.fg };
}

/** UPPER_SNAKE_CASE → Title Case (mirrors packages/shared formatStatus) */
export function formatStatus(value: string): string {
  if (!value) return "";
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
