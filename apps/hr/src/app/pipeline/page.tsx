"use client";
import { PipelineHeader } from "@/components/pipeline/header/PipelineHeader";
import { EmptyState } from "@/components/pipeline/ui/EmptyState";

export default function PipelinePage() {
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <PipelineHeader title="Pipeline" />
      <EmptyState title="Pipeline" body="The board is on its way." />
    </div>
  );
}
