"use client";
// Send the statement to several clients (≤ 25 per click): lists who gets what, then queues them;
// the server sends one after another in the background.
import { useState } from "react";
import { ModalPortal } from "@/components/modal-portal";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { drCrText } from "@/lib/reconcile";
import type { ConfirmationsView } from "@/lib/sales-types";

export function SendDialog({ rows, company, asOf, from, onClose, onSent, initialResend = false }: { rows: ConfirmationsView["rows"]; initialResend?: boolean; company: string; asOf: string; from: string; onClose: () => void; onSent: (msg: string) => void }) {
  const list = rows.slice(0, 25);
  const [resend, setResend] = useState(initialResend);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await apiFetch<{ queued: Array<{ name: string }>; skipped: Array<{ name: string; reason: string }> }>("/sales/reconcile/confirmations/send-batch", { method: "POST", body: JSON.stringify({ companyKey: company, asOf, from, clientIds: list.map((x) => x.clientId), resend }) });
      onSent(`Sending ${r.data.queued.length} — this list updates as they go.${r.data.skipped.length ? ` Skipped ${r.data.skipped.length}: ${r.data.skipped.map((s) => s.reason).join(" ")}` : ""}`);
    } catch (e) { setErr(errorSentence(e)); } finally { setBusy(false); }
  };
  return (
    <ModalPortal>
      <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" onClick={onClose}>
        <div className="card p-5 w-full max-w-lg grid grid-cols-[minmax(0,1fr)] gap-3" role="dialog" aria-modal="true" aria-label="Send statements" onClick={(e) => e.stopPropagation()}>
          <h3 className="font-extrabold text-lg">Send to {list.length}</h3>
          <ul className="text-sm max-h-64 overflow-y-auto divide-y divide-rule">
            {list.map((r) => <li key={r.clientId} className="py-1.5 min-w-0"><span className="font-bold">{r.name}</span> — {drCrText(r.balancePaise, false)} → <span className="font-mono text-xs break-all">{r.email ?? "no email (skipped)"}</span></li>)}
          </ul>
          {rows.length > 25 && <p className="text-xs text-attention">Only the first 25 are sent per click.</p>}
          <p className="text-sm text-ink-3">Each client gets the statement PDF and is asked to reply with a confirmation or their figure. Clients without an email are skipped.</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={resend} onChange={(e) => setResend(e.target.checked)} /> Resend to those already sent</label>
          {err && <p className="text-sm text-danger" role="alert">{err}</p>}
          <div className="flex justify-end gap-2"><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="button" className="btn" disabled={busy || !list.length} onClick={send}>{busy ? "Queuing…" : `Send to ${list.length}`}</button></div>
        </div>
      </div>
    </ModalPortal>
  );
}
