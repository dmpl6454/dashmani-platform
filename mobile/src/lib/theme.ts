// Dashmani "Midnight Glass" design system — cinematic dark theme.
// Deep-space indigo ground, liquid-glass surfaces, gold + violet light accents
// (matches the Seedance-generated hero visuals in assets/visuals/).
//
// ⚠️ Token semantics: `ink` is the PRIMARY TEXT color (light on dark). Never use
// it as a background. Text sitting on a solid gold/light accent surface must use
// `inkOnAccent` (always-dark) instead.
export const colors = {
  bg: "#0A0913", // deep space
  card: "#14121F", // elevated glass panel
  cardHigh: "#1B1830", // higher elevation (modals, inputs)
  ink: "#F2F0FA", // primary text
  sub: "#9A94B8", // secondary text
  faint: "#5C5776", // tertiary / placeholders
  border: "rgba(255,255,255,0.07)",
  borderStrong: "rgba(255,255,255,0.14)",
  /** Always-dark text for use ON gold/light accent surfaces */
  inkOnAccent: "#131118",
  // Brand aurora (from the Dashmani Media logo): orange → pink → purple → blue
  yellow: "#F9A64A", // brand orange (token name kept for compatibility)
  yellowSoft: "rgba(249,166,74,0.14)",
  pink: "#F0568C",
  pinkSoft: "rgba(240,86,140,0.14)",
  purple: "#8B7CFF", // brightened for dark-bg contrast
  purpleDark: "#5B4BF5",
  purpleSoft: "rgba(139,124,255,0.16)",
  green: "#4ADE80",
  greenSoft: "rgba(74,222,128,0.13)",
  red: "#F87171",
  redSoft: "rgba(248,113,113,0.13)",
  amber: "#FBBF24",
  amberSoft: "rgba(251,191,36,0.13)",
  blue: "#60A5FA",
  blueSoft: "rgba(96,165,250,0.13)",
  /** Primary action gradient (buttons, active states) — brand pink → violet */
  gradient: ["#F0568C", "#8B5CF6"] as [string, string],
  /** Full brand aurora — logo badge, hero accents */
  gradientBrand: ["#F9A64A", "#F0568C", "#A06AF0", "#64AEF0"] as [string, string, string, string],
  /** Gold gradient (secondary/celebratory) */
  gradientGold: ["#F9BE6E", "#F9A64A"] as [string, string],
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 10, md: 14, lg: 18, xl: 26, full: 999 };

/** Soft glow shadow for elevated glass surfaces */
export const glow = {
  shadowColor: "#8B7CFF",
  shadowOpacity: 0.18,
  shadowRadius: 16,
  shadowOffset: { width: 0, height: 6 },
  elevation: 6,
};

/** Status → pill colors, shared across leaves/tasks/expenses/etc. */
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
