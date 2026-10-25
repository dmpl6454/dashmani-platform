/**
 * Who sees what in the internal portal.
 *
 * Most internal users see the whole portal. A user whose roles include
 * "HR Manager" but NOT Admin / Super Admin gets the HR-only portal: an HR home
 * at /hr, a sidebar of HR pages, and a redirect home from anything else.
 *
 * ⚠️ This is navigation, not security. The API enforces access on every route
 * (the HR Manager role holds only employees.*, attendance.*, teams.view and
 * roles.view, plus middleware/role-guard.ts). Hiding a page here only spares the
 * user a screen of 403s.
 */

export const HR_MANAGER_ROLE = "HR Manager";
/** Roles only an Admin may grant — mirrors PRIVILEGED_ROLE_NAMES in @dashmani/shared. */
const PRIVILEGED = new Set(["super admin", "admin", "hr manager"]);

type MaybeUser = { roles?: string[] | null } | null | undefined;

function names(user: MaybeUser): string[] {
  return (user?.roles ?? []).map((r) => String(r).toLowerCase());
}

export function isAdminUser(user: MaybeUser): boolean {
  const r = names(user);
  return r.includes("super admin") || r.includes("admin");
}

/** An HR Manager without Admin / Super Admin: gets the HR-only portal. */
export function isHrOnly(user: MaybeUser): boolean {
  return names(user).includes("hr manager") && !isAdminUser(user);
}

export function isPrivilegedRoleName(name: string | null | undefined): boolean {
  return PRIVILEGED.has(String(name ?? "").toLowerCase());
}

/** Where a user lands after sign-in. */
export function homePathFor(user: MaybeUser): string {
  return isHrOnly(user) ? "/hr" : "/dashboard";
}

/** Pages the HR-only portal serves. A prefix also covers its sub-pages. */
export const HR_PATHS: string[] = [
  "/hr",
  "/employees",
  "/attendance",
  "/leave",
  "/approvals",
  "/salary-slips",
  "/offer-letters",
  "/holidays",
  "/jobs",
  "/internships",
  "/expenses",
  "/devices",
  "/complaints",
  "/announcements",
  "/ai-assistant",
  "/settings",
];

/** Sub-pages of an HR path that are still admin-only. */
const HR_BLOCKED: string[] = ["/employees/add-admin"];

export function canAccessPath(user: MaybeUser, pathname: string): boolean {
  if (!isHrOnly(user)) return true;
  if (HR_BLOCKED.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return false;
  // An employee's link-performance page reads reports data, which HR cannot see.
  if (/^\/employees\/[^/]+\/performance(\/|$)/.test(pathname)) return false;
  return HR_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
