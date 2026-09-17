// Where a signed-in user lands. Admins get the /overview command centre, whose
// API is gated on an Admin or Super Admin role (see requireAdminRole on the API);
// everyone else lands on the classic dashboard their permissions can populate.
// Sending a non-admin to /overview would only greet them with a 403.

type RoleLike = string | { name?: string; role?: { name?: string } };

export function isAdminUser(user: { roles?: unknown } | null | undefined): boolean {
  const roles = Array.isArray(user?.roles) ? (user!.roles as RoleLike[]) : [];
  return roles.some((r) => {
    const name = typeof r === "string" ? r : r?.name ?? r?.role?.name ?? "";
    const n = String(name).trim().toLowerCase();
    return n === "admin" || n === "super admin";
  });
}

export function landingPathFor(user: { roles?: unknown } | null | undefined): string {
  return isAdminUser(user) ? "/overview" : "/dashboard";
}

export function storedUser(): { roles?: unknown; name?: string } | null {
  try {
    const raw = localStorage.getItem("user");
    return raw ? (JSON.parse(raw) as { roles?: unknown; name?: string }) : null;
  } catch {
    return null;
  }
}
