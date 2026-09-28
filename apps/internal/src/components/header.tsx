"use client";
import { useAuth } from "@/lib/auth";
import { Button } from "@dashmani/ui";
import { LogOut } from "lucide-react";

export function Header() {
  const { user, logout } = useAuth();

  return (
    <header className="h-16 border-b border-border bg-surface flex items-center justify-between px-6">
      <div />
      <div className="flex items-center gap-4">
        <span className="text-sm text-ink-3">{user?.name}</span>
        <Button variant="ghost" size="icon" onClick={logout} className="text-ink-3 hover:text-ink hover:bg-action-soft">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
