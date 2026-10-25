// The portal's "channels", in rail order. Shared by the rail (labels, badges)
// and the channel-surf layer (arrow keys, digits, the static flash).
export const NAV_CHANNELS = [
  { id: "dashboard", href: "/dashboard", label: "Home",      key: "d" },
  { id: "campaigns", href: "/campaigns", label: "Campaigns", key: "m" },
  { id: "projects",  href: "/projects",  label: "Projects",  key: "p" },
  { id: "content",   href: "/content",   label: "Content",   key: "c" },
  { id: "approvals", href: "/approvals", label: "Approvals", key: "a" },
  { id: "analytics", href: "/analytics", label: "Analytics", key: "n" },
  { id: "files",     href: "/files",     label: "Files",     key: "f" },
] as const;

export const pad2 = (n: number) => String(n).padStart(2, "0");

export function channelIndex(pathname: string | null): number {
  if (!pathname) return -1;
  return NAV_CHANNELS.findIndex((c) => pathname === c.href || pathname.startsWith(c.href + "/"));
}
