"use client";
/**
 * Replies to one root message (spec §9.6). Full-screen and portalled on phones, a 400 px
 * side panel on desktop. It is opened by pushing `?t=<rootId>`, so the browser / Android
 * back button closes it. Honest states: its own skeleton, and "Couldn't load replies ·
 * Retry" — never an empty list under "3 replies".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, X } from "lucide-react";
import { selectPendingSends, selectReplies, type PipelineMessage } from "@dashmani/shared";
import { usePipeline } from "../provider";
import { useStoreSelector } from "../store";
import { describeError, isApiError, plApi } from "../api";
import { LoadError } from "../ui/LoadError";
import { Skeleton } from "../ui/Skeleton";
import { Surface } from "../ui/Surface";
import { Z } from "../constants";
import { type AckLedger, useSeenObserver } from "../hooks/use-seen-observer";
import { MessageItem, PendingRow } from "./MessageItem";
import { Composer } from "./Composer";

export function ReplySheet({
  projectId,
  rootId,
  phone,
  readOnly,
  readOnlyReason,
  highlightId,
  ledger,
  onClose,
}: {
  projectId: string;
  rootId: string;
  phone: boolean;
  readOnly: boolean;
  readOnlyReason: string | null;
  highlightId: string | null;
  ledger: AckLedger;
  onClose: () => void;
}) {
  const { store, meId, notNotified } = usePipeline();
  const root = useStoreSelector(store, (s) => s.projects[projectId]?.messages[rootId] ?? null);
  const replies = useStoreSelector(store, (s) => (s.projects[projectId] ? selectReplies(s.projects[projectId], rootId) : []));
  const hasMore = useStoreSelector(store, (s) => s.projects[projectId]?.replyPages[rootId]?.hasMore ?? false);
  const participants = useStoreSelector(store, (s) => s.projects[projectId]?.participants ?? []);
  const pending = useStoreSelector(store, (s) => selectPendingSends(s, projectId, rootId));
  const [state, setState] = useState<"loading" | "ok" | "failed" | "gone">("loading");
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useSeenObserver(scroller, ledger);

  const load = useCallback(async () => {
    setState("loading");
    setError(null);
    try {
      const page = await plApi.replies(rootId, null, 50);
      store.dispatch({ type: "repliesPage", projectId, page });
      setState("ok");
    } catch (e) {
      if (isApiError(e) && e.status === 404) setState("gone");
      else {
        setError(describeError(e));
        setState("failed");
      }
    }
  }, [rootId, projectId, store]);

  useEffect(() => {
    void load();
  }, [load]);

  const interesting = useCallback(
    (m: PipelineMessage) => m.mentions.some((x) => x.id === meId) || (m.parentId !== null && root?.authorId === meId),
    [meId, root?.authorId],
  );

  // Opening the sheet counts as seeing the root when it mentions me.
  useEffect(() => {
    if (state === "ok" && root && root.mentions.some((x) => x.id === meId)) ledger.markSeenId(root.id);
  }, [state, root, meId, ledger]);

  useEffect(() => {
    if (!highlightId || state !== "ok") return;
    scroller.current?.querySelector<HTMLElement>(`[data-msg-id="${highlightId}"]`)?.scrollIntoView({ block: "center" });
  }, [highlightId, state, replies.length]);

  useEffect(() => {
    if (pending.length) {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [pending.length]);

  const loadMore = async () => {
    const last = replies[replies.length - 1];
    setMore("loading");
    try {
      const page = await plApi.replies(rootId, last ? last.seq : null, 50);
      store.dispatch({ type: "repliesPage", projectId, page });
      setMore("idle");
    } catch {
      setMore("failed");
    }
  };

  const participantIds = useMemo(() => participants.map((p) => p.userId), [participants]);
  const replyReadOnly = readOnly || !!root?.deletedAt;

  let body: React.ReactNode;
  if (state === "gone") {
    body = <p className="px-4 py-10 text-center text-[14px] text-ink-3">That message is no longer available.</p>;
  } else if (state === "failed" && !root) {
    body = <LoadError title="Couldn't load replies" reason={error} onRetry={() => void load()} />;
  } else if (!root) {
    body = (
      <div className="p-4 space-y-3" role="status" aria-label="Loading replies">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-12 w-4/5" />
      </div>
    );
  } else {
    body = (
      <ul className="py-2">
        <MessageItem message={root} grouped={false} readOnly={replyReadOnly} highlight={root.id === highlightId} inReplies notNotified={notNotified[root.id]} />
        <li className="list-none px-3 py-1.5 text-[12px] font-semibold text-ink-3 border-b border-rule">
          {root.replyCount} {root.replyCount === 1 ? "reply" : "replies"}
        </li>
        {state === "failed" && <LoadError compact title="Couldn't load replies" reason={error} onRetry={() => void load()} />}
        {state === "loading" && replies.length === 0 && root.replyCount > 0 && (
          <li className="list-none p-3 space-y-2" role="status" aria-label="Loading replies">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-2/3" />
          </li>
        )}
        {state === "ok" && replies.length === 0 && pending.length === 0 && (
          <li className="list-none px-3 py-6 text-center text-[13px] text-ink-4">No replies yet — start the thread</li>
        )}
        {replies.map((m, i) => {
          const prev = replies[i - 1];
          const grouped = !!prev && prev.authorId === m.authorId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
          return (
            <MessageItem
              key={m.id}
              message={m}
              grouped={grouped}
              readOnly={replyReadOnly}
              highlight={m.id === highlightId}
              inReplies
              notNotified={notNotified[m.id]}
              observeRef={seen.observe({ seq: m.seq, id: m.id, interesting: interesting(m) })}
            />
          );
        })}
        {hasMore && (
          <li className="list-none px-3 py-2 text-center">
            {more === "failed" ? (
              <LoadError compact title="Couldn't load more replies" onRetry={() => void loadMore()} />
            ) : (
              <button type="button" onClick={() => void loadMore()} disabled={more === "loading"} className="h-11 px-4 rounded-xl border border-border text-[13px] font-semibold disabled:opacity-60">
                {more === "loading" ? "Loading…" : "Load more replies"}
              </button>
            )}
          </li>
        )}
        {pending.map((p) => (
          <PendingRow key={p.clientId} send={p} />
        ))}
      </ul>
    );
  }

  const content = (
    <div className="flex flex-col min-h-0 h-full">
      <div className="h-14 shrink-0 flex items-center gap-2 px-2 border-b border-rule">
        <button type="button" onClick={onClose} aria-label="Close replies" className="h-11 w-11 grid place-items-center rounded-xl text-ink-3 hover:bg-muted">
          {phone ? <ChevronLeft size={20} /> : <X size={18} />}
        </button>
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-bold">Replies</h2>
      </div>
      <div ref={scroller} className="pl-scroll flex-1 min-w-0">
        {body}
      </div>
      {root && (
        <Composer
          projectId={projectId}
          parentId={rootId}
          readOnly={replyReadOnly}
          readOnlyReason={root.deletedAt ? "The message was deleted — post in the main conversation instead." : readOnlyReason}
          participantIds={participantIds}
          placeholder="Reply"
          autoFocus={!phone}
        />
      )}
    </div>
  );

  if (phone) {
    return (
      <Surface z={Z.sheet} label="Replies" onEscape={onClose}>
        {content}
      </Surface>
    );
  }
  return <div className="h-full min-h-0">{content}</div>;
}
