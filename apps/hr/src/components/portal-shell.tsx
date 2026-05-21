"use client";
import { useHrAuth } from "@/lib/auth";
import { HrSidebar } from "./hr-sidebar";
import { NotificationBell } from "./notification-bell";
import Link from "next/link";

interface PortalShellProps {
  children: React.ReactNode;
}

export function PortalShell({ children }: PortalShellProps) {
  const { user, isLoading } = useHrAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen flex bg-bg text-ink">
      <HrSidebar />
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden min-h-screen">
        {children}
      </main>
    </div>
  );
}

interface TopstripProps {
  title: string;
  sub?: string;
  right?: React.ReactNode;
}

export function Topstrip({ title, sub, right }: TopstripProps) {
  return (
    <header
      className="sticky top-0 z-30 bg-bg/96 backdrop-blur-sm shrink-0"
      style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}
    >
      <div className="h-16 px-6 flex items-center gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <h1 className="text-[16px] font-bold text-ink truncate">{title}</h1>
          {sub && <span className="text-[12px] text-ink-3 font-medium hidden md:inline truncate">{sub}</span>}
        </div>
        <div className="flex-1" />
        <NotificationBell />
        {right && <div className="flex items-center gap-2">{right}</div>}
      </div>
    </header>
  );
}
