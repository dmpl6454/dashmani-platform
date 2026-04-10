"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useOverviewStats } from "@/lib/hooks/use-analytics";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import {
  LayoutDashboard, Users, ClipboardList, FileText, Briefcase, FolderKanban,
  BarChart3, Clock, LogOut, Settings, Menu, X, Bell, MonitorSmartphone,
  Wallet, CheckSquare, Upload, FileSignature, Calendar, Bug, BriefcaseBusiness, Sparkles,
  CheckCheck, BellOff, Laptop, UserPlus, GraduationCap, AlertCircle,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/employees", label: "People", icon: Users },
  { href: "/teams", label: "Teams", icon: Users },
  { href: "/tasks", label: "Tasks", icon: ClipboardList },
  { href: "/content", label: "Content", icon: FileText },
  { href: "/accounts", label: "Accounts", icon: MonitorSmartphone },
  { href: "/clients", label: "Clients", icon: Briefcase },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/attendance", label: "Attendance", icon: Clock },
];

const moreItems = [
  { href: "/approvals", label: "Approvals", icon: CheckSquare },
  { href: "/salary-slips", label: "Salary Slips", icon: Wallet },
  { href: "/offer-letters", label: "Offer Letters", icon: FileSignature },
  { href: "/holidays", label: "Holidays", icon: Calendar },
  { href: "/jobs", label: "Job Listings", icon: BriefcaseBusiness },
  { href: "/bug-reports", label: "Bug Reports", icon: Bug },
  { href: "/ai-assistant", label: "AI Assistant", icon: Sparkles },
  { href: "/accounts/import", label: "Import Accounts", icon: Upload },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/workload", label: "Workload", icon: ClipboardList },
  { href: "/expenses", label: "Expenses", icon: Wallet },
  { href: "/devices", label: "Devices", icon: Laptop },
  { href: "/auto-teams", label: "Auto Teams", icon: UserPlus },
  { href: "/internships", label: "Internships", icon: GraduationCap },
  { href: "/complaints", label: "Complaints", icon: AlertCircle },
];

