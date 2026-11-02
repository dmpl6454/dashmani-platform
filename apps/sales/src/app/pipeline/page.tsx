"use client";
/**
 * /pipeline — the board, or the archived / deleted lists via ?view=. useSearchParams is
 * read inside <Suspense>, whose fallback is real content (a skeleton board), not a spinner.
 */
import { Suspense, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Board } from "@/components/pipeline/board/Board";
import type { NewProjectPrefill } from "@/components/pipeline/board/NewProjectSheet";
import { ProjectListView } from "@/components/pipeline/board/ProjectListView";
import { GateScreen } from "@/components/pipeline/header/GateScreen";

function Route() {
  const params = useSearchParams();
  const router = useRouter();
  const view = params.get("view");
  // ?new=1&clientId=&title=&description= opens "New project" filled in (client and booking
  // pages link here). The params are dropped once the sheet closes, so a reload doesn't reopen it.
  const isNew = params.get("new") === "1";
  const clientId = params.get("clientId");
  const title = params.get("title");
  const description = params.get("description");
  const prefill = useMemo<NewProjectPrefill | null>(
    () =>
      isNew
        ? { linkedClientId: clientId ?? undefined, title: title ?? undefined, description: description ?? undefined }
        : null,
    [isNew, clientId, title, description],
  );
  const done = useCallback(() => router.replace("/pipeline"), [router]);
  if (view === "archived" || view === "deleted") return <ProjectListView view={view} />;
  return <Board newPrefill={prefill} onPrefillDone={done} />;
}

export default function PipelinePage() {
  return (
    <Suspense fallback={<GateScreen kind="loading" />}>
      <Route />
    </Suspense>
  );
}
