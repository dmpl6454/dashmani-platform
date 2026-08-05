/**
 * Department colour map — single source of truth shared by jobs listing
 * and job-detail pages. Kept as named hex constants (not inline style
 * literals) so they're easy to audit and update in one place.
 */
export const DEPT_COLORS: Record<string, string> = {
  design: "#1338BE",
  social: "#C9882A",
  content: "#2F7F5A",
  video: "#6D4DC9",
  engineering: "#1F8FA8",
  web: "#1F8FA8",
  strategy: "#B05429",
  production: "#B43E70",
  marketing: "#B05429",
  hr: "#B43E70",
  operations: "#B43E70",
};

export function getDeptColor(dept?: string): string {
  if (!dept) return DEPT_COLORS.design;
  const lower = dept.toLowerCase();
  const key = Object.keys(DEPT_COLORS).find((k) => lower.includes(k));
  return key ? DEPT_COLORS[key] : DEPT_COLORS.design;
}
