"use client";
import { useEffect, useState } from "react";
import { Modal, Button } from "./portal-shared";
import { Icon } from "./portal-icons";
import type { Post } from "@/lib/portal-store";

const REVISE_REASONS = ["Wrong tone / voice", "Off-brand colours or composition", "Caption needs work", "Wrong asset / crop", "Other…"];
const REJECT_REASONS = ["Off-brief", "Wrong account", "Sensitive / unsafe", "Asset quality", "Other…"];

export function ReasonModal({
  open,
  kind,
  post,
  onClose,
  onConfirm,
}: {
  open: boolean;
  kind: "revise" | "reject";
  post: Post | null;
  onClose: () => void;
  onConfirm: (note: string) => void;
}) {
  const reasons = kind === "revise" ? REVISE_REASONS : REJECT_REASONS;
  const [reason, setReason] = useState(reasons[0]);
  const [note, setNote] = useState("");
  const canSubmit = note.trim().length >= 6;
  const isRevise = kind === "revise";

  useEffect(() => {
    if (open) { setReason(reasons[0]); setNote(""); }
  }, [open, kind]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isRevise ? "Request a revision" : "Reject this post"}
      size="lg"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant={isRevise ? "primary" : "danger"}
          onClick={() => onConfirm(`${reason} — ${note.trim()}`)}
          disabled={!canSubmit}
          icon={isRevise ? <Icon.Edit size={15}/> : <Icon.X size={15}/>}
        >
          {isRevise ? "Send revision request" : "Reject and notify"}
        </Button>
      </>}
    >
      <p className="text-[13px] text-ink-2 mb-3 text-rowtight">
        {isRevise
          ? <>The team will get your reason + note and resubmit a new draft for &ldquo;<span className="font-medium text-ink">{post?.title}</span>&rdquo;.</>
          : <>This rejects the post entirely. The team will need to start over. For small fixes, request a revision instead.</>}
      </p>
      <div className="space-y-3">
        <div>
          <label className="text-[11px] uppercase tracking-wider text-ink-3 font-medium block mb-1.5">Reason</label>
          <div className="flex flex-wrap gap-1.5">
            {reasons.map((r) => (
              <button
                key={r}
                onClick={() => setReason(r)}
                className={`h-8 px-3 inline-flex items-center rounded-md text-[12.5px] font-medium border transition-colors ${reason === r ? "bg-ink text-bg border-ink" : "bg-surface text-ink-2 border-border hover:bg-muted/60"}`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wider text-ink-3 font-medium block mb-1.5">
            Note <span className="text-attention normal-case tracking-normal font-normal">— required</span>
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
            placeholder={isRevise ? "What needs to change? Be specific so the team can act on it." : "Why are we rejecting this? Saved to the thread."}
            rows={4}
            className="w-full text-[13px] bg-bg/40 border border-border rounded-md px-3 py-2 outline-none focus:bg-surface focus:border-ink resize-none"
          />
          <div className="text-[11px] text-ink-3 mt-1 flex items-center justify-between">
            <span>{note.length < 6 ? `Add at least ${6 - note.length} more character${6 - note.length === 1 ? "" : "s"}.` : "Looks good."}</span>
            <span className="tabular-nums">{note.length} chars</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
