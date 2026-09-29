"use client";
/**
 * /pipeline — the board, or the archived / deleted lists via ?view=. useSearchParams is
 * read inside <Suspense>, whose fallback is real content (a skeleton board), not a spinner.
 */
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Board } from "@/components/pipeline/board/Board";
import { ProjectListView } from "@/components/pipeline/board/ProjectListView";
import { GateScreen } from "@/components/pipeline/header/GateScreen";

function Route() {
  const view = useSearchParams().get("view");
  if (view === "archived" || view === "deleted") return <ProjectListView view={view} />;
  return <Board />;
}

export default function PipelinePage() {
  return (
    <Suspense fallback={<GateScreen kind="loading" />}>
      <Route />
    </Suspense>
  );
}
