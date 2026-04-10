"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { cn } from "@dashmani/ui";
import { LayoutDashboard, FileText, TrendingUp, Clock, LogOut, Trophy, Users, UserCircle, Wallet, FolderOpen, Calendar, PlaneTakeoff, FileCheck, Bug, Award, Timer, Mail, Home, Gift, ClipboardList, ListTodo, Receipt, Presentation, AlertCircle, Building2, ScrollText } from "lucide-react";
import { useHrAuth } from "@/lib/auth";
import { NotificationBell } from "./notification-bell";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/report", label: "Submit Report", icon: FileText },
  { href: "/growth", label: "Account Growth", icon: TrendingUp },
  { href: "/history", label: "Report History", icon: Clock },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/team", label: "My Team", icon: Users },
  { href: "/salary-slips", label: "Salary Slips", icon: Wallet },
  { href: "/offer-letters", label: "Offer Letters", icon: Mail },
  { href: "/documents", label: "Documents", icon: FolderOpen },
  { href: "/leave", label: "Leave Request", icon: PlaneTakeoff },
  { href: "/wfh", label: "Work from Home", icon: Home },
  { href: "/comp-off", label: "Comp Off", icon: Gift },
  { href: "/tasks", label: "My Tasks", icon: ListTodo },
  { href: "/expenses", label: "Expense Claims", icon: Receipt },
  { href: "/presentations", label: "Presentations", icon: Presentation },
  { href: "/plan", label: "Plan of Action", icon: ClipboardList },
  { href: "/calendar", label: "Calendar", icon: Calendar },
  { href: "/extra-hours", label: "Extra Hours", icon: Timer },
  { href: "/reviews", label: "My Reviews", icon: Award },
  { href: "/complaints", label: "Complaints", icon: AlertCircle },
  { href: "/company", label: "About Company", icon: Building2 },
  { href: "/sop", label: "SOPs & Terms", icon: ScrollText },
  { href: "/contract", label: "My Contract", icon: FileCheck },
  { href: "/bug-report", label: "Report Bug", icon: Bug },
  { href: "/profile", label: "My Profile", icon: UserCircle },
];

export function HrSidebar() {
  const pathname = usePathname();
  const { user, logout } = useHrAuth();

  return (
    <aside className="w-64 bg-[#1A1A1A] min-h-screen text-white flex flex-col">
      <div className="p-5 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Image src="/logo.svg" alt="Digital Sukoon" width={40} height={40} className="rounded-full" />
          <div>
            <h1 className="text-lg font-bold leading-tight font-serif">Digital Sukoon</h1>
            <p className="text-[10px] text-white/50 tracking-wider uppercase">Employee Portal</p>
          </div>
        </div>
        <NotificationBell />
      </div>
      <nav className="flex-1 p-3 space-y-1 mt-2">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm transition-all duration-200",
                isActive
                  ? "bg-[#F5D547] text-[#1A1A1A] font-semibold shadow-md"
                  : "text-white/60 hover:bg-[#2B2B2B] hover:text-white"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      {user && (
        <div className="p-4 border-t border-white/10">
          <div className="flex items-center gap-3 mb-3 px-2">
            <div className="h-9 w-9 rounded-full bg-[#F5D547] flex items-center justify-center text-[#1A1A1A] font-bold text-sm">
              {user.name?.charAt(0)?.toUpperCase() || "U"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user.name}</p>
              <p className="text-xs text-white/40 truncate">{user.email}</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="flex items-center gap-2 w-full px-4 py-2 rounded-xl text-sm text-white/50 hover:bg-[#2B2B2B] hover:text-white transition-all"
          >
            <LogOut className="h-4 w-4" />
            Logout
          </button>
        </div>
      )}
    </aside>
  );
}
