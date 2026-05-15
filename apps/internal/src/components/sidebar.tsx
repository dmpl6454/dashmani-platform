"use client";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { cn } from "@dashmani/ui";
import {
  LayoutDashboard, Users, Building2, Clock, Shield, Settings, CheckSquare, Globe, BarChart3, Briefcase, FolderOpen, FileEdit, TrendingUp, FileText, UserPlus, Megaphone,
} from "lucide-react";
import { useOverviewStats } from "@/lib/hooks/use-analytics";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, badgeKey: null },
  { href: "/employees", label: "Employees", icon: Users, badgeKey: null },
  { href: "/employees/pending", label: "Pending Approvals", icon: UserPlus, badgeKey: "pendingEmployees" as const },
  { href: "/teams", label: "Teams", icon: Building2, badgeKey: null },
  { href: "/tasks", label: "Tasks", icon: CheckSquare, badgeKey: null },
  { href: "/content", label: "Content", icon: FileEdit, badgeKey: null },
  { href: "/accounts", label: "Accounts", icon: Globe, badgeKey: null },
  { href: "/workload", label: "Workload", icon: BarChart3, badgeKey: null },
  { href: "/clients", label: "Clients", icon: Briefcase, badgeKey: null },
  { href: "/projects", label: "Projects", icon: FolderOpen, badgeKey: null },
  { href: "/analytics", label: "Analytics", icon: TrendingUp, badgeKey: null },
  { href: "/reports", label: "Reports", icon: FileText, badgeKey: null },
  { href: "/announcements", label: "Announcements", icon: Megaphone, badgeKey: null },
  { href: "/attendance", label: "Attendance", icon: Clock, badgeKey: null },
  { href: "/roles", label: "Roles", icon: Shield, badgeKey: null },
  { href: "/settings", label: "Settings", icon: Settings, badgeKey: null },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data } = useOverviewStats();
  const stats = (data as any)?.data;

  return (
    <aside className="w-64 bg-[#1A1A1A] min-h-screen text-white flex flex-col">
      <div className="p-5 border-b border-white/10 flex items-center gap-3">
        <Image src="/logo.svg" alt="Digital Sukoon" width={40} height={40} className="rounded-full" />
        <div>
          <h1 className="text-lg font-bold leading-tight font-serif">Digital Sukoon</h1>
          <p className="text-[10px] text-white/60">Management Portal</p>
        </div>
      </div>
      <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== "/employees" && pathname.startsWith(item.href));
          const badgeCount = item.badgeKey && stats ? stats[item.badgeKey] : 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                isActive ? "bg-[#F5D547] text-[#1A1A1A] font-medium" : "text-white/60 hover:bg-[#2B2B2B] hover:text-white"
              )}
            >
              <item.icon className="h-4 w-4 flex-shrink-0" />
              <span className="flex-1">{item.label}</span>
              {badgeCount > 0 && (
                <span className="bg-red-500 text-white text-xs font-bold min-w-[20px] h-5 flex items-center justify-center rounded-full px-1.5 animate-pulse">
                  {badgeCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
