"use client";
import { useAuth } from "@/lib/auth";
import { LogOut } from "lucide-react";

export function ClientHeader() {
  const { user, logout } = useAuth();

  return (
    <header className="h-14 border-b border-[#E8E0D0] bg-white flex items-center justify-between px-6">
      <div className="text-sm text-[#7A7A7A]">
        {user?.companyName}
      </div>
      <div className="flex items-center gap-3">
        <div className="h-8 w-8 rounded-full bg-[#F5D547] text-[#1A1A1A] font-bold flex items-center justify-center text-sm">
          {user?.name?.charAt(0)?.toUpperCase() || "U"}
        </div>
        <span className="text-sm font-medium text-[#1A1A1A]">{user?.name}</span>
        <button onClick={logout} className="text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors">
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
