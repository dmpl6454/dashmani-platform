"use client";
/**
 * One message row (spec §9.6). Every message has an always-rendered, tabbable "More
 * actions" button (React · Reply · Copy text · Copy link · Edit / Delete if yours); no
 * control is hover-only. Replies show "3 replies · 5m" which opens the ReplySheet.
 */
import { memo, useState } from "react";
import { Ellipsis, MessageSquare } from "lucide-react";
import { parseDraft, serializeDraft, shiftRanges, type PendingSend, type PipelineMessage, type PipelineNotNotified } from "@dashmani/shared";
import { usePipeline } from "../provider";
import { Initials } from "../ui/Initials";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import { describeError, plApi } from "../api";
import { MessageBody } from "./MessageBody";
import { ReactionBar, useToggleReaction } from "./ReactionBar";
import { ReactionPicker } from "./ReactionPicker";

export function timeLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ${hm}`;
}

export function agoShort(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const REASON: Record<string, string> = { inactive: "account inactive", not_in_pilot: "not in the pilot yet", unknown: "unknown person" };

function plainText(body: string, nameOf: (id: string) => string): string {
  return parseDraft(body, nameOf).text;
}

async function copy(text: string, toast: ReturnType<typeof useToast>, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.show({ text: `${what} copied`, duration: 2000 });
  } catch {
    toast.show({ text: `Couldn't copy the ${what.toLowerCase()} — select it and copy instead.`, tone: "error" });
  }
}

function MessageItemImpl({
  message: m,
  grouped,
  readOnly,
  highlight,
  inReplies = false,
  notNotified,
  observeRef,
  onOpenReplies,
}: {
  message: PipelineMessage;
  grouped: boolean;
  readOnly: boolean;
  highlight: boolean;
  inReplies?: boolean;
  notNotified?: PipelineNotNotified[];
  observeRef?: (el: HTMLElement | null) => void;
  onOpenReplies?: (rootId: string) => void;
}) {
  const { meId, dirById, boot, store, engine, setNotNotified } = usePipeline();
  const toast = useToast();
  const toggle = useToggleReaction();
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const [editing, setEditing] = useState<{ text: string; ranges: ReturnType<typeof parseDraft>["ranges"] } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const mine = m.authorId === meId;
  const nameOf = (id: string) => dirById.get(id)?.name ?? m.mentions.find((x) => x.id === id)?.name ?? "someone";
  const author = dirById.get(m.authorId)?.name ?? m.authorName;

  if (m.deletedAt) {
    if (m.replyCount === 0 && !inReplies) return null;
    return (
      <li ref={observeRef} data-msg-id={m.id} className="list-none px-3 py-2 text-[13px] italic text-ink-4">
        This message was deleted
        {m.replyCount > 0 && onOpenReplies && (
          <button type="button" onClick={() => onOpenReplies(m.id)} className="ml-2 h-11 px-2 not-italic font-semibold text-indigo">
            {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}
          </button>
        )}
      </li>
    );
  }

  const myReactions = new Set(Object.entries(m.reactions).filter(([, ids]) => ids?.includes(meId)).map(([k]) => k));
  const link = () => `${window.location.origin}/pipeline/${m.projectId}?m=${m.id}${m.parentId ? `&t=${m.parentId}` : ""}`;

  const saveEdit = async () => {
    if (!editing) return;
    const body = serializeDraft(editing.text, editing.ranges);
    if (!editing.text.trim()) return;
    setBusy(true);
    setEditError(null);
    try {
      const r = await plApi.editMessage(m.id, body);
      store.dispatch({ type: "messageUpsert", message: r.message });
      if (r.notNotified.length) setNotNotified(r.message.id, r.notNotified);
      engine.afterWrite();
      setEditing(null);
    } catch (e) {
      setEditError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      const r = await plApi.deleteMessage(m.id);
      store.dispatch({ type: "messageUpsert", message: r.message });
      engine.afterWrite();
      setConfirmDelete(false);
    } catch (e) {
      toast.show({ text: describeError(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      ref={observeRef}
      data-msg-id={m.id}
      className={`list-none group relative flex gap-2.5 px-3 ${grouped ? "pt-0.5" : "pt-3"} pb-1 rounded-xl ${highlight ? "pl-highlight" : ""}`}
    >
      <div className="w-7 shrink-0">{!grouped && <Initials userId={m.authorId} name={author} initials={dirById.get(m.authorId)?.initials} size={28} />}</div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="pl-name min-w-0 truncate text-[13.5px] font-bold text-ink">{author}</span>
            <time dateTime={m.createdAt} className="text-[11.5px] text-ink-4 whitespace-nowrap">
              {timeLabel(m.createdAt)}
            </time>
          </div>
        )}
        <MessageBody body={m.body} mentions={m.mentions} meId={meId} />
        {m.editedAt && <span className="text-[11px] text-ink-4">(edited)</span>}
        {mine && notNotified && notNotified.length > 0 && (
          <p className="mt-1 text-[12px] text-attention">
            {notNotified.map((n) => `${nameOf(n.id)} wasn't notified — ${REASON[n.reason] ?? "unavailable"}`).join(" · ")}
          </p>
        )}
        <ReactionBar message={m} readOnly={readOnly} />
        {!inReplies && m.replyCount > 0 && onOpenReplies && (
          <button type="button" onClick={() => onOpenReplies(m.id)} className="mt-1 h-11 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-indigo">
            <MessageSquare size={14} />
            {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}
            {m.lastReplyAt && <span className="text-ink-4 font-medium">· {agoShort(m.lastReplyAt)}</span>}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => setMenu(true)}
        aria-label={`More actions for the message from ${author}`}
        className="shrink-0 h-11 w-11 grid place-items-center rounded-xl text-ink-4 hover:bg-muted self-start"
      >
        <Ellipsis size={18} />
      </button>

      <Sheet open={menu} onClose={() => setMenu(false)} title="Message">
        <div className="grid gap-1.5">
          {!readOnly && (
            <ActionBtn onClick={() => { setMenu(false); setPicker(true); }}>React</ActionBtn>
          )}
          {!readOnly && !inReplies && onOpenReplies && (
            <ActionBtn onClick={() => { setMenu(false); onOpenReplies(m.parentId ?? m.id); }}>Reply</ActionBtn>
          )}
          <ActionBtn onClick={() => { setMenu(false); void copy(plainText(m.body, nameOf), toast, "Text"); }}>Copy text</ActionBtn>
          <ActionBtn onClick={() => { setMenu(false); void copy(link(), toast, "Link"); }}>Copy link</ActionBtn>
          {mine && !readOnly && (
            <ActionBtn
              onClick={() => {
                setMenu(false);
                setEditError(null);
                setEditing(parseDraft(m.body, nameOf));
              }}
            >
              Edit
            </ActionBtn>
          )}
          {mine && (
            <ActionBtn danger onClick={() => { setMenu(false); setConfirmDelete(true); }}>
              Delete
            </ActionBtn>
          )}
        </div>
      </Sheet>

      <ReactionPicker
        open={picker}
        options={boot.reactions}
        mine={myReactions}
        onClose={() => setPicker(false)}
        onPick={(k) => void toggle(m, k, !myReactions.has(k))}
      />

      <Sheet
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit message"
        footer={
          <div className="flex items-center gap-2">
            {editError && <p role="alert" className="min-w-0 flex-1 text-[12.5px] text-danger">{editError}</p>}
            <button type="button" onClick={() => void saveEdit()} disabled={busy || !editing?.text.trim()} className="ml-auto h-11 px-5 rounded-xl bg-ink text-white text-[14px] font-semibold disabled:opacity-50">
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        }
      >
        {editing && (
          <textarea
            data-autofocus
            aria-label="Message text"
            value={editing.text}
            onChange={(e) => {
              const next = e.target.value;
              setEditing((cur) => (cur ? { text: next, ranges: shiftRanges(cur.ranges, cur.text, next) } : cur));
            }}
            rows={6}
            className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo"
          />
        )}
      </Sheet>

      <Sheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this message?"
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmDelete(false)} className="h-11 px-4 rounded-xl border border-border text-[14px] font-semibold">
              Cancel
            </button>
            <button type="button" onClick={() => void doDelete()} disabled={busy} className="h-11 px-4 rounded-xl bg-danger text-white text-[14px] font-semibold disabled:opacity-50">
              {busy ? "Deleting…" : "Delete"}
            </button>
          </div>
        }
      >
        <p className="text-[14px] text-ink-2">Everyone will see “This message was deleted” where it was. This can&apos;t be undone.</p>
      </Sheet>
    </li>
  );
}

function ActionBtn({ children, onClick, danger = false }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={`h-12 px-3 rounded-xl text-left text-[14.5px] font-semibold hover:bg-muted ${danger ? "text-danger" : "text-ink"}`}>
      {children}
    </button>
  );
}

