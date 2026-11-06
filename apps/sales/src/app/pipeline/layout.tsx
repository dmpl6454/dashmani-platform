"use client";
// The same Pipeline the HR portal serves (same projects, threads and people), ported from
// apps/hr/src/app/pipeline. The app shell gives /pipeline a full-height frame (no footer, no
// page padding) because the board and the thread scroll inside their own panes.
//
// Sales only: inside a campaign, a Slack-style column on the left from lg up (the campaign's
// channels and Direct messages — SideColumn), inside the provider so it shares the store, sync
// and directory. The board and other pages have no column; the board's "Chat" button opens
// the chat list at /pipeline/chat. Phones get campaign channels on the project page's tab.
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { PipelineProvider } from "@/components/pipeline/provider";
import { SideColumn } from "@/components/pipeline/chat/SideColumn";
import { useVisualViewport } from "@/components/pipeline/hooks/use-visual-viewport";
import "@/components/pipeline/pipeline.css";

/** Remembered per browser (a convenience only; storage may be unavailable). */
const COLLAPSE_KEY = "pl:chat-collapsed";

export default function PipelineLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  useVisualViewport();
  // The chat column folds to a narrow rail so the board can use the full width.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* private mode: stay open */
    }
  }, []);
  const toggle = (v: boolean) => {
    setCollapsed(v);
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  if (!user) return null;
  return (
    <PipelineProvider key={user.id}>
      <div className="flex-1 min-h-0 flex min-w-0">
        <Suspense fallback={null}>
          <SideColumn collapsed={collapsed} onCollapse={() => toggle(true)} onExpand={() => toggle(false)} />
        </Suspense>
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">{children}</div>
      </div>
    </PipelineProvider>
  );
}
