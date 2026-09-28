"use client";
/**
 * The board (spec §9.5, §9.8). Live data comes from the store (fed by the SyncEngine);
 * this component only mounts the board view on the engine and renders.
 *
 * Phones (< 768 px): filter chips, local search, a sticky phase-chip bar, one phase at a
 * time; a 250 ms long-press drags and a wrapping drop tray lists every phase. Tablet and
 * desktop: 288 px columns, each its own vertical scroller, in a horizontal scroller.
 * Every card also has ⋯ → Move to…, so nothing depends on dragging.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { Archive, Plus, Search, Trash2 } from "lucide-react";
import { keyBetween, selectCardsByPhase, type PipelineCard, type PipelinePhase } from "@dashmani/shared";
import { plKey, plReadJson, plWrite } from "@/lib/pipeline-storage";
import { ModalPortal } from "@/components/modal-portal";
import { usePipeline, usePhases } from "../provider";
import { useStoreSelector } from "../store";
import { PipelineHeader } from "../header/PipelineHeader";
import { StatusPill } from "../ui/StatusPill";
import { LoadError } from "../ui/LoadError";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { usePhone } from "../hooks/use-media";
import { Z } from "../constants";
import { CardFace } from "./ProjectCard";
import { PhaseTabs } from "./PhaseTabs";
import { DropTray, TRAY_PREFIX } from "./DropTray";
import { CardList, COLUMN_PREFIX, PhaseColumn, TruncationNote } from "./PhaseColumn";
import { MoveSheet } from "./MoveSheet";
import { NewProjectSheet } from "./NewProjectSheet";

type Filter = "all" | "mine" | "following";
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "mine", label: "My projects" },
  { id: "following", label: "Following" },
];
const FIRST_LOAD_FAILURES = 3;

/** A key strictly between two neighbours; null when the neighbours can't be ordered. */
function safeRank(prev: PipelineCard | null, next: PipelineCard | null): string | null {
  try {
    return keyBetween(prev?.rank ?? null, next?.rank ?? null);
  } catch {
    return null;
  }
}

/** Tray targets win when the pointer is over one; otherwise nearest card / column. */
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args).filter((c) => String(c.id).startsWith(TRAY_PREFIX));
  return within.length ? within : closestCorners(args);
};

