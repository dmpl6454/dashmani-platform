"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import {
  LayoutDashboard, FolderKanban, FileText, CheckCircle, BarChart3, FolderOpen,
  LogOut, Menu, X, Bell
} from "lucide-react";
import { useState } from "react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/content", label: "Content", icon: FileText },
  { href: "/approvals", label: "Approvals", icon: CheckCircle },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/files", label: "Files", icon: FolderOpen },
];

export function TopNav() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

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
        <div className="hidden lg:flex items-center gap-0.5 bg-white/50 rounded-full p-1 backdrop-blur-md">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-medium transition-all duration-250 ${
                  isActive
                    ? "bg-[#1A1A1A] text-white"
                    : "text-[#7A7A7A] hover:bg-[#FFF8E1] hover:border-[#FAE89E]"
                }`}
              >
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </Link>
            );
          })}
        </div>

        {/* Right Section */}
        <div className="flex items-center gap-2">
          <button className="relative p-2 rounded-full text-[#7A7A7A] hover:bg-white/60 transition-all">
            <Bell className="h-5 w-5" />
          </button>

          {/* Company Name */}
          {user?.companyName && (
            <span className="hidden md:inline text-xs text-[#7A7A7A] bg-[#FFF3C4] px-3 py-1 rounded-full font-medium">{user.companyName}</span>
          )}

          {/* User Avatar + Menu */}
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex items-center gap-2 p-1.5 rounded-full hover:bg-white/60 transition-all"
            >
              <div
                className="h-8 w-8 rounded-full flex items-center justify-center text-white font-semibold text-sm"
                style={{ background: "linear-gradient(135deg, #E8D5B7, #B8956A)" }}
              >
                {user?.name?.charAt(0)?.toUpperCase() || "C"}
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
        <div className="lg:hidden border-t border-[#F0EAD8] bg-white/95 backdrop-blur-xl px-4 py-3 space-y-1">
          {navItems.map((item) => {
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
              </Link>
            );
          })}
        </div>
      )}
    </nav>
  );
}
