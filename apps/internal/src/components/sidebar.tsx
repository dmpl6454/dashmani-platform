"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@dashmani/ui";
import {
  LayoutDashboard, Users, Building2, Clock, Shield, Settings,
} from "lucide-react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/employees", label: "Employees", icon: Users },
  { href: "/teams", label: "Teams", icon: Building2 },
  { href: "/attendance", label: "Attendance", icon: Clock },
  { href: "/roles", label: "Roles", icon: Shield },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-brand-blue min-h-screen text-white flex flex-col">
      <div className="p-6 border-b border-white/10">
        <h1 className="text-xl font-bold">Digital Sukoon</h1>
        <p className="text-xs text-white/60 mt-1">Management Portal</p>
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
    </aside>
  );
}