export const MessageItem = memo(MessageItemImpl);

/** A pending (optimistic) send, laid over the server rows. Nothing is ever dropped silently. */
export function PendingRow({ send }: { send: PendingSend }) {
  const { meId, dirById, retrySend, discardSend } = usePipeline();
  const toast = useToast();
  const me = dirById.get(meId);
  const nameOf = (id: string) => dirById.get(id)?.name ?? "someone";
  const mentions = parseDraft(send.body, nameOf).ranges.map((r) => ({ id: r.userId, name: nameOf(r.userId) }));
  const stale = send.status === "failed" && send.attempts === 0;
  let status: React.ReactNode;
  switch (send.status) {
    case "sending":
    case "retrying":
      status = <span className="text-ink-4">Sending…</span>;
      break;
    case "held":
      status = <span className="text-ink-3">{send.note ?? "Sending is slowed down — retrying shortly"}</span>;
      break;
    case "failed":
      status = (
        <span className="text-danger">
          {stale ? `Unsent message from ${timeLabel(new Date(send.createdAt).toISOString())}` : "Couldn't send"}
          {" · "}
          <button type="button" onClick={() => retrySend(send.clientId)} className="h-11 px-1 font-semibold underline">
            {stale ? "Send" : "Tap to retry (it won't post twice)"}
          </button>
          {" · "}
          <button type="button" onClick={() => discardSend(send.clientId)} className="h-11 px-1 font-semibold underline">
            Discard
          </button>
        </span>
      );
      break;
    case "blocked":
      status = (
        <span className="text-danger">
          {send.note}
          {" · "}
          <button
            type="button"
            onClick={() => void copy(plainText(send.body, nameOf), toast, "Text")}
            className="h-11 px-1 font-semibold underline"
          >
            Copy
          </button>
          {" · "}
          <button type="button" onClick={() => discardSend(send.clientId)} className="h-11 px-1 font-semibold underline">
            Discard
          </button>
        </span>
      );
      break;
  }
  return (
    <li className="list-none flex gap-2.5 px-3 pt-3 pb-1 opacity-90">
      <div className="w-7 shrink-0">
        <Initials userId={meId} name={me?.name} initials={me?.initials} size={28} />
      </div>
      <div className="min-w-0 flex-1">
        <MessageBody body={send.body} mentions={mentions} meId={meId} />
        <p className="mt-0.5 text-[12px]" role="status">
          {status}
        </p>
      </div>
    </li>
  );
}
