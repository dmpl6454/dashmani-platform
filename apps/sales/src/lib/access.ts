import type { StaffUser } from "./types";

/**
 * Who may use the sales portal: the Sales role, or an Admin / Super Admin. Mirrors the API's
 * `sales.*` permission grants (packages/db/prisma/seed.ts) — the API is the real gate; this
 * only decides whether to show the portal or the "not for your role" screen.
 */
type RoleLike = string | { name?: string; role?: { name?: string } };

export function roleNames(user: { roles?: unknown } | null | undefined): string[] {
  const roles = Array.isArray(user?.roles) ? (user!.roles as RoleLike[]) : [];
  return roles
    .map((r) => (typeof r === "string" ? r : r?.name ?? r?.role?.name ?? ""))
    .map((n) => String(n).trim().toLowerCase())
    .filter(Boolean);
}

export function isSalesUser(user: StaffUser | null | undefined): boolean {
  const names = roleNames(user);
  return names.some((n) => n === "sales" || n === "admin" || n === "super admin");
}

export function isAdminUser(user: StaffUser | null | undefined): boolean {
  return roleNames(user).some((n) => n === "admin" || n === "super admin");
}
