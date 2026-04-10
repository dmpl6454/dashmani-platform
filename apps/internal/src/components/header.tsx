"use client";
import { useAuth } from "@/lib/auth";
import { Button } from "@dashmani/ui";
import { LogOut } from "lucide-react";

export function Header() {
  const { user, logout } = useAuth();

  return (
    <header className="h-16 border-b border-[#E8E0D0] bg-white flex items-center justify-between px-6">
      <div />
      <div className="flex items-center gap-4">
        <span className="text-sm text-[#7A7A7A]">{user?.name}</span>
        <Button variant="ghost" size="icon" onClick={logout} className="text-[#7A7A7A] hover:text-[#1A1A1A] hover:bg-[#FFF3C4]">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
