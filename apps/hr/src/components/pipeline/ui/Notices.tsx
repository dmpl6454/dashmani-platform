"use client";
/** Turns the store's move notices (conflict / failed) into toasts, in words. */
import { useEffect } from "react";
import { usePipeline, usePhases } from "../provider";
import { useStoreSelector } from "../store";
import { useToast } from "./Toast";

export function Notices() {
  const { store } = usePipeline();
  const phases = usePhases();
  const toast = useToast();
  const notices = useStoreSelector(store, (s) => s.notices);
  useEffect(() => {
    if (notices.length === 0) return;
    for (const n of notices) {
      const card = store.getState().board?.cards[n.projectId];
      const title = card ? `“${card.title}”` : "This project";
      const phase = phases.find((p) => p.id === n.phaseId)?.name ?? "another phase";
      toast.show({
        text:
          n.kind === "move_conflict"
            ? `Someone just moved ${title} to ${phase} — showing the latest.`
            : `Couldn't move ${title} — it's still in ${phase}.`,
        tone: n.kind === "move_failed" ? "error" : "neutral",
      });
      store.dispatch({ type: "noticeDismiss", id: n.id });
    }
  }, [notices, store, phases, toast]);
  return null;
}
