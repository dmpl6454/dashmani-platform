"use client";
import { useState } from "react";
import { BANK_IGNORE_LABELS } from "@dashmani/shared/src/sales/bank";
import { useLineReceipts } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr } from "@/lib/format";
import { Field, LoadError, Money } from "@/components/sales-ui";
import { ModalPortal } from "@/components/modal-portal";
import type { BankLineView } from "@/lib/sales-types";

// The line page's dialogs: link an existing receipt, ignore with a reason, unlink (detach or void).

const STAFF_REASONS = ["own_transfer", "gst_refund", "tax_refund", "interest", "loan_capital", "gateway", "salary", "vendor_refund", "reversal", "duplicate", "other"];

function Shell({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" onClick={onClose}>
        <div className={`card p-6 w-full ${wide ? "max-w-2xl max-h-[90vh] overflow-y-auto" : "max-w-md"}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
          <h3 className="font-extrabold text-lg mb-3">{title}</h3>
          {children}
        </div>
      </div>
    </ModalPortal>
  );
}

export function LinkDialog({ line, onClose, onDone }: { line: BankLineView; onClose: () => void; onDone: (msg: string, tone?: "ok" | "err") => void }) {
  const { data, error, isLoading, mutate } = useLineReceipts(line.id);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { await apiFetch(`/sales/bank/lines/${line.id}/link`, { method: "POST", body: JSON.stringify({ paymentId: pick }) }); onDone("Receipt linked to this credit."); }
    catch (err) { onDone(errorSentence(err), "err"); } finally { setBusy(false); }
  }
  return (
    <Shell title="Link an existing receipt" onClose={onClose} wide>
      <p className="text-sm text-ink-3 mb-3">Receipts that could be this money:</p>
      {error ? <LoadError error={error} retry={() => mutate()} /> : isLoading ? <p className="text-sm">Loading…</p> : !data?.length ? (
        <p className="text-sm">No unlinked receipt of {fmtInr(line.remainingPaise)} or less near {fmtDate(line.txnDate)} — record a new one instead.</p>
      ) : (
        <ul className="grid gap-2 mb-4">
          {data.map((r) => (
            <li key={r.paymentId}>
              <label className="flex items-start gap-2 text-sm border border-rule p-2">
                <input type="radio" name="rc" checked={pick === r.paymentId} onChange={() => setPick(r.paymentId)} />
                <span className="min-w-0"><span className="font-mono">{r.number}</span> · {fmtDate(r.paidOn)} · {r.clientName} · <Money paise={r.amountPaise} />{r.reference ? <span className="font-mono text-xs text-ink-3 break-all"> · {r.reference}</span> : null}{r.why ? <span className="text-xs text-attention"> · {r.why}</span> : null}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn" disabled={!pick || busy} onClick={go}>{busy ? "Linking…" : "Link receipt"}</button></div>
    </Shell>
  );
}

export function IgnoreDialog({ line, onClose, onDone, initialReason }: { line: BankLineView; onClose: () => void; onDone: (msg: string, tone?: "ok" | "err") => void; initialReason?: string }) {
  const [reason, setReason] = useState(initialReason ?? line.suggestion?.ignoreHint?.reason ?? "other");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { await apiFetch(`/sales/bank/lines/${line.id}/ignore`, { method: "POST", body: JSON.stringify({ reason, note: note || null }) }); onDone(`Ignored — ${BANK_IGNORE_LABELS[reason]}.`); }
    catch (err) { onDone(errorSentence(err), "err"); } finally { setBusy(false); }
  }
  return (
    <Shell title="Ignore this credit" onClose={onClose}>
      <div className="grid gap-3 mb-4">
        <Field label="What is it?"><select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>{STAFF_REASONS.map((r) => <option key={r} value={r}>{BANK_IGNORE_LABELS[r]}</option>)}</select></Field>
        <Field label="Note" hint={reason === "other" ? "Required for “Something else”" : undefined}><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn" disabled={busy || (reason === "other" && note.trim().length < 3)} onClick={go}>{busy ? "Working…" : "Ignore credit"}</button></div>
    </Shell>
  );
}

export function UnlinkDialog({ line, receipt, onClose, onDone }: { line: BankLineView; receipt: { id: string; number: string }; onClose: () => void; onDone: (msg: string, tone?: "ok" | "err") => void }) {
  const [action, setAction] = useState<"" | "detach" | "void">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { await apiFetch(`/sales/bank/lines/${line.id}/unlink`, { method: "POST", body: JSON.stringify({ paymentId: receipt.id, action, reason }) }); onDone("Unlinked — the credit is open again."); }
    catch (err) { onDone(errorSentence(err), "err"); } finally { setBusy(false); }
  }
  return (
    <Shell title={`Unlink ${receipt.number}`} onClose={onClose}>
      <div className="grid gap-2 text-sm mb-3">
        <label className="flex items-start gap-2"><input type="radio" checked={action === "detach"} onChange={() => setAction("detach")} /><span><b>Detach — keep the receipt.</b> It is a real receipt; this was the wrong bank line.</span></label>
        <label className="flex items-start gap-2"><input type="radio" checked={action === "void"} onChange={() => setAction("void")} /><span><b>Void the receipt.</b> It was recorded from this line by mistake. Its invoices reopen.</span></label>
      </div>
      <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="flex justify-end gap-2 mt-4"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className={`btn ${action === "void" ? "btn-danger" : ""}`} disabled={busy || !action || reason.trim().length < 3} onClick={go}>{busy ? "Working…" : "Unlink"}</button></div>
    </Shell>
  );
}
