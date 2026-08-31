// Dashmani design system — Apple HIG-inspired dark theme.
// iOS system grays, typography-first hierarchy, ONE tint, color used sparingly
// and semantically. The brand aurora lives in the logo/login/heroes only —
// never smeared across controls.
//
// ⚠️ `ink` is the PRIMARY TEXT color (label). Never use it as a background.
// Text on a solid tint/gold surface uses `inkOnAccent`.
export const colors = {
  // iOS dark system grouped backgrounds
  bg: "#000000",
  card: "#1C1C1E", // secondarySystemGroupedBackground
  cardHigh: "#2C2C2E", // tertiary — inputs, sheets
  // labels
  ink: "#FFFFFF",
  sub: "rgba(235,235,245,0.6)", // secondaryLabel
  faint: "rgba(235,235,245,0.3)", // tertiaryLabel
  // hairlines
  border: "rgba(84,84,88,0.36)", // separator (non-opaque)
  borderStrong: "rgba(84,84,88,0.65)",
  inkOnAccent: "#0B0B0F",
  // THE tint — brand violet, used like iOS systemBlue
  purple: "#7C6CFF",
  purpleDark: "#5B4BF5",
  purpleSoft: "rgba(124,108,255,0.16)",
  // semantic system colors (iOS dark values)
  green: "#30D158",
  greenSoft: "rgba(48,209,88,0.14)",
  red: "#FF453A",
  redSoft: "rgba(255,69,58,0.14)",
  amber: "#FFD60A",
  amberSoft: "rgba(255,214,10,0.12)",
  blue: "#0A84FF",
  blueSoft: "rgba(10,132,255,0.14)",
  // brand (logo) hues — reserved for identity surfaces
  yellow: "#FF9F0A", // system orange stands in for brand gold accents
  yellowSoft: "rgba(255,159,10,0.13)",
  pink: "#FF375F",
  pinkSoft: "rgba(255,55,95,0.13)",
  /** Primary action fill — a single solid tint, like an iOS filled button */
  gradient: ["#7C6CFF", "#6A59F2"] as [string, string],
  /** Brand aurora — logo badge / identity moments ONLY */
  gradientBrand: ["#F9A64A", "#F0568C", "#A06AF0", "#64AEF0"] as [string, string, string, string],
  gradientGold: ["#FFB340", "#FF9F0A"] as [string, string],
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

/** Kept for API compatibility — subtle now. */
export const glow = {
  shadowColor: "#000",
  shadowOpacity: 0.3,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 4 },
  elevation: 3,
};

/** Status → restrained tinted pill (13pt medium on 12–14% tint). */
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
