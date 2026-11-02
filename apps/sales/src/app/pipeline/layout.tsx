"use client";
// The same Pipeline the HR portal serves (same projects, threads and people), ported from
// apps/hr/src/app/pipeline. The app shell gives /pipeline a full-height frame (no footer, no
// page padding) because the board and the thread scroll inside their own panes.
import { useAuth } from "@/lib/auth";
import { PipelineProvider } from "@/components/pipeline/provider";
import { useVisualViewport } from "@/components/pipeline/hooks/use-visual-viewport";
import "@/components/pipeline/pipeline.css";

export default function PipelineLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  useVisualViewport();
  return user ? <PipelineProvider key={user.id}>{children}</PipelineProvider> : null;
}
