"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@dashmani/ui";
import { LayoutDashboard, FolderOpen, CheckSquare, FileText, FileEdit, TrendingUp } from "lucide-react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/content", label: "Content", icon: FileEdit },
  { href: "/approvals", label: "Approvals", icon: CheckSquare },
  { href: "/analytics", label: "Analytics", icon: TrendingUp },
  { href: "/files", label: "Files", icon: FileText },
];

export function ClientSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-[#1A1A1A] text-white min-h-screen flex flex-col">
      <div className="p-5 border-b border-white/10 flex items-center gap-3">
        <img src="/logo.svg" alt="Digital Sukoon" className="h-10 w-10 rounded-full" />
        <div>
          <h1 className="text-lg font-bold leading-tight font-serif">Digital Sukoon</h1>
          <p className="text-[10px] text-white/60">Client Portal</p>
        </div>
      </div>
      <nav className="flex-1 p-3 space-y-0.5">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                active ? "bg-[#F5D547] text-[#1A1A1A] font-medium" : "text-white/60 hover:bg-[#2B2B2B] hover:text-white"
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
