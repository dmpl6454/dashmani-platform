"use client";
/**
 * Reaction chips (44 px, aria-pressed): emoji + count, highlighted when mine; the title
 * lists who reacted from directory names. Optimistic: the chip toggles immediately and is
 * reconciled with the server's `reactions`; any failure reverts it (spec §9.4).
 */
import { useCallback, useMemo, useState } from "react";
import { SmilePlus } from "lucide-react";
import { selectReactions, type PipelineMessage, type PipelineReactionKey } from "@dashmani/shared";
import { usePipeline } from "../provider";
import { useStoreSelector } from "../store";
import { useToast } from "../ui/Toast";
import { describeError, isRateLimited, plApi, retryAfterMs } from "../api";
import { ReactionPicker } from "./ReactionPicker";

export function useToggleReaction() {
  const { store, engine } = usePipeline();
  const toast = useToast();
  return useCallback(
    async (m: PipelineMessage, key: PipelineReactionKey, on: boolean): Promise<void> => {
      store.dispatch({ type: "reactionPending", messageId: m.id, emoji: key, on });
      try {
        for (let tries = 0; ; tries++) {
          try {
            const r = await plApi.react(m.id, key, on);
            store.dispatch({ type: "reactionResult", projectId: m.projectId, messageId: r.messageId, reactions: r.reactions, rev: r.rev });
            engine.afterWrite();
            return;
          } catch (e) {
            if (isRateLimited(e) && tries < 2) {
              await new Promise((res) => setTimeout(res, retryAfterMs(e)));
              continue;
            }
            toast.show({ text: describeError(e), tone: "error" }); // the chip reverts below
            return;
          }
        }
      } finally {
        store.dispatch({ type: "reactionPending", messageId: m.id, emoji: key, on: null });
      }
    },
    [store, engine, toast],
  );
}

export function ReactionBar({ message, readOnly }: { message: PipelineMessage; readOnly: boolean }) {
  const { store, boot, meId, dirById } = usePipeline();
  const t = useToggleReaction();
  const reactions = useStoreSelector(store, (s) => selectReactions(s, message));
  const [picker, setPicker] = useState(false);
  const mine = useMemo(() => new Set(Object.entries(reactions).filter(([, ids]) => ids?.includes(meId)).map(([k]) => k)), [reactions, meId]);
  const entries = boot.reactions.filter((o) => (reactions[o.key]?.length ?? 0) > 0);
  if (message.deletedAt) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {entries.map((o) => {
        const ids = reactions[o.key] ?? [];
        const on = ids.includes(meId);
        const who = ids.map((id) => (id === meId ? "You" : dirById.get(id)?.name ?? "Someone")).join(", ");
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            disabled={readOnly}
            title={who}
            aria-label={`${o.emoji} ${ids.length}: ${who}`}
            onClick={() => void t(message, o.key, !on)}
            className={`h-11 min-w-11 px-2.5 inline-flex items-center gap-1 rounded-full border text-[13px] font-semibold ${
              on ? "border-indigo bg-indigo-soft text-indigo-deep" : "border-rule bg-surface text-ink-2"
            } disabled:opacity-70`}
          >
            <span aria-hidden>{o.emoji}</span>
            <span className="tabular-nums">{ids.length}</span>
          </button>
        );
      })}
      {!readOnly && entries.length > 0 && (
        <button type="button" onClick={() => setPicker(true)} aria-label="Add a reaction" className="h-11 w-11 grid place-items-center rounded-full border border-rule text-ink-3 hover:bg-muted">
          <SmilePlus size={16} />
        </button>
      )}
      <ReactionPicker
        open={picker}
        options={boot.reactions}
        mine={mine}
        onClose={() => setPicker(false)}
        onPick={(k) => void t(message, k, !mine.has(k))}
      />
    </div>
  );
}
