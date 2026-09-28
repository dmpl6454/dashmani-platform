"use client";
/**
 * The main conversation (spec §9.6).
 *
 *   - Opens around the first unread with a "New messages" divider at the lastReadSeq the
 *     page opened with; a "↓ N new" pill appears when more than 120 px from the bottom.
 *   - "Load earlier" (30 at a time) keeps the reading position (scrollHeight before/after).
 *   - No content-visibility; at most ~100 rows render at once.
 *   - One author within 5 minutes is grouped.
 *   - A polite live region announces new messages only when you are not at the bottom.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { selectPendingSends, selectTopLevel, type PipelineMessage } from "@dashmani/shared";
import { usePipeline } from "../provider";
import { useStoreSelector } from "../store";
import { describeError, plApi } from "../api";
import { EmptyState } from "../ui/EmptyState";
import { LoadError } from "../ui/LoadError";
import { Skeleton } from "../ui/Skeleton";
import { type AckLedger, useSeenObserver } from "../hooks/use-seen-observer";
import { MessageItem, PendingRow } from "./MessageItem";
import { Composer } from "./Composer";

const RENDER_WINDOW = 100;
const GROUP_MS = 5 * 60_000;
const NEAR_BOTTOM_PX = 120;

export function Thread({
  projectId,
  readOnly,
  readOnlyReason,
  highlightId,
  ledger,
  onOpenReplies,
  onLoadNewer,
}: {
  projectId: string;
  readOnly: boolean;
  readOnlyReason: string | null;
  highlightId: string | null;
  ledger: AckLedger;
  onOpenReplies: (rootId: string) => void;
  onLoadNewer: () => Promise<void>;
}) {
  const { store, meId, notNotified } = usePipeline();
  const project = useStoreSelector(store, (s) => s.projects[projectId]);
  const top = useStoreSelector(store, (s) => (s.projects[projectId] ? selectTopLevel(s.projects[projectId]) : []));
  const pending = useStoreSelector(store, (s) => selectPendingSends(s, projectId, null));
  const scroller = useRef<HTMLDivElement>(null);
  const seen = useSeenObserver(scroller, ledger);
  const [windowSize, setWindowSize] = useState(RENDER_WINDOW);
  const [older, setOlder] = useState<"idle" | "loading" | "failed">("idle");
  const [olderError, setOlderError] = useState<string | null>(null);
  const [newer, setNewer] = useState<"idle" | "loading" | "failed">("idle");
  const [atBottom, setAtBottom] = useState(true);
  const [newSinceBottom, setNewSinceBottom] = useState(0);
  const live = useRef<HTMLParagraphElement>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const positioned = useRef(false);
  const lastSeq = useRef(0);

  // Deleted-with-no-replies rows are hidden; render at most the newest `windowSize`.
  const shown = useMemo(() => {
    const vis = top.filter((m) => !(m.deletedAt && m.replyCount === 0));
    return vis.length > windowSize ? vis.slice(vis.length - windowSize) : vis;
  }, [top, windowSize]);
  const hiddenAbove = top.length - shown.length;
  const divider = project?.dividerSeq ?? null;
  const firstUnread = useMemo(
    () => (divider === null ? null : shown.find((m) => m.seq > divider && m.authorId !== meId) ?? null),
    [shown, divider, meId],
  );

  const measureBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }, []);

  // Initial position: the first unread (or the bottom), once.
  useLayoutEffect(() => {
    if (positioned.current || !project?.header || highlightId) return;
    const el = scroller.current;
    if (!el) return;
    positioned.current = true;
    const target = firstUnread ? el.querySelector<HTMLElement>(`[data-divider]`) : null;
    if (target) target.scrollIntoView({ block: "start" });
    else el.scrollTop = el.scrollHeight;
  }, [project?.header, firstUnread, highlightId]);

  // Keep "Load earlier" from jumping: restore the distance from the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    const a = anchor.current;
    if (!el || !a) return;
    el.scrollTop = el.scrollHeight - a.height + a.top;
    anchor.current = null;
  }, [shown]);

  // New messages: follow when at the bottom; otherwise count and announce.
  useEffect(() => {
    const newest = top[top.length - 1];
    const seq = newest?.seq ?? 0;
    if (lastSeq.current === 0) {
      lastSeq.current = seq;
      return;
    }
    if (seq <= lastSeq.current) return;
    const added = top.filter((m) => m.seq > lastSeq.current && m.authorId !== meId).length;
    lastSeq.current = seq;
    if (atBottom || newest?.authorId === meId) {
      requestAnimationFrame(() => {
        const el = scroller.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    } else if (added > 0) {
      setNewSinceBottom((n) => n + added);
      if (live.current) live.current.textContent = `${added} new message${added === 1 ? "" : "s"}`;
    }
  }, [top, atBottom, meId]);

  useEffect(() => {
    if (pending.length && atBottom) {
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [pending.length, atBottom]);

  // Auto-chain "newer" pages (the page opened around the first unread).
  const chained = useRef(0);
  useEffect(() => {
    if (!project?.hasNewer || newer === "loading" || chained.current >= 3) return;
    chained.current++;
    setNewer("loading");
    onLoadNewer().then(
      () => setNewer("idle"),
      () => setNewer("failed"),
    );
  }, [project?.hasNewer, newer, onLoadNewer]);

  const loadEarlier = async () => {
    if (hiddenAbove > 0) {
      const el = scroller.current;
      if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      setWindowSize((w) => w + 30);
      return;
    }
    const first = top[0];
    if (!first || older === "loading") return;
    setOlder("loading");
    setOlderError(null);
    try {
      const page = await plApi.olderMessages(projectId, first.seq, 30);
      const el = scroller.current;
      if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      setWindowSize((w) => w + page.messages.length);
      store.dispatch({ type: "olderMessages", projectId, page });
      setOlder("idle");
    } catch (e) {
      setOlder("failed");
      setOlderError(describeError(e));
    }
  };

  const onScroll = () => {
    const b = measureBottom();
    if (b !== atBottom) setAtBottom(b);
    if (b && newSinceBottom) setNewSinceBottom(0);
  };

  const jumpToBottom = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setNewSinceBottom(0);
  };

  // Highlight + scroll a deep-linked message (the page drives loading it).
  useEffect(() => {
    if (!highlightId) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-msg-id="${highlightId}"]`);
    if (el) {
      positioned.current = true;
      el.scrollIntoView({ block: "center" });
    }
  }, [highlightId, shown]);

  const interesting = useCallback(
    (m: PipelineMessage) => {
      if (m.mentions.some((x) => x.id === meId)) return true;
      if (!m.parentId) return false;
      return project?.messages[m.parentId]?.authorId === meId;
    },
    [meId, project?.messages],
  );

  let body: React.ReactNode;
  if (!project?.header) {
    body = (
      <div className="p-4 space-y-4" role="status" aria-label="Loading messages">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-2.5">
            <Skeleton className="h-7 w-7 rounded-full" />
            <Skeleton className="h-14 flex-1" />
          </div>
        ))}
      </div>
    );
  } else if (shown.length === 0 && pending.length === 0 && !project.hasOlder) {
    body = <EmptyState title="No messages yet — start the conversation" />;
  } else {
    body = (
      <ul className="py-2">
        {(project.hasOlder || hiddenAbove > 0) && (
          <li className="list-none px-3 py-2 text-center">
            {older === "failed" ? (
              <LoadError compact title="Couldn't load earlier messages" reason={olderError} onRetry={() => void loadEarlier()} />
            ) : older === "loading" ? (
              <div className="space-y-2" role="status" aria-label="Loading earlier messages">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-2/3" />
              </div>
            ) : (
              <button type="button" onClick={() => void loadEarlier()} className="h-11 px-4 rounded-xl border border-border text-[13px] font-semibold text-ink hover:bg-muted">
                Load earlier
              </button>
            )}
          </li>
        )}
        {shown.map((m, i) => {
          const prev = shown[i - 1];
          const grouped =
            !!prev && !prev.deletedAt && prev.authorId === m.authorId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_MS && m.id !== firstUnread?.id;
          return (
            <FragmentWithDivider key={m.id} showDivider={m.id === firstUnread?.id}>
              <MessageItem
                message={m}
                grouped={grouped}
                readOnly={readOnly}
                highlight={m.id === highlightId}
                notNotified={notNotified[m.id]}
                observeRef={seen.observe({ seq: m.seq, id: m.id, interesting: interesting(m) })}
                onOpenReplies={onOpenReplies}
              />
            </FragmentWithDivider>
          );
        })}
        {project.hasNewer && (
          <li className="list-none px-3 py-2 text-center">
            {newer === "failed" ? (
              <LoadError compact title="Couldn't load newer messages" onRetry={() => { chained.current = 0; setNewer("idle"); }} />
            ) : (
              <button
                type="button"
                disabled={newer === "loading"}
                onClick={() => {
                  setNewer("loading");
                  onLoadNewer().then(() => setNewer("idle"), () => setNewer("failed"));
                }}
                className="h-11 px-4 rounded-xl border border-border text-[13px] font-semibold text-ink hover:bg-muted disabled:opacity-60"
              >
                {newer === "loading" ? "Loading…" : "Load newer messages"}
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

  const participantIds = useMemo(() => (project?.participants ?? []).map((p) => p.userId), [project?.participants]);

  return (
    <div className="relative flex flex-col min-h-0 flex-1 min-w-0">
      <p ref={live} className="sr-only" aria-live="polite" />
      <div ref={scroller} onScroll={onScroll} className="pl-scroll flex-1 min-w-0" role="log" aria-label="Conversation">
        {body}
      </div>
      {newSinceBottom > 0 && !atBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute left-1/2 -translate-x-1/2 bottom-[88px] h-11 px-4 inline-flex items-center gap-1.5 rounded-full bg-ink text-white text-[13px] font-semibold shadow-pop"
        >
          <ArrowDown size={14} /> {newSinceBottom} new
        </button>
      )}
      <Composer
        projectId={projectId}
        parentId={null}
        readOnly={readOnly}
        readOnlyReason={readOnlyReason}
        participantIds={participantIds}
        placeholder="Write a message"
      />
    </div>
  );
}

function FragmentWithDivider({ showDivider, children }: { showDivider: boolean; children: React.ReactNode }) {
  return (
    <>
      {showDivider && (
        <li data-divider className="list-none flex items-center gap-2 px-3 py-2" aria-label="New messages">
          <span className="h-px flex-1 bg-danger/40" />
          <span className="text-[11.5px] font-bold text-danger">New messages</span>
          <span className="h-px flex-1 bg-danger/40" />
        </li>
      )}
      {children}
    </>
  );
}
