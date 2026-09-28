"use client";
/**
 * One project (spec §9.6–9.8). Phones (< lg): a portalled full-screen surface at z-45
 * with its own compact header (back, title, phase pill, bell, ⋯) and Conversation |
 * Details tabs; the composer is its last flex child, sized by the visualViewport
 * contract so it stays above the iOS keyboard. Desktop: the conversation in the centre,
 * a 340 px details and members column, and replies in a 400 px side panel.
 *
 * Deep links (`?m=<messageId>&t=<rootId>`) are handled by an effect keyed on the CURRENT
 * m and t values, so a bell click for the project already open still works.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { NotificationBell } from "@/components/notification-bell";
import { usePipeline } from "../provider";
import { useStoreSelector } from "../store";
import { describeError, isApiError, plApi } from "../api";
import { PipelineHeader } from "../header/PipelineHeader";
import { StatusPill } from "../ui/StatusPill";
import { LoadError } from "../ui/LoadError";
import { Skeleton } from "../ui/Skeleton";
import { Surface } from "../ui/Surface";
import { useToast } from "../ui/Toast";
import { useBelowLg } from "../hooks/use-media";
import { AckLedger } from "../hooks/use-seen-observer";
import { Z } from "../constants";
import { Thread } from "../thread/Thread";
import { ReplySheet } from "../thread/ReplySheet";
import { DetailsPanel } from "./DetailsPanel";
import { MembersPanel } from "./MembersPanel";
import { PhasePill, PhaseSelect, ProjectMenu } from "./ProjectHeader";

const RETRY_MS = [10_000, 20_000, 40_000];

type LoadState = { kind: "loading" } | { kind: "ok" } | { kind: "failed"; reason: string; retrying: boolean } | { kind: "gone"; deleted: boolean };

function day(ts: string): string {
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function ProjectPage({ id }: { id: string }) {
  const sp = useSearchParams();
  const m = sp.get("m");
  const t = sp.get("t");
  const router = useRouter();
  const pathname = usePathname();
  const { store, engine, loadProject, dirById } = usePipeline();
  const toast = useToast();
  const phone = useBelowLg();
  const project = useStoreSelector(store, (s) => s.projects[id]);
  const loaded = !!project?.header;
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [tab, setTab] = useState<"conversation" | "details">("conversation");
  const [highlight, setHighlight] = useState<string | null>(null);
  const ledger = useMemo(() => new AckLedger(), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const initialM = useRef(m);

  // ── first load: around ?m or the first unread; auto-retry at 10, 20, 40 s ─────────
  const attempt = useCallback(
    async (n: number, cancelled: () => boolean) => {
      try {
        await loadProject(id, initialM.current);
        if (!cancelled()) setLoad({ kind: "ok" });
      } catch (e) {
        if (cancelled()) return;
        // 400 = not a valid project id in the URL: it can never load, so say "doesn't exist".
        if (isApiError(e) && (e.status === 404 || e.status === 400 || e.code === "PROJECT_NOT_FOUND" || e.code === "PROJECT_DELETED")) {
          setLoad({ kind: "gone", deleted: e.code === "PROJECT_DELETED" });
          return;
        }
        const reason = describeError(e);
        if (n < RETRY_MS.length) {
          setLoad({ kind: "failed", reason, retrying: true });
          setTimeout(() => {
            if (!cancelled()) void attempt(n + 1, cancelled);
          }, RETRY_MS[n]);
        } else {
          setLoad({ kind: "failed", reason, retrying: false });
        }
      }
    },
    [id, loadProject],
  );

  useEffect(() => {
    let dead = false;
    setLoad({ kind: "loading" });
    void attempt(0, () => dead);
    return () => {
      dead = true;
    };
  }, [attempt]);

  // ── live updates + read state ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!loaded) return;
    return engine.mountProject({
      id,
      getAck: () => (document.visibilityState === "visible" ? ledger.take() : null),
      onAcked: (a) => ledger.confirm(a),
    });
  }, [loaded, id, engine, ledger]);

  useEffect(() => {
    if (!loaded) return;
    const leave = () => void plApi.markRead(id, ledger.maxSeq, true).catch(() => {});
    const onVis = () => {
      if (document.visibilityState === "hidden") leave();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      leave();
    };
  }, [loaded, id, ledger]);

  // ── deep links, keyed on the current m and t ──────────────────────────────────────
  useEffect(() => {
    if (!loaded || !m) return;
    let dead = false;
    const show = () => {
      const p = store.getState().projects[id];
      const msg = p?.messages[m];
      if (!p || !msg) return false;
      ledger.markSeenId(m);
      setHighlight(m);
      if (msg.parentId && !t) router.replace(`${pathname}?m=${m}&t=${msg.parentId}`, { scroll: false });
      return true;
    };
    if (!show()) {
      loadProject(id, m)
        .then(() => {
          if (dead) return;
          const p = store.getState().projects[id];
          if (p?.aroundMissing || !show()) toast.show({ text: "That message is no longer available" });
        })
        .catch(() => !dead && toast.show({ text: "That message is no longer available" }));
    }
    const clear = setTimeout(() => setHighlight(null), 2000);
    return () => {
      dead = true;
      clearTimeout(clear);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m, t, loaded]);

  // Replies push ?t= so browser / Android back closes the sheet.
  // Only pop history we pushed ourselves; a deep-linked ?t= closes with a replace.
  const pushedT = useRef<string | null>(null);
  const openReplies = useCallback(
    (rootId: string) => {
      pushedT.current = rootId;
      router.push(`${pathname}?t=${rootId}`, { scroll: false });
    },
    [router, pathname],
  );
  const closeReplies = useCallback(() => {
    if (pushedT.current && pushedT.current === t) {
      pushedT.current = null;
      router.back();
    } else {
      router.replace(pathname, { scroll: false });
    }
  }, [router, pathname, t]);

  const loadNewer = useCallback(async () => {
    const p = store.getState().projects[id];
    if (!p) return;
    const last = Object.values(p.messages)
      .filter((x) => x.parentId === null)
      .sort((a, b) => b.seq - a.seq)[0];
    const detail = await plApi.getProject(id, last?.id ?? null);
    store.dispatch({ type: "projectDetail", detail, now: Date.now(), merge: true });
  }, [id, store]);

  // ── states ────────────────────────────────────────────────────────────────────────
  const header = project?.header ?? null;
  const status = project?.status ?? "ok";
  const readOnly = status !== "ok";
  let readOnlyReason: string | null = null;
  if (header && status === "archived") {
    const who = header.archivedById ? dirById.get(header.archivedById)?.name : null;
    readOnlyReason = `Archived${who ? ` by ${who}` : ""}${header.archivedAt ? ` · ${day(header.archivedAt)}` : ""} — read-only.`;
  } else if (status === "deleted") {
    readOnlyReason = "This project was deleted — messages can't be sent.";
  }

  const back = (
    <Link href="/pipeline" aria-label="Back to the board" className="h-11 w-11 -ml-1 grid place-items-center rounded-xl text-ink-3 hover:bg-muted">
      <ChevronLeft size={20} />
    </Link>
  );

  let main: React.ReactNode;
  if (!header) {
    main =
      load.kind === "gone" ? (
        <div className="px-6 py-14 text-center" role="status">
          <p className="text-[16px] font-bold text-ink">{load.deleted ? "This project was deleted" : "This project doesn't exist"}</p>
          <p className="mt-1 text-[13px] text-ink-3">{load.deleted ? "It may be in Deleted projects for 30 days." : "It may have been deleted for good, or the link is wrong."}</p>
          <Link href="/pipeline" className="mt-4 inline-flex h-11 items-center px-4 rounded-xl border border-border text-[13px] font-semibold">
            Back to the board
          </Link>
        </div>
      ) : load.kind === "failed" ? (
        <LoadError
          title="Couldn't load this project — nothing is lost."
          reason={load.retrying ? `${load.reason} Retrying automatically…` : load.reason}
          onRetry={() => {
            setLoad({ kind: "loading" });
            void attempt(RETRY_MS.length, () => false);
          }}
        />
      ) : (
        <div className="p-4 space-y-4" role="status" aria-label="Loading the project">
          <Skeleton className="h-6 w-2/3" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-2.5">
              <Skeleton className="h-7 w-7 rounded-full" />
              <Skeleton className="h-14 flex-1" />
            </div>
          ))}
        </div>
      );
  }

  const banner = readOnlyReason ? (
    <div role="status" className={`shrink-0 px-4 py-2 text-[13px] font-medium ${status === "deleted" ? "bg-danger-bg text-danger" : "bg-muted text-ink-2"}`}>
      {readOnlyReason}
    </div>
  ) : null;

  const thread = header ? (
    <Thread
      projectId={id}
      readOnly={readOnly}
      readOnlyReason={readOnlyReason}
      highlightId={t ? null : highlight}
      ledger={ledger}
      onOpenReplies={openReplies}
      onLoadNewer={loadNewer}
    />
  ) : null;

  const side = header ? (
    <>
      <DetailsPanel header={header} readOnly={readOnly} />
      <MembersPanel header={header} participants={project!.participants} me={project!.me} can={project!.can} readOnly={readOnly} />
    </>
  ) : null;

  const replies =
    header && t ? (
      <ReplySheet
        key={t}
        projectId={id}
        rootId={t}
        phone={phone}
        readOnly={readOnly}
        readOnlyReason={readOnlyReason}
        highlightId={highlight}
        ledger={ledger}
        onClose={closeReplies}
      />
    ) : null;

  if (phone) {
    return (
      <Surface z={Z.phoneSurface} label={header?.title ?? "Project"} trap={!t}>
        <div className="h-14 shrink-0 flex items-center gap-1.5 px-2 border-b border-rule bg-bg min-w-0">
          {back}
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-bold">{header?.title ?? "Project"}</h1>
          {header && <PhasePill header={header} disabled={readOnly} />}
          <NotificationBell />
          {header && <ProjectMenu header={header} me={project!.me} can={project!.can} onShowDetails={() => setTab("details")} />}
        </div>
        <div className="px-3 pt-1 pb-0 flex min-w-0">
          <StatusPill engine={engine} />
        </div>
        {header && (
          <div className="shrink-0 flex gap-1 px-2 pt-1 border-b border-rule" role="tablist" aria-label="Project">
            {(["conversation", "details"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={`h-11 px-3 text-[13.5px] font-semibold border-b-2 ${tab === k ? "border-ink text-ink" : "border-transparent text-ink-3"}`}
              >
                {k === "conversation" ? "Conversation" : "Details"}
              </button>
            ))}
          </div>
        )}
        {banner}
        {main}
        {header && (tab === "conversation" ? thread : <div className="pl-scroll flex-1">{side}</div>)}
        {replies}
      </Surface>
    );
  }

  return (
    <div className="flex flex-col min-h-0 flex-1 min-w-0">
      <PipelineHeader
        title={header?.title ?? "Project"}
        left={back}
        status={<StatusPill engine={engine} />}
        actions={
          header ? (
            <>
              <PhaseSelect header={header} disabled={readOnly} />
              <ProjectMenu header={header} me={project!.me} can={project!.can} />
            </>
          ) : null
        }
      />
      {banner}
      {main}
      {header && (
        <div className="flex-1 min-h-0 flex min-w-0">
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">{thread}</div>
          {t ? (
            <aside className="w-[400px] shrink-0 min-h-0 border-l border-rule bg-surface" aria-label="Replies">
              {replies}
            </aside>
          ) : (
            <aside className="w-[340px] shrink-0 min-h-0 border-l border-rule bg-surface pl-scroll" aria-label="Details and members">
              {side}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
