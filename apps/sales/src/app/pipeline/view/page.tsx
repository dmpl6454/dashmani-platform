"use client";
/** /pipeline/view?id=<projectId> — one project (&m=<messageId>&t=<rootId> deep links). Static export: no [id] route. */
import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ProjectPage } from "@/components/pipeline/project/ProjectPage";
import { GateScreen } from "@/components/pipeline/header/GateScreen";

function Route() {
  const id = useSearchParams().get("id");
  if (!id) {
    return (
      <div className="px-6 py-14 text-center" role="status">
        <p className="text-[16px] font-bold text-ink">No project selected</p>
        <Link href="/pipeline" className="mt-4 inline-flex h-11 items-center px-4 border border-border text-[13px] font-semibold">
          Back to the board
        </Link>
      </div>
    );
  }
  return <ProjectPage key={id} id={id} />;
}

export default function PipelineProjectRoute() {
  return (
    <Suspense fallback={<GateScreen kind="loading" />}>
      <Route />
    </Suspense>
  );
}
