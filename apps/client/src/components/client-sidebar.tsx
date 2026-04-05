"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@dashmani/ui";
import { LayoutDashboard, FolderOpen, CheckSquare, FileText, FileEdit } from "lucide-react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/content", label: "Content", icon: FileEdit },
  { href: "/approvals", label: "Approvals", icon: CheckSquare },
  { href: "/files", label: "Files", icon: FileText },
];

export function ClientSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 bg-brand-blue text-white min-h-screen p-4 flex flex-col">
      <div className="mb-8">
        <h1 className="text-xl font-bold">Digital Sukoon</h1>
        <p className="text-sm text-blue-200">Client Portal</p>
      </div>
      <nav className="space-y-1 flex-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm transition-colors",
                active ? "bg-white/20 text-white font-medium" : "text-blue-100 hover:bg-white/10"
              )}
            >
              <Icon className="h-5 w-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
