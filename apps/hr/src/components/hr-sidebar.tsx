"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@dashmani/ui";
import { LayoutDashboard, FileText, TrendingUp, Clock, LogOut, Trophy, Users } from "lucide-react";
import { useHrAuth } from "@/lib/auth";
import { NotificationBell } from "./notification-bell";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/report", label: "Submit Report", icon: FileText },
  { href: "/growth", label: "Account Growth", icon: TrendingUp },
  { href: "/history", label: "Report History", icon: Clock },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/team", label: "My Team", icon: Users },
];

export function HrSidebar() {
  const pathname = usePathname();
  const { user, logout } = useHrAuth();

  return (
    <aside className="w-64 bg-blue-900 min-h-screen text-white flex flex-col">
      <div className="p-6 border-b border-white/10 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold">Digital Sukoon</h1>
          <p className="text-xs text-white/60 mt-1">Employee Portal</p>
        </div>
        <NotificationBell />
      </div>
      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors",
                isActive ? "bg-white/20 text-white" : "text-white/70 hover:bg-white/10 hover:text-white"
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
          <div className="mb-3">
            <p className="text-sm font-medium">{user.name}</p>
            <p className="text-xs text-white/60">{user.email}</p>
          </div>
          <button
            onClick={logout}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm text-white/70 hover:bg-white/10 hover:text-white transition-colors"
          >
            <LogOut className="h-4 w-4" />
            Logout
          </button>
        </div>
      )}
    </aside>
  );
}