export function TopNav() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { data: statsData } = useOverviewStats();
  const pendingCount = (statsData as any)?.data?.pendingApprovalCount ?? 0;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  // Notification data
  const { data: countData, mutate: mutateCount } = useSWR(
    "/admin/notifications/count",
    (url: string) => apiFetch<any>(url),
    { refreshInterval: 15000 }
  );
  const unreadCount = countData?.data?.count ?? 0;

  const { data: notifsData, mutate: mutateNotifs } = useSWR(
    bellOpen ? "/admin/notifications" : null,
    (url: string) => apiFetch<any>(url)
  );
  const notifications = notifsData?.data || [];

  async function markAllRead() {
    try {
      await apiFetch("/admin/notifications/read-all", { method: "PUT" });
      mutateCount();
      mutateNotifs();
    } catch (e) { console.error(e); }
  }

  async function markOneRead(id: string) {
    try {
      await apiFetch(`/admin/notifications/${id}/read`, { method: "PUT" });
      mutateCount();
      mutateNotifs();
    } catch (e) { console.error(e); }
  }

  // Close bell dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false);
      }
    }
    if (bellOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [bellOpen]);

  function timeAgo(date: string) {
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  const allItems = [...navItems, ...moreItems];

  return (
    <nav className="sticky top-0 z-50 border-b border-[#F0EAD8] bg-[rgba(253,246,227,0.8)] backdrop-blur-xl">
      <div className="max-w-[1440px] mx-auto flex items-center justify-between px-4 md:px-8 py-3">
        {/* Logo */}
        <Link href="/dashboard" className="flex items-center gap-2.5 shrink-0">
          <img src="/logo.svg" alt="Digital Sukoon" className="h-9 w-9 rounded-full" />
          <div className="hidden sm:block">
            <span className="text-base font-bold text-[#1A1A1A] tracking-wide uppercase" style={{ fontFamily: "'DM Sans', sans-serif", letterSpacing: "2px", fontSize: "14px" }}>Digital Sukoon</span>
          </div>
        </Link>

        {/* Desktop Nav Pills */}
        <div className="hidden xl:flex items-center gap-0.5 bg-white/50 rounded-full p-1 backdrop-blur-md">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[13px] font-medium transition-all duration-250 ${
                  isActive
                    ? "bg-[#1A1A1A] text-white"
                    : "text-[#7A7A7A] hover:bg-[#FFF8E1] hover:border-[#FAE89E]"
                }`}
              >
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
                {item.href === "/approvals" && pendingCount > 0 && (
                  <span className="absolute -top-1 -right-1 h-4 w-4 flex items-center justify-center rounded-full bg-[#F5D547] text-[#1A1A1A] text-[9px] font-bold">{pendingCount}</span>
                )}
              </Link>
            );
          })}
          {/* More dropdown */}
          <div className="relative">
            <button
              onClick={() => setMoreOpen((v) => !v)}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[13px] font-medium transition-all ${
                moreItems.some(i => pathname.startsWith(i.href))
                  ? "bg-[#1A1A1A] text-white"
                  : "text-[#7A7A7A] hover:bg-[#FFF8E1]"
              }`}
            >
              More
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7"/></svg>
              {pendingCount > 0 && (
                <span className="absolute -top-1 -right-1 h-4 w-4 flex items-center justify-center rounded-full bg-[#F5D547] text-[#1A1A1A] text-[9px] font-bold">{pendingCount}</span>
              )}
            </button>
            {moreOpen && (
              <div className="absolute left-0 top-11 z-50 w-48 bg-white rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.12)] border border-[#E8E0D0] overflow-hidden p-1.5">
                {moreItems.map((item) => {
                  const isActive = pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMoreOpen(false)}
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                        isActive ? "bg-[#FFF3C4] text-[#1A1A1A] font-semibold" : "text-[#7A7A7A] hover:bg-[#FFF8E1]"
                      }`}
                    >
                      <item.icon className="h-4 w-4" />
                      {item.label}
                      {item.href === "/approvals" && pendingCount > 0 && (
                        <span className="ml-auto bg-[#F5D547] text-[#1A1A1A] text-[10px] font-bold px-1.5 py-0.5 rounded-full">{pendingCount}</span>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Section */}
        <div className="flex items-center gap-2">
          {/* Notification Bell */}
          <div className="relative" ref={bellRef}>
            <button
              onClick={() => setBellOpen((v) => !v)}
              className="relative p-2 rounded-full text-[#7A7A7A] hover:bg-white/60 transition-all"
            >
              <Bell className="h-5 w-5" />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 h-4.5 min-w-[18px] flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold px-1 animate-pulse">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </button>

            {bellOpen && (
              <div className="absolute right-0 top-12 z-50 w-80 bg-white rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.14)] border border-[#E8E0D0] overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-[#F0EAD8] bg-[#FEFCF7]">
                  <p className="text-sm font-semibold text-[#1A1A1A]">Notifications</p>
                  {unreadCount > 0 && (
                    <button onClick={markAllRead} className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium">
                      <CheckCheck className="h-3.5 w-3.5" />Mark all read
                    </button>
                  )}
                </div>
                <div className="max-h-[400px] overflow-y-auto divide-y divide-[#F0EAD8]">
                  {notifications.length === 0 ? (
                    <div className="p-8 text-center text-[#B0B0B0]">
                      <BellOff className="h-8 w-8 mx-auto mb-2 opacity-40" />
                      <p className="text-sm">No notifications yet</p>
                    </div>
                  ) : notifications.map((n: any) => (
                    <div
                      key={n.id}
                      onClick={() => { if (!n.read) markOneRead(n.id); }}
                      className={`px-4 py-3 cursor-pointer transition-colors hover:bg-[#FEFCF7] ${!n.read ? "bg-[rgba(245,213,71,0.06)]" : ""}`}
                    >
                      <div className="flex items-start gap-2">
                        {!n.read && <span className="mt-1.5 h-2 w-2 rounded-full bg-red-500 shrink-0" />}
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm ${!n.read ? "font-semibold text-[#1A1A1A]" : "text-[#7A7A7A]"}`}>{n.title}</p>
                          <p className="text-xs text-[#7A7A7A] mt-0.5 line-clamp-2">{n.message}</p>
                          <p className="text-[10px] text-[#B0B0B0] mt-1">{timeAgo(n.createdAt)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* User Avatar + Menu */}
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex items-center gap-2 p-1.5 rounded-full hover:bg-white/60 transition-all"
            >
              {user?.profileImageUrl ? (
                <img
                  src={user.profileImageUrl.startsWith("http") ? user.profileImageUrl : `${API_BASE}${user.profileImageUrl}`}
                  alt=""
                  className="h-8 w-8 rounded-full object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).nextElementSibling && ((e.target as HTMLImageElement).nextElementSibling as HTMLElement).style.removeProperty("display"); }}
                />
              ) : null}
              <div
                className="h-8 w-8 rounded-full flex items-center justify-center text-white font-semibold text-sm"
                style={{ background: "linear-gradient(135deg, #E8D5B7, #B8956A)", display: user?.profileImageUrl ? "none" : undefined }}
              >
                {user?.name?.charAt(0)?.toUpperCase() || "A"}
              </div>
              <span className="hidden md:block text-sm font-medium text-[#1A1A1A]">{user?.name?.split(" ")[0]}</span>
            </button>

            {userMenuOpen && (
              <div className="absolute right-0 top-12 z-50 w-56 bg-white rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.12)] border border-[#E8E0D0] overflow-hidden">
                <div className="px-4 py-3 border-b border-[#F0EAD8] bg-[#FEFCF7]">
                  <p className="text-sm font-semibold text-[#1A1A1A]">{user?.name}</p>
                  <p className="text-xs text-[#7A7A7A] truncate">{user?.email}</p>
                </div>
                <div className="p-1.5">
                  <Link
                    href="/settings"
                    onClick={() => setUserMenuOpen(false)}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-[#1A1A1A] hover:bg-[#FFF8E1] transition-colors"
                  >
                    <Settings className="h-4 w-4 text-[#7A7A7A]" />
                    Settings
                  </Link>
                  <button
                    onClick={() => { setUserMenuOpen(false); logout(); }}
                    className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm text-[#E74C3C] hover:bg-red-50 transition-colors"
                  >
                    <LogOut className="h-4 w-4" />
                    Log out
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Mobile Hamburger */}
          <button
            onClick={() => setMobileOpen((v) => !v)}
            className="xl:hidden p-2 rounded-lg hover:bg-white/60 transition-colors"
          >
            {mobileOpen ? <X className="h-5 w-5 text-[#1A1A1A]" /> : <Menu className="h-5 w-5 text-[#1A1A1A]" />}
          </button>
        </div>
      </div>

      {/* Mobile Nav */}
      {mobileOpen && (
        <div className="xl:hidden border-t border-[#F0EAD8] bg-white/95 backdrop-blur-xl px-4 py-3 space-y-1 max-h-[70vh] overflow-y-auto">
          {allItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-all ${
                  isActive
                    ? "bg-[#1A1A1A] text-white font-semibold"
                    : "text-[#7A7A7A] hover:bg-[#FFF8E1]"
                }`}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
                {item.href === "/approvals" && pendingCount > 0 && (
                  <span className="ml-auto bg-[#F5D547] text-[#1A1A1A] text-[10px] font-bold px-1.5 py-0.5 rounded-full">{pendingCount}</span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </nav>
  );
}
