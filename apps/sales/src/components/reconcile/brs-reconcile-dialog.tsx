"use client";
// Mark a month reconciled (spec-reconcile §7.6 item 7): the frozen figures, one tick per needed
// acknowledgement, the closing balance typed from the statement when it has no balances, a note.
import { useState } from "react";
import { fmtDate, fmtInr } from "@/lib/format";
import type { BrsView } from "@/lib/sales-types";
import { Field, MoneyInput } from "@/components/sales-ui";
import { DrCrToggle } from "./dr-cr";

export interface BrsReconcileBody { acceptOpenItems: boolean; acceptCoverageGaps: boolean; acceptBreaks: boolean; typedClosingPaise: number | null; note: string | null }

export function BrsReconcileDialog({ v, onSubmit, onClose }: { v: BrsView; onSubmit: (b: BrsReconcileBody) => Promise<void>; onClose: () => void }) {
  const need = new Set(v.needsAck);
  const [open, setOpen] = useState(false);
  const [gap, setGap] = useState(false);
  const [brk, setBrk] = useState(false);
  const [typed, setTyped] = useState(0);
  const [side, setSide] = useState<"Dr" | "Cr">("Dr");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const noteNeeded = (gap || brk) && note.trim().length < 10;
  const ready = (!need.has("open_items") || open) && (!need.has("coverage_gap") || gap) && (!need.has("statement_break") || brk) && (!need.has("typed_closing") || typed > 0) && !noteNeeded;
  const gapText = v.coverage.gaps.map((g) => (g.from === g.to ? fmtDate(g.from) : `${fmtDate(g.from)} – ${fmtDate(g.to)}`)).join(", ");
  const closing = need.has("typed_closing") ? (side === "Cr" ? -typed : typed) : v.balances.closingPaise;
  return (
    <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" onClick={onClose}>
      <div className="card p-6 max-w-lg w-full grid grid-cols-[minmax(0,1fr)] gap-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Mark ${v.month.label} reconciled`}>
        <h3 className="font-extrabold text-lg">Mark {v.month.label} reconciled</h3>
        <p className="text-sm text-ink-3">
          Closing {closing === null ? "—" : fmtInr(closing)} · books {fmtInr(v.books.receiptsPaise)} · {v.openItems.count} open item{v.openItems.count === 1 ? "" : "s"} {fmtInr(v.openItems.paise)} — these figures will be frozen with your name.
        </p>
        {need.has("open_items") && (
          <label className="flex gap-2 text-sm items-start"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />
            <span>Carry the {v.openItems.count} open item{v.openItems.count === 1 ? "" : "s"} ({fmtInr(v.openItems.paise)}) as reconciling items</span></label>
        )}
        {need.has("coverage_gap") && (
          <label className="flex gap-2 text-sm items-start"><input type="checkbox" checked={gap} onChange={(e) => setGap(e.target.checked)} />
            <span>No statement covers {gapText} — there were no transactions</span></label>
        )}
        {need.has("statement_break") && (
          <label className="flex gap-2 text-sm items-start"><input type="checkbox" checked={brk} onChange={(e) => setBrk(e.target.checked)} />
            <span>Accept the balance break{v.balances.breaks.length === 1 ? "" : "s"}: {v.balances.breaks[0]?.text}</span></label>
        )}
        {need.has("typed_closing") && (
          <Field label="Closing balance printed on the statement" hint="This statement has no balances — the opening is worked back from it.">
            <div className="flex flex-wrap gap-2 items-center">
              <MoneyInput paise={typed} onChange={setTyped} className="max-w-[12rem]" />
              <DrCrToggle value={side} onChange={setSide} />
            </div>
          </Field>
        )}
        <Field label={gap || brk ? "Note (required, at least 10 characters)" : "Note (optional)"}>
          <textarea className="input min-h-[4.5rem]" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Statement downloaded for 1–31 Oct; no transactions on 1 Oct" />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={!ready || busy} onClick={async () => {
            setBusy(true);
            try {
              await onSubmit({ acceptOpenItems: open, acceptCoverageGaps: gap, acceptBreaks: brk, typedClosingPaise: need.has("typed_closing") ? (side === "Cr" ? -typed : typed) : null, note: note.trim() || null });
            } finally { setBusy(false); }
          }}>{busy ? "Working…" : "Mark reconciled"}</button>
        </div>
      </div>
    </div>
  );
}
