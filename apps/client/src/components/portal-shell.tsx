"use client";
import type { ReactNode } from "react";
import { PortalRail } from "./portal-rail";
import { ToastStack } from "./portal-shared";
import { CommandPalette } from "./command-palette";
import { ChannelFx } from "./channel-fx";

export function PortalShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex bg-bg text-ink">
      <PortalRail />
      {/* `relative` so the channel-surf film (scanlines + static) covers only the screen, not the rail. */}
      <main className="screen relative flex-1 min-w-0 flex flex-col pt-14 lg:pt-0">
        {children}
        <ChannelFx />
      </main>
      <ToastStack />
      <CommandPalette />
    </div>
  );
}
