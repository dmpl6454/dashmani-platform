"use client";
/**
 * Members and followers (routes #11–14). Buttons show only what `can` / the removal rule
 * allows; every action is still re-checked by the server and a refusal is said in words.
 */
import { useEffect, useMemo, useState } from "react";
import {
  PIPELINE_LIMITS,
  isWithinUndoWindow,
  undoWindowEndsAt,
  type PipelineCan,
  type PipelineHeader,
  type PipelineMe,
  type PipelineParticipant,
} from "@dashmani/shared";
import { usePipeline } from "../provider";
import { Initials } from "../ui/Initials";
import { useToast } from "../ui/Toast";
import { describeError, plApi } from "../api";
import { PeoplePicker } from "./PeoplePicker";

/**
 * The adder's 10-minute undo, EXACTLY as the server checks it (participants.ts removeMember):
 * a MEMBER row this user added, timed from member_added_at (B8). A promoted follower's
 * createdAt is their old follow time, so it is used only when an older API omits the field.
 * A FOLLOWER row, or an expired window, would only earn a 403 — so no button.
 */
const undoStart = (p: PipelineParticipant) => p.memberAddedAt ?? p.createdAt;
const adderMayUndo = (p: PipelineParticipant, meId: string) => p.role === "MEMBER" && p.memberAddedById === meId;

