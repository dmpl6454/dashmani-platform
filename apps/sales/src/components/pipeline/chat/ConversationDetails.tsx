"use client";
/**
 * A channel's "About & members" panel (a DM shows just the two people). Buttons follow the
 * Slack rules the server enforces (conversations.service.ts): any member adds people; the
 * owner or an admin renames, edits the description, switches Public ↔ Private and removes
 * people, or deletes the channel; anyone leaves. `isAdminHint` only shows buttons — the server re-checks.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Hash, Lock, Trash2 } from "lucide-react";
import { pipelineValidators as V, type PipelineHeader, type PipelineMe, type PipelineParticipant } from "@dashmani/shared";
import { usePipeline } from "../provider";
import { Initials } from "../ui/Initials";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import { PeoplePicker } from "../project/PeoplePicker";
import { describeError, plApi } from "../api";
import { DeleteChannelSheet } from "./DeleteChannelSheet";
import { HideDmSheet } from "./HideDmSheet";

export function ConversationDetails({
  header,
  participants,
  me,
  online,
  onChanged,
}: {
  header: PipelineHeader;
  participants: PipelineParticipant[];
  me: PipelineMe | null;
  online: ReadonlySet<string>;
  onChanged: () => Promise<void> | void;
}) {
  const { meId, dirById, boot } = usePipeline();
  const router = useRouter();
  const toast = useToast();
  const isChannel = header.kind === "channel";
  const isMember = !!me?.role;
  const isOwner = header.ownerId === meId;
  const manage = isOwner || boot.me.isAdmin === true;
  const [adding, setAdding] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(header.title);
  const [description, setDescription] = useState(header.description);
  const [confirmPrivacy, setConfirmPrivacy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [hiding, setHiding] = useState(false);

  const members = [...participants].sort((a, b) => Number(b.userId === header.ownerId) - Number(a.userId === header.ownerId));
  const nameOf = (id: string) => dirById.get(id)?.name ?? "Unknown user";

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      await onChanged();
      if (done) toast.show({ text: done });
    } catch (e) {
      toast.show({ text: describeError(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-4 space-y-6">
      {isChannel && (
        <section aria-labelledby="about-h">
          <div className="flex items-center justify-between">
            <h2 id="about-h" className="text-[13px] font-bold uppercase tracking-wide text-ink-3">
              About
            </h2>
            {manage && !editing && (
              <button type="button" className="text-[13px] font-semibold text-indigo-light" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
          </div>
          {editing ? (
            <form
              className="mt-2 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                const slug = V.slugifyChannelName(name);
                void run(
                  "edit",
                  () =>
                    plApi.editChannel(header.id, {
                      ...(slug && slug !== header.title ? { name: slug } : {}),
                      ...(description !== header.description ? { description } : {}),
                    }),
                  "Channel updated",
                ).then(() => setEditing(false));
              }}
            >
              <input aria-label="Channel name" value={name} onChange={(e) => setName(e.target.value)} className="w-full h-10 px-3 border border-border bg-bg text-[14px]" />
              <textarea
                aria-label="Description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 border border-border bg-bg text-[14px]"
              />
              <div className="flex gap-2">
                <button type="submit" disabled={busy === "edit"} className="h-9 px-3 bg-indigo text-white text-[13px] font-semibold">
                  Save
                </button>
                <button type="button" onClick={() => setEditing(false)} className="h-9 px-3 border border-border text-[13px] font-semibold">
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <p className="mt-2 text-[14px] text-ink-2 whitespace-pre-wrap">{header.description || <span className="text-ink-4">No description</span>}</p>
          )}

          <div className="mt-4 flex items-center justify-between gap-3 p-3 border border-border">
            <span className="flex items-center gap-2 text-[14px]">
              {header.isPrivate ? <Lock size={15} aria-hidden /> : <Hash size={15} aria-hidden />}
              <span>
                <span className="block font-semibold text-ink">{header.isPrivate ? "Private channel" : "Public channel"}</span>
                <span className="block text-[12.5px] text-ink-3">{header.isPrivate ? "Only members can see it." : "Anyone can find and join it."}</span>
              </span>
            </span>
            {manage && (
              <button type="button" onClick={() => setConfirmPrivacy(true)} className="shrink-0 h-9 px-3 border border-border text-[13px] font-semibold">
                Make {header.isPrivate ? "public" : "private"}
              </button>
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="members-h">
        <h2 id="members-h" className="text-[13px] font-bold uppercase tracking-wide text-ink-3">
          {isChannel ? `Members · ${participants.length}` : "People"}
        </h2>
        <ul className="mt-2 space-y-1">
          {members.map((p) => (
            <li key={p.userId} className="flex items-center gap-2.5 min-h-10">
              <span className="relative">
                <Initials userId={p.userId} name={nameOf(p.userId)} size={28} />
                <span
                  className={`absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full border-2 border-surface ${online.has(p.userId) ? "bg-success" : "bg-ink-4"}`}
                  aria-label={online.has(p.userId) ? "Online" : "Away"}
                />
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
                {nameOf(p.userId)}
                {p.userId === meId && <span className="text-ink-4"> (you)</span>}
                {isChannel && p.userId === header.ownerId && <span className="ml-1.5 text-[12px] text-ink-3">Owner</span>}
              </span>
              {isChannel && manage && p.userId !== header.ownerId && p.userId !== meId && (
                <button
                  type="button"
                  disabled={busy === p.userId}
                  onClick={() => void run(p.userId, () => plApi.removeChannelMember(header.id, p.userId), `${nameOf(p.userId)} was removed`)}
                  className="h-8 px-2 text-[12.5px] font-semibold text-danger hover:bg-danger-bg"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>

        {isChannel && isMember && (
          <div className="mt-4 space-y-2">
            <PeoplePicker value={adding} onChange={setAdding} exclude={participants.map((p) => p.userId)} label="Add people" max={50} />
            {adding.length > 0 && (
              <button
                type="button"
                disabled={busy === "add"}
                onClick={() => void run("add", () => plApi.addChannelMembers(header.id, adding), "Added").then(() => setAdding([]))}
                className="h-10 px-4 bg-indigo text-white text-[13px] font-semibold disabled:opacity-50"
              >
                Add {adding.length} {adding.length === 1 ? "person" : "people"}
              </button>
            )}
          </div>
        )}
      </section>

      {isChannel && isMember && !isOwner && (
        <button
          type="button"
          disabled={busy === "leave"}
          onClick={async () => {
            setBusy("leave");
            try {
              await plApi.leaveChannel(header.id);
              await onChanged();
              toast.show({ text: `You left #${header.title}` });
              if (header.isPrivate) router.push("/pipeline/chat");
            } catch (e) {
              toast.show({ text: describeError(e) });
            } finally {
              setBusy(null);
            }
          }}
          className="w-full h-10 border border-border text-[13px] font-semibold text-danger"
        >
          Leave channel
        </button>
      )}

      {isChannel && manage && (
        <button
          type="button"
          onClick={() => setDeleting(true)}
          className="w-full h-10 inline-flex items-center justify-center gap-1.5 bg-danger-bg text-[13px] font-semibold text-danger"
        >
          <Trash2 size={15} aria-hidden /> Delete channel
        </button>
      )}

      {header.kind === "dm" && (
        <button
          type="button"
          onClick={() => setHiding(true)}
          className="w-full h-10 inline-flex items-center justify-center gap-1.5 bg-danger-bg text-[13px] font-semibold text-danger"
        >
          <Trash2 size={15} aria-hidden /> Delete conversation
        </button>
      )}
      <HideDmSheet
        dm={
          hiding
            ? {
                id: header.id,
                name: nameOf(participants.find((p) => p.userId !== meId)?.userId ?? meId),
                isSelf: participants.every((p) => p.userId === meId),
              }
            : null
        }
        onClose={() => setHiding(false)}
      />

      <DeleteChannelSheet
        channel={deleting ? { id: header.id, name: header.title, parentProjectId: header.parentProjectId } : null}
        onClose={() => setDeleting(false)}
      />

      <Sheet
        open={confirmPrivacy}
        onClose={() => setConfirmPrivacy(false)}
        title={header.isPrivate ? "Make this channel public?" : "Make this channel private?"}
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmPrivacy(false)} className="h-11 px-4 border border-border text-[14px] font-semibold">
              Cancel
            </button>
            <button
              type="button"
              disabled={busy === "privacy"}
              onClick={() =>
                void run("privacy", () => plApi.editChannel(header.id, { isPrivate: !header.isPrivate }), header.isPrivate ? "Channel is now public" : "Channel is now private").then(() =>
                  setConfirmPrivacy(false),
                )
              }
              className="h-11 px-4 bg-indigo text-white text-[14px] font-semibold disabled:opacity-50"
            >
              Make {header.isPrivate ? "public" : "private"}
            </button>
          </div>
        }
      >
        <p className="text-[14px] text-ink-2">
          {header.isPrivate
            ? "Anyone in the team will be able to find this channel, read its messages and join."
            : "Only current members will be able to see this channel and its messages. Others can't find or join it unless a member adds them."}
        </p>
      </Sheet>
    </div>
  );
}
