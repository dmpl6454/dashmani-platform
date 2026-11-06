"use client";
/**
 * One channel or DM (/pipeline/chat?id=). The same thread, replies, reactions, mentions and
 * read state as a project (Thread, ReplySheet, the SyncEngine), with a slim header — `# name`
 * or the other person — and an "About & members" side column instead of phase and work.
 *
 * A public channel I'm not in opens read-only with a Join bar (Slack's preview). A private
 * channel or DM I'm not in is "not found" (the API answers 404).
 *
 * Phones (< lg): a full-screen surface like ProjectPage, with Messages | Members tabs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Hash, Lock, Users } from "lucide-react";
import { usePipeline } from "../provider";
import { useStoreSelector } from "../store";
import { describeError, isApiError, plApi } from "../api";
import { PipelineHeader } from "../header/PipelineHeader";
import { StatusPill } from "../ui/StatusPill";
import { LoadError } from "../ui/LoadError";
import { Skeleton } from "../ui/Skeleton";
import { Surface } from "../ui/Surface";
import { Initials } from "../ui/Initials";
import { useToast } from "../ui/Toast";
import { useBelowLg } from "../hooks/use-media";
import { AckLedger } from "../hooks/use-seen-observer";
import { Z } from "../constants";
import { Thread } from "../thread/Thread";
import { ReplySheet } from "../thread/ReplySheet";
import { ConversationDetails } from "./ConversationDetails";
import { useConversations, usePresence } from "./use-chat";

const RETRY_MS = [10_000, 20_000, 40_000];
type LoadState = { kind: "loading" } | { kind: "ok" } | { kind: "failed"; reason: string; retrying: boolean } | { kind: "gone" };

export function ConversationPage({ id }: { id: string }) {
  const sp = useSearchParams();
  const m = sp.get("m");
  const t = sp.get("t");
  const router = useRouter();
  const pathname = usePathname();
  const base = `${pathname}?id=${encodeURIComponent(id)}`;
  const { store, engine, loadProject, dirById, meId } = usePipeline();
  const toast = useToast();
  const phone = useBelowLg();
  const online = usePresence();
  const { mutate: refreshList } = useConversations();
  const project = useStoreSelector(store, (s) => s.projects[id]);
  const loaded = !!project?.header;
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [tab, setTab] = useState<"messages" | "members">("messages");
  const [showSide, setShowSide] = useState(true);
  const [joining, setJoining] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  // A fresh read ledger per conversation (the page is keyed on id, so this runs once per id).
  const ledger = useMemo(() => new AckLedger(), [id]);
  const initialM = useRef(m);

  const attempt = useCallback(
    async (n: number, cancelled: () => boolean) => {
      try {
        await loadProject(id, initialM.current);
        if (!cancelled()) setLoad({ kind: "ok" });
      } catch (e) {
        if (cancelled()) return;
        if (isApiError(e) && (e.status === 404 || e.status === 400)) {
          setLoad({ kind: "gone" });
          return;
        }
        const reason = describeError(e);
        if (n < RETRY_MS.length) {
          setLoad({ kind: "failed", reason, retrying: true });
          setTimeout(() => !cancelled() && void attempt(n + 1, cancelled), RETRY_MS[n]);
        } else setLoad({ kind: "failed", reason, retrying: false });
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

  // Live updates + read state, exactly as a project page.
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
    const onVis = () => document.visibilityState === "hidden" && leave();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      leave();
    };
  }, [loaded, id, ledger]);

  // Deep link to a message (?m=), like ProjectPage.
  useEffect(() => {
    if (!loaded || !m) return;
    const msg = store.getState().projects[id]?.messages[m];
    if (!msg) return;
    ledger.markSeenId(m);
    setHighlight(m);
    const clear = setTimeout(() => setHighlight(null), 2000);
    return () => clearTimeout(clear);
  }, [m, loaded, id, store, ledger]);

  const pushedT = useRef<string | null>(null);
  const openReplies = useCallback(
    (rootId: string) => {
      pushedT.current = rootId;
      router.push(`${base}&t=${rootId}`, { scroll: false });
    },
    [router, base],
  );
  const closeReplies = useCallback(() => {
    if (pushedT.current && pushedT.current === t) {
      pushedT.current = null;
      router.back();
    } else router.replace(base, { scroll: false });
  }, [router, base, t]);

  const loadNewer = useCallback(async () => {
    const p = store.getState().projects[id];
    if (!p) return;
    const last = Object.values(p.messages)
      .filter((x) => x.parentId === null)
      .sort((a, b) => b.seq - a.seq)[0];
    const detail = await plApi.getProject(id, last?.id ?? null);
    store.dispatch({ type: "projectDetail", detail, now: Date.now(), merge: true });
  }, [id, store]);

  /** After a membership / settings change: reload the header + members, and the sidebar. */
  const refresh = useCallback(async () => {
    engine.afterWrite();
    void refreshList();
    try {
      await loadProject(id, null);
    } catch (e) {
      // Left a private channel: it is now "not found" for me.
      if (isApiError(e) && e.status === 404) setLoad({ kind: "gone" });
    }
  }, [engine, refreshList, loadProject, id]);

  const header = project?.header ?? null;
  // A project id opened here: send it to its real page.
  useEffect(() => {
    if (header && (header.kind ?? "project") === "project") router.replace(`/pipeline/view?id=${encodeURIComponent(id)}`);
  }, [header, id, router]);

  const isDm = header?.kind === "dm";
  const isMember = !!project?.me?.role;
  const status = project?.status ?? "ok";
  const others = (project?.participants ?? []).map((p) => p.userId).filter((u) => u !== meId);
  const dmOther = isDm ? others[0] ?? meId : null;
  const title = !header ? "" : isDm ? dirById.get(dmOther!)?.name ?? "Direct message" : header.title;
  const readOnly = status !== "ok" || !isMember;
  const readOnlyReason =
    status === "deleted" ? "This conversation is no longer available." : !isMember && header ? `You're viewing #${header.title}. Join to send messages.` : null;

  const join = async () => {
    setJoining(true);
    try {
      await plApi.joinChannel(id);
      await refresh();
    } catch (e) {
      toast.show({ text: describeError(e) });
    } finally {
      setJoining(false);
    }
  };

  const icon = isDm ? (
    <span className="relative">
      <Initials userId={dmOther!} name={title} size={24} />
      <span className={`absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full border-2 border-bg ${online.has(dmOther!) ? "bg-success" : "bg-ink-4"}`} />
    </span>
  ) : header?.isPrivate ? (
    <Lock size={17} aria-label="Private channel" />
  ) : (
    <Hash size={18} aria-hidden />
  );

  // A campaign channel goes back to its campaign; anything else to the chat list / the board.
  const parentId = header?.parentProjectId ?? null;
  const backHref = parentId ? `/pipeline/view?id=${encodeURIComponent(parentId)}` : "/pipeline/chat";
  const back = (
    <Link href={backHref} aria-label={parentId ? `Back to ${header?.parentTitle ?? "the campaign"}` : "Back"} className="h-11 w-11 -ml-1 grid place-items-center text-ink-3 hover:bg-muted">
      <ChevronLeft size={20} />
    </Link>
  );

  let main: React.ReactNode = null;
  if (!header) {
    main =
      load.kind === "gone" ? (
        <div className="px-6 py-14 text-center" role="status">
          <p className="text-[16px] font-bold text-ink">This conversation doesn&apos;t exist, or you&apos;re not in it</p>
          <p className="mt-1 text-[13px] text-ink-3">A private channel is visible to its members only.</p>
          <Link href="/pipeline/chat" className="mt-4 inline-flex h-11 items-center px-4 border border-border text-[13px] font-semibold">
            Back to chats
          </Link>
        </div>
      ) : load.kind === "failed" ? (
        <LoadError
          title="Couldn't load this conversation — nothing is lost."
          reason={load.retrying ? `${load.reason} Retrying automatically…` : load.reason}
          onRetry={() => {
            setLoad({ kind: "loading" });
            void attempt(RETRY_MS.length, () => false);
          }}
        />
      ) : (
        <div className="p-4 space-y-4" role="status" aria-label="Loading">
          <Skeleton className="h-6 w-1/3" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex gap-2.5">
              <Skeleton className="h-7 w-7 rounded-full" />
              <Skeleton className="h-14 flex-1" />
            </div>
          ))}
        </div>
      );
  }

  const joinBar =
    header && !isMember && header.kind === "channel" ? (
      <div className="shrink-0 border-t border-rule bg-surface px-4 py-3 flex items-center justify-between gap-3">
        <p className="text-[13.5px] text-ink-2">
          You&apos;re viewing <span className="font-semibold text-ink">#{header.title}</span>
        </p>
        <button type="button" onClick={() => void join()} disabled={joining} className="h-10 px-4 bg-indigo text-white text-[13.5px] font-semibold disabled:opacity-50">
          {joining ? "Joining…" : "Join channel"}
        </button>
      </div>
    ) : null;

  const thread = header ? (
    <Thread
      projectId={id}
      readOnly={readOnly}
      readOnlyReason={joinBar ? null : readOnlyReason}
      highlightId={t ? null : highlight}
      ledger={ledger}
      onOpenReplies={openReplies}
      onLoadNewer={loadNewer}
    />
  ) : null;

  const details = header ? (
    <ConversationDetails header={header} participants={project!.participants} me={project!.me} online={online} onChanged={refresh} />
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

  const sub =
    header && !isDm && (header.parentTitle || header.description) ? (
      <span className="truncate">{[header.parentTitle ? `in ${header.parentTitle}` : null, header.description || null].filter(Boolean).join(" · ")}</span>
    ) : null;

  if (phone) {
    return (
      <Surface z={Z.phoneSurface} label={title || "Conversation"} trap={!t}>
        <div className="h-14 shrink-0 flex items-center gap-2 px-2 border-b border-rule bg-bg min-w-0">
          {back}
          {header && icon}
          <h1 className="min-w-0 flex-1 truncate text-[15px] font-bold">{title}</h1>
          <StatusPill engine={engine} />
        </div>
        {header && (
          <div className="shrink-0 flex gap-1 px-2 pt-1 border-b border-rule" role="tablist" aria-label="Conversation">
            {(["messages", "members"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={`h-11 px-3 text-[13.5px] font-semibold border-b-2 ${tab === k ? "border-ink text-ink" : "border-transparent text-ink-3"}`}
              >
                {k === "messages" ? "Messages" : isDm ? "People" : `Members · ${header.memberCount}`}
              </button>
            ))}
          </div>
        )}
        {main}
        {header && (tab === "messages" ? <>{thread}{joinBar}</> : <div className="pl-scroll flex-1">{details}</div>)}
        {replies}
      </Surface>
    );
  }

  return (
    <div className="flex flex-col min-h-0 flex-1 min-w-0">
      <PipelineHeader
        title={
          header ? (
            <span className="inline-flex items-center gap-2 min-w-0">
              {icon}
              <span className="truncate">{title}</span>
            </span>
          ) : (
            "Conversation"
          )
        }
        sub={sub}
        left={back}
        status={<StatusPill engine={engine} />}
        actions={
          header ? (
            <button
              type="button"
              onClick={() => setShowSide((v) => !v)}
              aria-pressed={showSide}
              className="h-11 px-3 inline-flex items-center gap-1.5 text-ink-3 hover:bg-muted text-[13px] font-semibold"
            >
              <Users size={16} aria-hidden />
              {isDm ? "Details" : header.memberCount}
            </button>
          ) : null
        }
      />
      {main}
      {header && (
        <div className="flex-1 min-h-0 flex min-w-0">
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            {thread}
            {joinBar}
          </div>
          {t ? (
            <aside className="w-[400px] shrink-0 min-h-0 border-l border-rule bg-surface" aria-label="Replies">
              {replies}
            </aside>
          ) : showSide ? (
            <aside className="w-[340px] shrink-0 min-h-0 border-l border-rule bg-surface pl-scroll" aria-label={isDm ? "Details" : "About and members"}>
              {details}
            </aside>
          ) : null}
        </div>
      )}
    </div>
  );
}
