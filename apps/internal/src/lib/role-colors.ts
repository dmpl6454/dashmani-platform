export const ROLE_COLORS: Record<string, string> = {
  "super admin": "bg-red-50 text-red-700 border-red-200",
  admin: "bg-purple-50 text-purple-700 border-purple-200",
  manager: "bg-blue-50 text-blue-700 border-blue-200",
  editor: "bg-amber-50 text-amber-700 border-amber-200",
  designer: "bg-pink-50 text-pink-700 border-pink-200",
  developer: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

export function getRoleColor(roleName: string): string {
  const key = roleName?.toLowerCase();
  return ROLE_COLORS[key] ?? "bg-[#FFF8E1] text-[#1A1A1A] border-[#F0EAD8]";
}
