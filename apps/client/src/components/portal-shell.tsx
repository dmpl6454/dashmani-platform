"use client";
import type { ReactNode } from "react";
import { PortalRail } from "./portal-rail";
import { ToastStack } from "./portal-shared";

export function PortalShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex bg-bg text-ink">
      <PortalRail />
      <main className="flex-1 min-w-0 flex flex-col">
        {children}
      </main>
      <ToastStack />
    </div>
  );
}
