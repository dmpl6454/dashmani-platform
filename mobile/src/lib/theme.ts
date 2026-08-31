// Dashmani brand theme — matches the web portals (yellow #F5D547, purple #5B4BF5, ink #1A1A1A)
export const colors = {
  bg: "#FAF8F3", // cream background
  card: "#FFFFFF",
  ink: "#1A1A1A",
  sub: "#7A7A7A",
  faint: "#B5B0A6",
  border: "#EDE9E0",
  yellow: "#F5D547",
  yellowSoft: "#FBF3D0",
  purple: "#5B4BF5",
  purpleDark: "#3023D0",
  purpleSoft: "#EDEBFE",
  green: "#16A34A",
  greenSoft: "#DCFCE7",
  red: "#DC2626",
  redSoft: "#FEE2E2",
  amber: "#D97706",
  amberSoft: "#FEF3C7",
  blue: "#2563EB",
  blueSoft: "#DBEAFE",
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 8, md: 12, lg: 16, xl: 24, full: 999 };

/** Status → pill colors, shared across leaves/tasks/expenses/etc. */
export function statusColor(status: string): { bg: string; fg: string } {
  const s = (status || "").toUpperCase();
  if (["APPROVED", "DONE", "PAID", "RESOLVED", "ACTIVE", "PRESENT", "SENT"].includes(s))
    return { bg: colors.greenSoft, fg: colors.green };
  if (["PENDING", "IN_PROGRESS", "IN_REVIEW", "TODO", "OPEN", "DRAFT", "LATE", "HALF_DAY"].includes(s))
    return { bg: colors.amberSoft, fg: colors.amber };
  if (["REJECTED", "CANCELLED", "ABSENT", "CLOSED", "CRITICAL"].includes(s))
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
