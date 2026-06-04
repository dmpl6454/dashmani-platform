"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useHrAuth } from "@/lib/auth";
import { NotificationBell } from "./notification-bell";
import {
  LayoutDashboard, FileText, Clock, Trophy, Users, UserCircle,
  LogOut, Settings, Menu, X, PlaneTakeoff, Home, Gift, ListTodo, Receipt,
  Presentation, ClipboardList, Calendar, Timer, Award, AlertCircle, Building2,
  ScrollText, FileCheck, Bug, Wallet, FolderOpen, Mail, MoreHorizontal, CalendarCheck,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/report", label: "Report", icon: FileText },
  { href: "/history", label: "History", icon: Clock },
  { href: "/leaderboard", label: "Board", icon: Trophy },
  { href: "/team", label: "Team", icon: Users },
  { href: "/leave", label: "Leave", icon: PlaneTakeoff },
  { href: "/plan", label: "Daily Report", icon: ClipboardList },
];

const moreItems = [
  { href: "/wfh", label: "Work from Home", icon: Home },
  { href: "/comp-off", label: "Comp Off", icon: Gift },
  { href: "/tasks", label: "My Tasks", icon: ListTodo },
  { href: "/expenses", label: "Expense Claims", icon: Receipt },
  { href: "/presentations", label: "Presentations", icon: Presentation },
  { href: "/calendar", label: "Calendar", icon: Calendar },
  { href: "/extra-hours", label: "Extra Hours", icon: Timer },
  { href: "/reviews", label: "My Reviews", icon: Award },
  { href: "/salary-slips", label: "Salary Slips", icon: Wallet },
  { href: "/offer-letters", label: "Offer Letters", icon: Mail },
  { href: "/joining-date", label: "Joining Date", icon: CalendarCheck },
  { href: "/documents", label: "Documents", icon: FolderOpen },
  { href: "/complaints", label: "Complaints", icon: AlertCircle },
  { href: "/company", label: "About Company", icon: Building2 },
  { href: "/sop", label: "SOPs & Terms", icon: ScrollText },
  { href: "/contract", label: "My Contract", icon: FileCheck },
  { href: "/bug-report", label: "Report Bug", icon: Bug },
  { href: "/profile", label: "My Profile", icon: UserCircle },
];

const allItems = [...navItems, ...moreItems];

export function TopNav() {
  const pathname = usePathname();
  const { user, logout } = useHrAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <nav className="sticky top-0 z-50 border-b border-[#F0EAD8] bg-[rgba(253,246,227,0.8)] backdrop-blur-xl">
      <div className="max-w-[1440px] mx-auto flex items-center justify-between px-4 md:px-8 py-3">
        {/* Logo */}
        <Link href="/dashboard" className="flex items-center gap-2.5 shrink-0">
          <img src="/logo.svg" alt="Digital Sukoon" className="h-9 w-9 rounded-full" />
          <div className="hidden sm:block">
            <span className="text-base font-bold text-[#1A1A1A] tracking-wide uppercase" style={{ fontFamily: "'Instagram Sans', system-ui, sans-serif", letterSpacing: "2px", fontSize: "14px" }}>Digital Sukoon</span>
          </div>
        </Link>

        {/* Desktop Nav Pills */}
        <div className="hidden lg:flex items-center gap-0.5 bg-white/50 rounded-full p-1 backdrop-blur-md">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-[13px] font-medium transition-all duration-250 ${
                  isActive
                    ? "bg-gradient-to-r from-[#3023D0] to-[#5B4BF5] text-white shadow-[0_2px_8px_rgba(91,75,245,0.25)]"
                    : "text-[#7A7A7A] hover:bg-[#F0EEFF]"
                }`}
              >
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            );
          })}

          {/* More Dropdown */}
          <div className="relative" ref={moreRef}>
            <button
              onClick={() => setMoreOpen((v) => !v)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-[13px] font-medium transition-all duration-250 ${
                moreOpen || moreItems.some(i => pathname.startsWith(i.href))
                  ? "bg-gradient-to-r from-[#3023D0] to-[#5B4BF5] text-white shadow-[0_2px_8px_rgba(91,75,245,0.25)]"
                  : "text-[#7A7A7A] hover:bg-[#F0EEFF]"
              }`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
              More
            </button>
            {moreOpen && (
              <div className="absolute right-0 top-11 z-50 w-56 bg-white rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.12)] border border-[#E8E0D0] overflow-hidden max-h-[70vh] overflow-y-auto">
                <div className="p-1.5">
                  {moreItems.map((item) => {
                    const isActive = pathname.startsWith(item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setMoreOpen(false)}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                          isActive
                            ? "bg-[#FFF8E1] text-[#1A1A1A] font-semibold"
                            : "text-[#555] hover:bg-[#FFF8E1]"
                        }`}
                      >
                        <item.icon className="h-4 w-4 text-[#7A7A7A]" />
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Section */}
        <div className="flex items-center gap-2">
          <NotificationBell />

          {/* User Avatar + Menu */}
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex items-center gap-2 p-1.5 rounded-full hover:bg-white/60 transition-all"
            >
              <div
                className="h-8 w-8 rounded-full flex items-center justify-center text-white font-semibold text-sm"
                style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
              >
                {user?.name?.charAt(0)?.toUpperCase() || "U"}
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
                    href="/profile"
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
            className="lg:hidden p-2 rounded-lg hover:bg-white/60 transition-colors"
          >
            {mobileOpen ? <X className="h-5 w-5 text-[#1A1A1A]" /> : <Menu className="h-5 w-5 text-[#1A1A1A]" />}
          </button>
        </div>
      </div>

      {/* Mobile Nav */}
      {mobileOpen && (
        <div className="lg:hidden border-t border-[#F0EAD8] bg-white/95 backdrop-blur-xl px-4 py-3 space-y-1 max-h-[80vh] overflow-y-auto">
          {allItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-all ${
                  isActive
                    ? "bg-gradient-to-r from-[#3023D0] to-[#5B4BF5] text-white font-semibold"
                    : "text-[#7A7A7A] hover:bg-[#F0EEFF]"
                }`}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </div>
      )}
    </nav>
  );
}
