"use client";
import { useAuth } from "@/lib/auth";
import { LogOut } from "lucide-react";

export function ClientHeader() {
  const { user, logout } = useAuth();

  return (
    <header className="h-14 border-b bg-white flex items-center justify-between px-6">
      <div className="text-sm text-muted-foreground">
        {user?.companyName}
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">{user?.name}</span>
        <button onClick={logout} className="text-muted-foreground hover:text-foreground">
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
