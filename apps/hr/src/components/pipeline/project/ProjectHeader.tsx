"use client";
/**
 * Project header controls (spec §9.6): the phase control (a <select> on desktop, a pill
 * that opens a sheet on phones — the non-drag move path) and the ⋯ menu (Details,
 * Members, Follow, Archive / Unarchive, Delete, Restore as `can.*` allows).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ellipsis } from "lucide-react";
import { keyBetween, selectCardsByPhase, type PipelineCan, type PipelineHeader, type PipelineMe } from "@dashmani/shared";
import { usePipeline, usePhases } from "../provider";
import { useStoreSelector } from "../store";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import { describeError, plApi } from "../api";

function useMoveToPhase(header: PipelineHeader) {
  const { store, move } = usePipeline();
  const toast = useToast();
  const byPhase = useStoreSelector(store, selectCardsByPhase);
  return async (toPhaseId: string) => {
    if (toPhaseId === header.phaseId) return;
    const first = (byPhase[toPhaseId] ?? []).find((c) => c.id !== header.id) ?? null;
    let rank: string | null = null;
    try {
      rank = keyBetween(null, first?.rank ?? null);
    } catch {
      rank = null;
    }
    const r = await move({ projectId: header.id, toPhaseId, basePhaseId: header.phaseId, afterId: null, rank });
    if (r.kind === "error") toast.show({ text: r.message, tone: "error" });
  };
}

export function PhaseSelect({ header, disabled }: { header: PipelineHeader; disabled: boolean }) {
  const phases = usePhases();
  const moveTo = useMoveToPhase(header);
  return (
    <label className="min-w-0 max-w-[220px]">
      <span className="sr-only">Phase</span>
      <select
        value={header.phaseId}
        disabled={disabled}
        onChange={(e) => void moveTo(e.target.value)}
        className="w-full max-w-full h-11 px-3 rounded-xl border border-border bg-surface text-[16px] font-semibold text-ink disabled:opacity-60"
      >
        {phases.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function PhasePill({ header, disabled }: { header: PipelineHeader; disabled: boolean }) {
  const phases = usePhases();
  const moveTo = useMoveToPhase(header);
  const [open, setOpen] = useState(false);
  const name = phases.find((p) => p.id === header.phaseId)?.name ?? "Phase";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-w-0 max-w-[45%] truncate h-9 px-3 rounded-full bg-muted text-[12.5px] font-semibold text-ink-2"
        aria-label={`Phase: ${name}. Change phase`}
      >
        {name}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Phase">
        <ul className="space-y-1.5">
          {phases.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={disabled}
                aria-pressed={p.id === header.phaseId}
                onClick={() => {
                  setOpen(false);
                  void moveTo(p.id);
                }}
                className={`w-full min-h-12 px-3 py-2 rounded-xl text-left text-[14.5px] [overflow-wrap:anywhere] ${p.id === header.phaseId ? "bg-ink text-white font-semibold" : "hover:bg-muted text-ink"} disabled:opacity-60`}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    </>
  );
}

export function ProjectMenu({
  header,
  me,
  can,
  onShowDetails,
}: {
  header: PipelineHeader;
  me: PipelineMe | null;
  can: PipelineCan | null;
  onShowDetails?: () => void;
}) {
  const { store, engine, loadProject } = usePipeline();
  const toast = useToast();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const archived = !!header.archivedAt;
  const deleted = !!header.deletedAt;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      engine.afterWrite();
      setOpen(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const archiveToggle = () =>
    act(async () => {
      const r = archived ? await plApi.unarchive(header.id) : await plApi.archive(header.id);
      store.dispatch({ type: "cardUpsert", card: r.card });
      await loadProject(header.id);
      toast.show({ text: archived ? "Unarchived" : "Archived — it's read-only until someone unarchives it" });
    });

  const restore = () =>
    act(async () => {
      const r = await plApi.restore(header.id);
      store.dispatch({ type: "cardUpsert", card: r.card });
      await loadProject(header.id);
      toast.show({ text: "Restored" });
    });

  const follow = () =>
    act(async () => {
      const on = !(me?.role === "FOLLOWER" || (me?.role === "MEMBER" && me.notify));
      const r = await plApi.follow(header.id, on);
      store.dispatch({ type: "meUpsert", projectId: header.id, me: { role: r.role, notify: r.notify } });
    });

  const doDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await plApi.deleteProject(header.id, typed);
      store.dispatch({ type: "cardRemove", projectId: header.id });
      engine.afterWrite();
      toast.show({ text: `Deleted “${header.title}”. It can be restored from Deleted projects for 30 days.` });
      router.push("/pipeline");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const followingNow = me?.role === "FOLLOWER" || (me?.role === "MEMBER" && me.notify);
  const item = "w-full h-12 px-3 rounded-xl text-left text-[14.5px] font-semibold hover:bg-muted disabled:opacity-50";

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Project actions" className="h-11 w-11 grid place-items-center rounded-xl text-ink-3 hover:bg-muted">
        <Ellipsis size={18} />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={header.title}>
        <div className="grid gap-1">
          {onShowDetails && (
            <button type="button" className={item} onClick={() => { setOpen(false); onShowDetails(); }}>
              Details and members
            </button>
          )}
          {!deleted && !archived && (
            <button type="button" className={item} disabled={busy} onClick={() => void follow()}>
              {followingNow ? (me?.role === "MEMBER" ? "Mute notifications" : "Unfollow") : me?.role === "MEMBER" ? "Get notifications" : "Follow"}
            </button>
          )}
          {!deleted && can?.archive && (
            <button type="button" className={item} disabled={busy} onClick={() => void archiveToggle()}>
              {archived ? "Unarchive" : "Archive"}
            </button>
          )}
          {deleted && can?.restore && (
            <button type="button" className={item} disabled={busy} onClick={() => void restore()}>
              Restore
            </button>
          )}
          {!deleted && can?.delete && (
            <button type="button" className={`${item} text-danger`} disabled={busy} onClick={() => { setOpen(false); setTyped(""); setConfirmDelete(true); }}>
              Delete…
            </button>
          )}
          {error && (
            <p role="alert" className="px-3 pt-1 text-[12.5px] text-danger">
              {error}
            </p>
          )}
        </div>
      </Sheet>
      <Sheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this project?"
        footer={
          <div className="flex items-center gap-2">
            {error && <p role="alert" className="min-w-0 flex-1 text-[12.5px] text-danger">{error}</p>}
            <button
              type="button"
              disabled={busy || typed.trim() !== header.title.trim()}
              onClick={() => void doDelete()}
              className="ml-auto h-11 px-4 rounded-xl bg-danger text-white text-[14px] font-semibold disabled:opacity-40"
            >
              {busy ? "Deleting…" : "Delete project"}
            </button>
          </div>
        }
      >
        <p className="text-[13.5px] text-ink-2 mb-3">
          It disappears for everyone. It can be restored from Deleted projects for 30 days. Type the title to confirm:
        </p>
        <p className="text-[13.5px] font-bold text-ink mb-2 [overflow-wrap:anywhere]">{header.title}</p>
        <input
          data-autofocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label="Type the project title to confirm"
          className="w-full h-11 px-3 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-danger"
        />
      </Sheet>
    </>
  );
}