export function Board() {
  const { store, engine, meId, dirById, move } = usePipeline();
  const router = useRouter();
  const toast = useToast();
  const phone = usePhone();
  const phases = usePhases();

  useEffect(() => engine.mountBoard(), [engine]);

  const board = useStoreSelector(store, (s) => s.board);
  const byPhase = useStoreSelector(store, selectCardsByPhase);
  const mine = useStoreSelector(store, (s) => s.mine?.entries ?? null);
  const checking = useStoreSelector(store, (s) => new Set(Object.values(s.moves).filter((m) => m.status === "checking").map((m) => m.projectId)));
  const status = useSyncExternalStore(engine.subscribeStatus, engine.getStatus, engine.getStatus);

  // Remembered per user (and per browser), never shared across accounts.
  const prefsKey = plKey(meId, "board");
  const [filter, setFilter] = useState<Filter>("all");
  const [activePhase, setActivePhase] = useState<string | null>(null);
  useEffect(() => {
    const p = plReadJson<{ filter?: Filter; phase?: string }>(prefsKey);
    if (p?.filter && FILTERS.some((f) => f.id === p.filter)) setFilter(p.filter);
    if (p?.phase) setActivePhase(p.phase);
  }, [prefsKey]);
  useEffect(() => {
    plWrite(prefsKey, JSON.stringify({ filter, phase: activePhase }));
  }, [prefsKey, filter, activePhase]);

  const [q, setQ] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [menuCard, setMenuCard] = useState<PipelineCard | null>(null);
  const [dragId, setDragId] = useState<UniqueIdentifier | null>(null);
  const liveRef = useRef<HTMLParagraphElement>(null);

  const phaseName = useCallback((id: string | null) => phases.find((p) => p.id === id)?.name ?? "another phase", [phases]);
  const phaseById = useMemo(() => new Map(phases.map((p) => [p.id, p])), [phases]);
  const currentPhase = activePhase && phaseById.has(activePhase) ? activePhase : phases[0]?.id ?? null;

  const matches = useCallback(
    (c: PipelineCard) => {
      const role = mine?.[c.id]?.role;
      if (filter === "mine" && !(c.ownerId === meId || role === "MEMBER")) return false;
      if (filter === "following" && role !== "FOLLOWER") return false;
      const needle = q.trim().toLowerCase();
      return !needle || c.title.toLowerCase().includes(needle);
    },
    [filter, mine, meId, q],
  );

  const visible = useMemo(() => {
    const out: Record<string, PipelineCard[]> = {};
    for (const ph of phases) out[ph.id] = (byPhase[ph.id] ?? []).filter(matches);
    return out;
  }, [phases, byPhase, matches]);
  const counts = useMemo(() => Object.fromEntries(phases.map((p) => [p.id, visible[p.id]?.length ?? 0])), [phases, visible]);
  const totalCards = useMemo(() => phases.reduce((n, p) => n + (byPhase[p.id]?.length ?? 0), 0), [phases, byPhase]);
  const totalVisible = useMemo(() => phases.reduce((n, p) => n + (visible[p.id]?.length ?? 0), 0), [phases, visible]);
  const filtered = filter !== "all" || q.trim() !== "";

  const findCard = useCallback(
    (id: UniqueIdentifier): PipelineCard | null => {
      for (const ph of phases) {
        const c = byPhase[ph.id]?.find((x) => x.id === id);
        if (c) return c;
      }
      return null;
    },
    [phases, byPhase],
  );

  const announce = (text: string) => {
    if (liveRef.current) liveRef.current.textContent = text;
  };

  const focusCard = (id: string | null) => {
    if (!id) return;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-card-title="${id}"]`)?.focus());
  };

  /**
   * Run a move. After a cross-phase move a persistent toast reads "Moved to X · View · Undo";
   * Undo moves it back to where it came from.
   */
  const runMove = useCallback(
    async (card: PipelineCard, toPhaseId: string, prev: PipelineCard | null, next: PipelineCard | null, origin: { prev: PipelineCard | null; next: PipelineCard | null }) => {
      const fromPhaseId = card.phaseId;
      const res = await move({ projectId: card.id, toPhaseId, basePhaseId: fromPhaseId, afterId: prev?.id ?? null, rank: safeRank(prev, next) });
      if (res.kind === "error") {
        toast.show({ text: res.message, tone: "error" });
        return;
      }
      if (res.kind === "conflict") return; // the provider's notice explains it
      if (toPhaseId !== fromPhaseId) {
        const to = phaseName(toPhaseId);
        announce(`Moved “${card.title}” to ${to}.`);
        toast.show({
          text: `Moved to ${to}`,
          duration: 0,
          actions: [
            { label: "View", onClick: () => router.push(`/pipeline/${card.id}`) },
            {
              label: "Undo",
              onClick: () => {
                void move({
                  projectId: card.id,
                  toPhaseId: fromPhaseId,
                  basePhaseId: toPhaseId,
                  afterId: origin.prev?.id ?? null,
                  rank: safeRank(origin.prev, origin.next),
                });
              },
            },
          ],
        });
      }
    },
    [move, toast, phaseName, router],
  );

  const neighboursOf = (card: PipelineCard) => {
    const list = byPhase[card.phaseId] ?? [];
    const i = list.findIndex((c) => c.id === card.id);
    return { prev: i > 0 ? list[i - 1] : null, next: i >= 0 && i < list.length - 1 ? list[i + 1] : null, after: list[i + 1]?.id ?? null };
  };

  const onMoveTo = (card: PipelineCard, toPhaseId: string, where: "top" | "bottom") => {
    setMenuCard(null);
    const origin = neighboursOf(card);
    const list = (byPhase[toPhaseId] ?? []).filter((c) => c.id !== card.id);
    const prev = where === "top" ? null : list[list.length - 1] ?? null;
    const next = where === "top" ? list[0] ?? null : null;
    focusCard(origin.after ?? origin.prev?.id ?? null);
    void runMove(card, toPhaseId, prev, next, origin);
  };

  // ── drag and drop ───────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], end: ["Space"], cancel: ["Escape"] },
    }),
  );

  const describeOver = (overId: UniqueIdentifier | undefined, activeId: UniqueIdentifier): string => {
    if (overId === undefined) return "not over a drop target";
    const s = String(overId);
    if (s.startsWith(TRAY_PREFIX)) return `over ${phaseName(s.slice(TRAY_PREFIX.length))}`;
    if (s.startsWith(COLUMN_PREFIX)) return `over the end of ${phaseName(s.slice(COLUMN_PREFIX.length))}`;
    const over = findCard(overId);
    if (!over) return "over a card";
    const list = (byPhase[over.phaseId] ?? []).filter((c) => c.id !== activeId);
    return `in ${phaseName(over.phaseId)}, position ${list.findIndex((c) => c.id === over.id) + 1} of ${list.length + 1}`;
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      const c = findCard(active.id);
      return c ? `Picked up “${c.title}” in ${phaseName(c.phaseId)}.` : "Picked up a project.";
    },
    onDragOver: ({ active, over }) => `Moving, ${describeOver(over?.id, active.id)}.`,
    onDragEnd: ({ active, over }) => (over ? `Dropped, ${describeOver(over.id, active.id)}.` : "Dropped. Nothing moved."),
    onDragCancel: ({ active }) => {
      const c = findCard(active.id);
      return c ? `Cancelled. “${c.title}” stays in ${phaseName(c.phaseId)}.` : "Cancelled.";
    },
  };

  const onDragStart = (e: DragStartEvent) => {
    setDragId(e.active.id);
    try {
      navigator.vibrate?.(10);
    } catch {
      /* not supported */
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const card = findCard(e.active.id);
    const over = e.over?.id;
    if (!card || over === undefined || over === e.active.id) return;
    const origin = neighboursOf(card);
    const s = String(over);
    let toPhaseId: string;
    let prev: PipelineCard | null;
    let next: PipelineCard | null;
    if (s.startsWith(TRAY_PREFIX) || s.startsWith(COLUMN_PREFIX)) {
      toPhaseId = s.slice(s.indexOf(":") + 1);
      if (toPhaseId === card.phaseId && s.startsWith(TRAY_PREFIX)) return; // dropped on its own phase
      const list = (byPhase[toPhaseId] ?? []).filter((c) => c.id !== card.id);
      prev = list[list.length - 1] ?? null;
      next = null;
    } else {
      const overCard = findCard(over);
      if (!overCard) return;
      toPhaseId = overCard.phaseId;
      const original = byPhase[toPhaseId] ?? [];
      const oi = original.findIndex((c) => c.id === overCard.id);
      if (toPhaseId === card.phaseId) {
        const ai = original.findIndex((c) => c.id === card.id);
        if (ai === oi) return;
        const moved = arrayMove(original, ai, oi);
        prev = moved[oi - 1] ?? null;
        next = moved[oi + 1] ?? null;
      } else {
        const list = original.filter((c) => c.id !== card.id);
        const idx = list.findIndex((c) => c.id === overCard.id);
        prev = list[idx - 1] ?? null;
        next = list[idx] ?? null;
      }
    }
    if (toPhaseId !== card.phaseId) focusCard(origin.after ?? origin.prev?.id ?? null);
    void runMove(card, toPhaseId, prev, next, origin);
  };

  const dragCard = dragId !== null ? findCard(dragId) : null;
  const openCard = useCallback((id: string) => router.push(`/pipeline/${id}`), [router]);

  // ── render ──────────────────────────────────────────────────────────────────────
  const header = (
    <PipelineHeader
      title="Pipeline"
      status={<StatusPill engine={engine} />}
      actions={
        <>
          <Link href="/pipeline?view=archived" className="h-11 w-11 sm:w-auto sm:px-3 inline-flex items-center justify-center gap-1.5 rounded-xl text-ink-3 hover:bg-muted text-[13px] font-semibold" aria-label="Archived projects">
            <Archive size={16} />
            <span className="hidden lg:inline">Archived</span>
          </Link>
          <Link href="/pipeline?view=deleted" className="h-11 w-11 sm:w-auto sm:px-3 inline-flex items-center justify-center gap-1.5 rounded-xl text-ink-3 hover:bg-muted text-[13px] font-semibold" aria-label="Deleted projects">
            <Trash2 size={16} />
            <span className="hidden lg:inline">Deleted</span>
          </Link>
          <button
            type="button"
            onClick={() => setNewOpen(true)}
            disabled={!board}
            className="h-11 px-3 inline-flex items-center gap-1.5 rounded-xl bg-ink text-white text-[13px] font-semibold disabled:opacity-50"
          >
            <Plus size={16} />
            <span className="hidden sm:inline">New project</span>
            <span className="sm:hidden sr-only">New project</span>
          </button>
        </>
      }
    />
  );

  let content: React.ReactNode;
  if (!board) {
    content =
      status.failures >= FIRST_LOAD_FAILURES ? (
        <LoadError
          title="Couldn't load the pipeline — your projects are safe."
          reason={!status.online ? "You're offline. It will load when you're back online." : "The server didn't answer. It keeps retrying on its own."}
          onRetry={() => engine.syncNow()}
        />
      ) : (
        <div className="p-4 flex gap-3 overflow-hidden" role="status" aria-label="Loading the board">
          {[0, 1, 2].map((i) => (
            <div key={i} className="w-[288px] max-w-full shrink-0 space-y-2">
              <Skeleton className="h-8 w-32" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ))}
        </div>
      );
  } else if (totalCards === 0) {
    content = (
      <EmptyState
        title="No projects yet — create the first one"
        action={
          <button type="button" onClick={() => setNewOpen(true)} className="h-11 px-4 inline-flex items-center gap-1.5 rounded-xl bg-ink text-white text-[13px] font-semibold">
            <Plus size={16} /> New project
          </button>
        }
      />
    );
  } else {
    const emptyText = (ph: PipelinePhase) => {
      if (!filtered) return "Nothing here yet";
      const label = FILTERS.find((f) => f.id === filter)?.label ?? "All";
      const elsewhere = totalVisible - (visible[ph.id]?.length ?? 0);
      return `Nothing in ${ph.name} for ${filter === "all" ? "this search" : label}${elsewhere ? ` — ${elsewhere} in other phases` : ""}`;
    };
    const filters = (
      <div className="flex flex-wrap items-center gap-2 px-3 sm:px-5 pt-3 pb-2 min-w-0">
        <div className="flex gap-1.5" role="group" aria-label="Filter">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`h-11 px-3.5 rounded-full text-[13px] font-semibold border ${filter === f.id ? "bg-ink text-white border-ink" : "bg-surface text-ink-2 border-border"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="relative min-w-0 flex-1 basis-48">
          <span className="sr-only">Search projects</span>
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" aria-hidden />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects"
            className="w-full h-11 pl-9 pr-3 rounded-xl border border-border bg-surface text-[16px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-indigo"
          />
        </label>
      </div>
    );

    if (phone) {
      const ph = currentPhase ? phaseById.get(currentPhase) ?? null : null;
      const list = ph ? visible[ph.id] ?? [] : [];
      content = (
        <>
          {filters}
          {dragCard ? (
            <DropTray phases={phases} currentPhaseId={dragCard.phaseId} />
          ) : (
            <PhaseTabs phases={phases} counts={counts} active={currentPhase} onPick={setActivePhase} />
          )}
          <div className="pl-scroll flex-1 px-3 py-3">
            {ph && (
              <>
                <CardList
                  phase={ph}
                  cards={list}
                  mine={mine}
                  dirById={dirById}
                  checking={checking}
                  onOpen={openCard}
                  onMenu={setMenuCard}
                  emptyText={emptyText(ph)}
                />
                <TruncationNote count={board.perPhase[ph.id]} />
              </>
            )}
          </div>
        </>
      );
    } else {
      content = (
        <>
          {filters}
          <div className="flex-1 min-h-0 min-w-0 overflow-x-auto overflow-y-hidden">
            <div className="h-full flex gap-3 px-3 sm:px-5 pb-3 w-max">
              {phases.map((ph) => (
                <PhaseColumn
                  key={ph.id}
                  phase={ph}
                  cards={visible[ph.id] ?? []}
                  total={counts[ph.id] ?? 0}
                  count={board.perPhase[ph.id]}
                  mine={mine}
                  dirById={dirById}
                  checking={checking}
                  onOpen={openCard}
                  onMenu={setMenuCard}
                  emptyText={emptyText(ph)}
                />
              ))}
            </div>
          </div>
        </>
      );
    }
  }

  return (
    <div className="flex flex-col min-h-0 flex-1 min-w-0">
      {header}
      <p ref={liveRef} className="sr-only" aria-live="polite" />
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragId(null)}
        accessibility={{ announcements }}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      >
        <div className="flex flex-col min-h-0 flex-1 min-w-0">{content}</div>
        <ModalPortal>
          <DragOverlay zIndex={Z.drag}>
            {dragCard ? (
              <div className="w-[272px] max-w-[85vw]">
                <CardFace card={dragCard} mine={mine?.[dragCard.id]} dirById={dirById} isTerminal={!!phaseById.get(dragCard.phaseId)?.isTerminal} overlay />
              </div>
            ) : null}
          </DragOverlay>
        </ModalPortal>
      </DndContext>
      <MoveSheet card={menuCard} phases={phases} onClose={() => setMenuCard(null)} onMove={onMoveTo} />
      <NewProjectSheet open={newOpen} onClose={() => setNewOpen(false)} phases={phases} defaultPhaseId={phone ? currentPhase : null} />
    </div>
  );
}
