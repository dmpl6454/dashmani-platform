"use client";
/**
 * Renders a message body as React nodes (spec §9.6) — never HTML. Mentions the server
 * delivered render as chips with the server-provided name; any other `@{id}` is grey
 * plain text ("@Name" if the directory knows the id, "@former member" only once the
 * directory has LOADED and lacks it, otherwise "@…").
 */
import { memo, useEffect, useMemo } from "react";
import { tokenizeBody, type PipelineMention } from "@dashmani/shared";
import { usePipeline } from "../provider";

function MessageBodyImpl({ body, mentions, meId }: { body: string; mentions: PipelineMention[]; meId: string }) {
  const { directory, dirById, noteUnknownId } = usePipeline();
  const tokens = useMemo(() => tokenizeBody(body), [body]);
  const delivered = useMemo(() => new Map(mentions.map((m) => [m.id, m.name])), [mentions]);
  // An id the loaded directory doesn't know triggers one throttled revalidate.
  useEffect(() => {
    if (!directory) return;
    for (const t of tokens) if (t.kind === "mention" && !delivered.has(t.id) && !dirById.has(t.id)) noteUnknownId(t.id);
  }, [tokens, delivered, directory, dirById, noteUnknownId]);
  return (
    <div className="whitespace-pre-wrap [overflow-wrap:anywhere] text-[14.5px] leading-relaxed text-ink">
      {tokens.map((t, i) => {
        if (t.kind === "text") return <span key={i}>{t.text}</span>;
        if (t.kind === "url") {
          return (
            <a key={i} href={t.href} target="_blank" rel="noopener noreferrer nofollow" className="text-indigo underline [overflow-wrap:anywhere]">
              {t.text}
            </a>
          );
        }
        const name = delivered.get(t.id);
        if (name !== undefined) {
          const hint = dirById.get(t.id)?.hint;
          return (
            <span key={i} title={hint ? `${name} (${hint})` : undefined} className={`pl-name inline rounded-md px-1 font-semibold ${t.id === meId ? "bg-action-soft text-ink" : "bg-indigo-soft text-indigo-deep"}`}>
              @{name}
            </span>
          );
        }
        const d = dirById.get(t.id);
        return (
          <span key={i} className="pl-name text-ink-4">
            {d ? `@${d.name}` : directory ? "@former member" : "@…"}
          </span>
        );
      })}
    </div>
  );
}

export const MessageBody = memo(MessageBodyImpl);