export function MembersPanel({
  header,
  participants,
  me,
  can,
  readOnly,
}: {
  header: PipelineHeader;
  participants: PipelineParticipant[];
  me: PipelineMe | null;
  can: PipelineCan | null;
  readOnly: boolean;
}) {
  const { meId, dirById, store, engine } = usePipeline();
  const toast = useToast();
  const [adding, setAdding] = useState<string[]>([]);
  const [owner, setOwner] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const members = useMemo(
    () => participants.filter((p) => p.role === "MEMBER").sort((a, b) => Number(b.isOwner) - Number(a.isOwner)),
    [participants],
  );

  // "Remove" must disappear when the window closes, not at the next unrelated re-render: one
  // timer, for the earliest window still open, re-armed by the render it triggers.
  const now = Date.now();
  let nextExpiry: number | null = null;
  if (!readOnly && !can?.removeOthers) {
    for (const p of participants) {
      if (p.isOwner || p.userId === meId || !adderMayUndo(p, meId)) continue;
      const end = undoWindowEndsAt(undoStart(p));
      if (end !== null && end > now && (nextExpiry === null || end < nextExpiry)) nextExpiry = end;
    }
  }
  const [, setExpiryTick] = useState(0);
  useEffect(() => {
    if (nextExpiry === null) return;
    const t = setTimeout(() => setExpiryTick((n) => n + 1), Math.max(0, nextExpiry - Date.now()) + 250);
    return () => clearTimeout(t);
  }, [nextExpiry]);
  const followers = useMemo(() => participants.filter((p) => p.role === "FOLLOWER"), [participants]);
  const memberIds = members.map((p) => p.userId);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
      engine.afterWrite();
    } catch (e) {
      toast.show({ text: describeError(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const canRemove = (p: PipelineParticipant) => {
    if (readOnly || p.isOwner) return false;
    if (p.userId === meId) return true; // leave
    if (can?.removeOthers) return true;
    return adderMayUndo(p, meId) && isWithinUndoWindow(undoStart(p), now);
  };

  const remove = (p: PipelineParticipant) =>
    run(`rm:${p.userId}`, async () => {
      await plApi.removeMember(header.id, p.userId);
      // Participants arrive with the post-write sync (header_rev moved); no thread reload.
    });

  const row = (p: PipelineParticipant) => {
    const d = dirById.get(p.userId);
    return (
      <li key={p.userId} className="flex items-center gap-2.5 min-w-0 py-1">
        <Initials userId={p.userId} name={d?.name} initials={d?.initials} size={28} />
        <span className="pl-name min-w-0 flex-1 truncate text-[13.5px] text-ink">
          {d?.name ?? "Former member"}
          {d?.hint && <span className="text-ink-4"> · {d.hint}</span>}
          {d && !d.active && <span className="text-ink-4"> · inactive</span>}
        </span>
        {p.isOwner && <span className="text-[11px] font-bold text-indigo">Owner</span>}
        {canRemove(p) && (
          <button
            type="button"
            disabled={busy === `rm:${p.userId}`}
            onClick={() => void remove(p)}
            className="h-11 px-2 text-[12.5px] font-semibold text-ink-3 hover:text-danger disabled:opacity-50"
          >
            {p.userId === meId ? "Leave" : "Remove"}
          </button>
        )}
      </li>
    );
  };

  const following = me?.role === "FOLLOWER" || (me?.role === "MEMBER" && me.notify);

  return (
    <section aria-label="Members" className="p-4 space-y-4 border-t border-rule">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-[13px] font-bold text-ink">Members · {header.memberCount}</h3>
        {!readOnly && me?.role !== "MEMBER" && (
          <button
            type="button"
            disabled={busy === "follow"}
            onClick={() =>
              void run("follow", async () => {
                const r = await plApi.follow(header.id, !following);
                store.dispatch({ type: "meUpsert", projectId: header.id, me: { role: r.role, notify: r.notify } });
              })
            }
            className="h-11 px-3 rounded-xl border border-border text-[12.5px] font-semibold disabled:opacity-50"
          >
            {following ? "Unfollow" : "Follow"}
          </button>
        )}
        {!readOnly && me?.role === "MEMBER" && (
          <button
            type="button"
            disabled={busy === "follow"}
            onClick={() =>
              void run("follow", async () => {
                const r = await plApi.follow(header.id, !me.notify);
                store.dispatch({ type: "meUpsert", projectId: header.id, me: { role: r.role, notify: r.notify } });
              })
            }
            className="h-11 px-3 rounded-xl border border-border text-[12.5px] font-semibold disabled:opacity-50"
          >
            {me.notify ? "Mute notifications" : "Get notifications"}
          </button>
        )}
      </div>
      <ul>{members.map(row)}</ul>
      {followers.length > 0 && (
        <div>
          <h3 className="text-[12px] font-bold text-ink-3 mb-1">Following · {followers.length}</h3>
          <ul>{followers.map(row)}</ul>
        </div>
      )}
      {!readOnly && (
        <div className="space-y-2">
          <PeoplePicker value={adding} onChange={setAdding} exclude={memberIds} max={PIPELINE_LIMITS.membersPerRequestMax} label="Add members" />
          {adding.length > 0 && (
            <button
              type="button"
              disabled={busy === "add"}
              onClick={() =>
                void run("add", async () => {
                  const r = await plApi.addMembers(header.id, adding);
                  store.dispatch({ type: "participantsUpsert", projectId: header.id, participants: r.participants });
                  setAdding([]);
                  toast.show({ text: r.added.length ? `Added ${r.added.length} ${r.added.length === 1 ? "person" : "people"}` : "They were already members" });
                })
              }
              className="h-11 px-4 rounded-xl bg-ink text-white text-[13px] font-semibold disabled:opacity-50"
            >
              {busy === "add" ? "Adding…" : `Add ${adding.length}`}
            </button>
          )}
        </div>
      )}
      {!readOnly && can?.transferOwner && (
        <div className="space-y-2">
          <PeoplePicker value={owner} onChange={setOwner} exclude={[header.ownerId]} single label="Transfer ownership to" />
          {owner.length === 1 && (
            <button
              type="button"
              disabled={busy === "owner"}
              onClick={() =>
                void run("owner", async () => {
                  const r = await plApi.transferOwner(header.id, owner[0]);
                  store.dispatch({ type: "headerUpsert", header: r.header });
                  setOwner([]);
                  toast.show({ text: `${dirById.get(r.header.ownerId)?.name ?? "They"} now own this project` });
                })
              }
              className="h-11 px-4 rounded-xl border border-border text-[13px] font-semibold disabled:opacity-50"
            >
              {busy === "owner" ? "Transferring…" : "Transfer ownership"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
