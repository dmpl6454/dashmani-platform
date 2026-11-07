"use client";
// Mark a month reconciled (spec-reconcile §7.6 item 7): the frozen figures, one tick per needed
// acknowledgement, the closing balance typed from the statement when it has no balances, a note.
import { useState } from "react";
import { bankBalanceFromSide } from "@dashmani/shared/src/sales/recon";
import { fmtDate, fmtInr } from "@/lib/format";
import type { BrsView } from "@/lib/sales-types";
import { Field, MoneyInput } from "@/components/sales-ui";

export interface BrsReconcileBody { acceptOpenItems: boolean; acceptCoverageGaps: boolean; acceptBreaks: boolean; typedClosingPaise: number | null; note: string | null }

/** A bank statement's side, not a client ledger's: "Cr" = money in the account (default), "Dr" = overdrawn. */
function BankSideToggle({ value, onChange }: { value: "Cr" | "Dr"; onChange: (v: "Cr" | "Dr") => void }) {
  return (
    <div className="inline-flex border-2 border-border" role="radiogroup" aria-label="Cr or Dr as printed on the statement">
      {(["Cr", "Dr"] as const).map((s) => (
        <button key={s} type="button" role="radio" aria-checked={value === s} onClick={() => onChange(s)}
          className={`px-3 py-1.5 text-sm ${value === s ? "bg-indigo text-white" : "text-ink-3 hover:text-white"}`}>
          {s === "Cr" ? "Cr (in funds)" : "Dr (overdrawn)"}
        </button>
      ))}
    </div>
  );
}

export function BrsReconcileDialog({ v, onSubmit, onClose }: { v: BrsView; onSubmit: (b: BrsReconcileBody) => Promise<void>; onClose: () => void }) {
  const need = new Set(v.needsAck);
  // The field shows when the statement has no balances, and on a month already closed from a typed figure (to correct it).
  const askClosing = need.has("typed_closing") || v.balances.source === "typed";
  const start = v.balances.source === "typed" ? v.balances.closingPaise : null;
  const [open, setOpen] = useState(false);
  const [gap, setGap] = useState(false);
  const [brk, setBrk] = useState(false);
  const [typed, setTyped] = useState<number | null>(start === null ? null : Math.abs(start));
  const [side, setSide] = useState<"Cr" | "Dr">(start !== null && start < 0 ? "Dr" : "Cr");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const noteNeeded = (gap || brk) && note.trim().length < 10;
  // ₹0.00 is a real closing balance: "entered" is typed !== null, not typed > 0.
  const ready = (!need.has("open_items") || open) && (!need.has("coverage_gap") || gap) && (!need.has("statement_break") || brk) && (!askClosing || typed !== null) && !noteNeeded;
  const gapText = v.coverage.gaps.map((g) => (g.from === g.to ? fmtDate(g.from) : `${fmtDate(g.from)} – ${fmtDate(g.to)}`)).join(", ");
  const typedSigned = typed === null ? null : bankBalanceFromSide(typed, side);
  const closing = askClosing ? typedSigned : v.balances.closingPaise;
  const workedOpening = askClosing && typedSigned !== null ? typedSigned - v.balances.creditsPaise + v.balances.debitsPaise : null;
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
        {askClosing && (
          <Field label="Closing balance printed on the statement" hint="Copy it with its side: banks print money in the account as Cr. The opening is worked back from it.">
            <div className="flex flex-wrap gap-2 items-center">
              <MoneyInput paise={typed ?? 0} onChange={(p) => setTyped(p)} className="max-w-[12rem]" />
              <BankSideToggle value={side} onChange={setSide} />
            </div>
            {workedOpening !== null && <p className="text-xs text-ink-3 mt-1">Opening worked back: {fmtInr(workedOpening)} (closing − credits {fmtInr(v.balances.creditsPaise)} + withdrawals {fmtInr(v.balances.debitsPaise)})</p>}
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
              await onSubmit({ acceptOpenItems: open, acceptCoverageGaps: gap, acceptBreaks: brk, typedClosingPaise: askClosing ? typedSigned : null, note: note.trim() || null });
            } finally { setBusy(false); }
          }}>{busy ? "Working…" : "Mark reconciled"}</button>
        </div>
      </div>
    </div>
  );
}
