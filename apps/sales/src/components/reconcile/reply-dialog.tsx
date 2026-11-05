"use client";
// Record the client's reply: confirmed / disputed (their figure with Dr/Cr, a note) / no reply
// yet, the reply date, and an optional file uploaded right after the save.
import { useState } from "react";
import { ModalPortal } from "@/components/modal-portal";
import { Field, MoneyInput } from "@/components/sales-ui";
import { apiFetch, apiUpload } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { todayIST } from "@/lib/format";
import { drCrText } from "@/lib/reconcile";
import type { ConfirmationState } from "@/lib/sales-types";
import { DrCrToggle } from "./dr-cr";

export function ReplyDialog({ c, name, company, onClose, onSaved }: { c: ConfirmationState; name: string; company: string; onClose: () => void; onSaved: (msg: string) => void }) {
  const [status, setStatus] = useState<"confirmed" | "disputed" | "pending">(c.status === "pending" ? "confirmed" : c.status);
  const [amount, setAmount] = useState(Math.abs(c.theirBalancePaise ?? c.ourBalancePaise));
  const [side, setSide] = useState<"Dr" | "Cr">((c.theirBalancePaise ?? c.ourBalancePaise) >= 0 ? "Dr" : "Cr");
  const [day, setDay] = useState(c.respondedOn ?? todayIST());
  const [note, setNote] = useState(c.responseNote ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const theirs = side === "Dr" ? amount : -amount;
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { status, theirBalancePaise: status === "disputed" ? theirs : null, respondedOn: status === "pending" ? null : day, note: note.trim() || null };
      await apiFetch(`/sales/reconcile/confirmations/${c.id}/response?company=${company}`, { method: "PUT", body: JSON.stringify(body) });
      if (file) {
        const form = new FormData();
        form.append("file", file);
        await apiUpload(`/sales/reconcile/confirmations/${c.id}/file?company=${company}`, form);
      }
      onSaved(status === "disputed" ? `Recorded — ${name} disputed (${drCrText(c.ourBalancePaise - theirs, false)}).` : status === "confirmed" ? `Recorded — ${name} confirmed ${drCrText(c.ourBalancePaise, false)}.` : `Recorded — no reply yet from ${name}.`);
    } catch (e) { setErr(errorSentence(e)); } finally { setBusy(false); }
  };
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" onClick={onClose}>
        <div className="card p-5 w-full max-w-lg grid grid-cols-[minmax(0,1fr)] gap-3" role="dialog" aria-modal="true" aria-label={`Record ${name}'s reply`} onClick={(e) => e.stopPropagation()}>
          <h3 className="font-extrabold text-lg">Record reply · {name}</h3>
          <p className="text-sm text-ink-3">Our figure: {drCrText(c.ourBalancePaise)}</p>
          <div className="grid gap-2 text-sm" role="radiogroup" aria-label="Reply">
            {([["confirmed", "Confirmed — matches our figure"], ["disputed", "Disputed — their books differ"], ["pending", "No reply yet"]] as const).map(([v, l]) => (
              <label key={v} className="flex items-center gap-2"><input type="radio" name="reply" checked={status === v} onChange={() => setStatus(v)} /> {l}</label>
            ))}
          </div>
          {status === "disputed" && (
            <Field label="Their balance" hint={`Difference ${drCrText(c.ourBalancePaise - theirs, false)}`}>
              <div className="flex flex-wrap gap-2 items-center"><MoneyInput paise={amount} onChange={setAmount} className="flex-1 min-w-0" /><DrCrToggle value={side} onChange={setSide} /></div>
            </Field>
          )}
          {status !== "pending" && <Field label="Reply date"><input type="date" className="input" value={day} max={todayIST()} onChange={(e) => setDay(e.target.value)} /></Field>}
          <Field label="Note"><textarea className="input min-h-[72px]" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={status === "disputed" ? "What the client disputes" : ""} /></Field>
          <Field label="Attach their reply (PDF/PNG/JPG, optional)"><input type="file" accept=".pdf,.png,.jpg,.jpeg" className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          {err && <p className="text-sm text-danger" role="alert">{err}</p>}
          <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button></div>
        </div>
      </div>
    </ModalPortal>
  );
}
