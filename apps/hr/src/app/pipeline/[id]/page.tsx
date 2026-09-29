"use client";
/** /pipeline/[id] — one project (?m=<messageId>&t=<rootId> deep links). */
import { Suspense } from "react";
import { ProjectPage } from "@/components/pipeline/project/ProjectPage";
import { GateScreen } from "@/components/pipeline/header/GateScreen";

export default function PipelineProjectRoute({ params }: { params: { id: string } }) {
  return (
    <Suspense fallback={<GateScreen kind="loading" />}>
      <ProjectPage key={params.id} id={params.id} />
    </Suspense>
  );
}
