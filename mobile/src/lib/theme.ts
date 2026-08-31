// Dashmani design system — Apple HIG structure, Dashmani Media logo palette.
// TWO schemes, resolved from the system appearance at app launch:
//   light → white ground, colorful logo-gradient accents
//   dark  → night-black ground, the same gradients glowing on black
// The aurora (orange → pink → violet → blue, straight from the logo) powers
// primary actions, identity surfaces and accent moments in BOTH schemes.
//
// ⚠️ `ink` is the PRIMARY TEXT color. Never use it as a background. Text on a
// gradient/solid accent uses `inkOnAccent` (always near-black) or plain #fff.
import { Appearance } from "react-native";

const scheme = Appearance.getColorScheme?.() ?? "dark";
export const isDark = scheme !== "light";

// Brand hues lifted from the logo
const BRAND = {
  orange: "#F9A64A",
  pink: "#F0568C",
  violet: "#8B5CF6",
  blue: "#64AEF0",
};

const dark = {
  bg: "#000000",
  card: "#1C1C1E",
  cardHigh: "#2C2C2E",
  ink: "#FFFFFF",
  sub: "rgba(235,235,245,0.6)",
  faint: "rgba(235,235,245,0.3)",
  border: "rgba(84,84,88,0.36)",
  borderStrong: "rgba(84,84,88,0.65)",
  barBg: "rgba(16,16,18,0.94)",
  segActiveBg: "#636366",
  inkOnAccent: "#0B0B0F",
  purple: "#7C6CFF",
  purpleDark: "#5B4BF5",
  purpleSoft: "rgba(124,108,255,0.18)",
  green: "#30D158",
  greenSoft: "rgba(48,209,88,0.15)",
  red: "#FF453A",
  redSoft: "rgba(255,69,58,0.15)",
  amber: "#FFD60A",
  amberSoft: "rgba(255,214,10,0.13)",
  blue: "#0A84FF",
  blueSoft: "rgba(10,132,255,0.15)",
  yellow: BRAND.orange,
  yellowSoft: "rgba(249,166,74,0.15)",
  pink: BRAND.pink,
  pinkSoft: "rgba(240,86,140,0.15)",
};

const light = {
  bg: "#FFFFFF",
  card: "#F4F4F7", // grouped card on white
  cardHigh: "#EBEBF0", // inputs / sheets
  ink: "#0B0B0F",
  sub: "rgba(60,60,67,0.6)",
  faint: "rgba(60,60,67,0.3)",
  border: "rgba(60,60,67,0.16)",
  borderStrong: "rgba(60,60,67,0.29)",
  barBg: "rgba(255,255,255,0.94)",
  segActiveBg: "#FFFFFF",
  inkOnAccent: "#0B0B0F",
  purple: "#6A55F2", // brand violet, darkened for white-bg contrast
  purpleDark: "#5B4BF5",
  purpleSoft: "rgba(106,85,242,0.12)",
  green: "#34C759",
  greenSoft: "rgba(52,199,89,0.14)",
  red: "#FF3B30",
  redSoft: "rgba(255,59,48,0.12)",
  amber: "#FF9500",
  amberSoft: "rgba(255,149,0,0.13)",
  blue: "#007AFF",
  blueSoft: "rgba(0,122,255,0.12)",
  yellow: "#F59A38",
  yellowSoft: "rgba(249,166,74,0.16)",
  pink: "#E9447F",
  pinkSoft: "rgba(240,86,140,0.13)",
};

const palette = isDark ? dark : light;

export const colors = {
  ...palette,
  /** Primary action gradient — logo pink → violet, both schemes */
  gradient: [BRAND.pink, BRAND.violet] as [string, string],
  /** Full logo aurora — identity surfaces, hero accents, celebratory moments */
  gradientBrand: [BRAND.orange, BRAND.pink, "#A06AF0", BRAND.blue] as [string, string, string, string],
  gradientGold: ["#FFC066", BRAND.orange] as [string, string],
};

// Apple type scale (SF Pro renders natively on iOS)
export const type = {
  largeTitle: { fontSize: 32, fontWeight: "700" as const, letterSpacing: 0.2 },
  title2: { fontSize: 22, fontWeight: "700" as const },
  title3: { fontSize: 20, fontWeight: "600" as const },
  headline: { fontSize: 17, fontWeight: "600" as const },
  body: { fontSize: 17, fontWeight: "400" as const },
  callout: { fontSize: 16, fontWeight: "400" as const },
  subhead: { fontSize: 15, fontWeight: "400" as const },
  footnote: { fontSize: 13, fontWeight: "400" as const },
  caption: { fontSize: 12, fontWeight: "400" as const },
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

// iOS continuous-corner radii — grouped cards are 12, controls 10
export const radius = { sm: 8, md: 10, lg: 12, xl: 20, full: 999 };

/** Soft elevation for floating surfaces */
export const glow = {
  shadowColor: "#000",
  shadowOpacity: isDark ? 0.3 : 0.12,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 4 },
  elevation: 3,
};

/** Status → restrained tinted pill. */
export function statusColor(status: string): { bg: string; fg: string } {
  const s = (status || "").toUpperCase();
  if (["APPROVED", "DONE", "PAID", "RESOLVED", "ACTIVE", "PRESENT", "SENT", "HIRED", "ACCEPTED"].includes(s))
    return { bg: colors.greenSoft, fg: colors.green };
  if (["PENDING", "IN_PROGRESS", "IN_REVIEW", "TODO", "OPEN", "DRAFT", "LATE", "HALF_DAY", "REVIEWING", "RECEIVED"].includes(s))
    return { bg: colors.amberSoft, fg: colors.amber };
  if (["REJECTED", "CANCELLED", "ABSENT", "CLOSED", "CRITICAL", "WONT_FIX"].includes(s))
    return { bg: colors.redSoft, fg: colors.red };
  return { bg: colors.purpleSoft, fg: colors.purple };
}

/** UPPER_SNAKE_CASE → Title Case (mirrors packages/shared formatStatus) */
export function formatStatus(value: string): string {
  if (!value) return "";
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
