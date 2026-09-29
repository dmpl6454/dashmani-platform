"use client";
import { PortalShell } from "@/components/portal-shell";
import { useHrAuth } from "@/lib/auth";
import { PipelineProvider } from "@/components/pipeline/provider";
import { useVisualViewport } from "@/components/pipeline/hooks/use-visual-viewport";
import "@/components/pipeline/pipeline.css";

export default function PipelineLayout({ children }: { children: React.ReactNode }) {
  const { user } = useHrAuth();
  useVisualViewport();
  return (
    <PortalShell fitViewport>
      {user ? <PipelineProvider key={user.id}>{children}</PipelineProvider> : null}
    </PortalShell>
  );
}
