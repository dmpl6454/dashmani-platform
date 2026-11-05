"use client";
// "Whose TAN is this?" — one card per unknown TAN: take the proposal, pick a client, or mark it
// as not a sales client. Saves through PUT /sales/reconcile/tds/deductors/:tan.
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtInr } from "@/lib/format";
import type { ClientRow, TdsDeductor } from "@/lib/sales-types";

export function DeductorCard({ d, clients, onSaved, onError }: { d: TdsDeductor; clients: ClientRow[]; onSaved: (msg: string) => void; onError: (msg: string) => void }) {
  const [clientId, setClientId] = useState("");
  const [nonSales, setNonSales] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    try {
      const r = await apiFetch<{ changed: boolean; where: "profile" | "deductors" }>(`/sales/reconcile/tds/deductors/${d.tan}`, { method: "PUT", body: JSON.stringify({ ...body, nameSeen: d.name }) });
      onSaved(r.data.where === "profile" ? `${d.tan} saved for ${done} — it is now on their billing profile.` : `${d.tan} saved for ${done}.`);
    } catch (err) { onError(errorSentence(err)); } finally { setBusy(false); }
  };
  return (
    <div className="card p-3 grid grid-cols-1 gap-2 min-w-0">
      <div className="flex flex-wrap justify-between gap-2 min-w-0">
        <p className="min-w-0"><span className="font-mono text-xs break-all">{d.tan}</span> · <span className="font-bold">{d.name}</span></p>
        <p className="text-sm text-ink-3">{d.entries} entr{d.entries === 1 ? "y" : "ies"} · <span className="font-mono">{fmtInr(d.tdsPaise)}</span></p>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        {d.proposal && (
          <button type="button" className="btn btn-sm max-w-full whitespace-normal text-left break-words" disabled={busy} title={d.proposal.why.join(" · ")} onClick={() => save({ kind: "client", clientId: d.proposal!.clientId }, d.proposal!.clientName)}>
            {d.proposal.clientName}? ({d.proposal.why[0] ?? "suggested"}) — Use
          </button>
        )}
        <select className="input w-auto max-w-full" aria-label={`Client for ${d.tan}`} value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">Pick a client…</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.companyName}</option>)}
        </select>
        <button type="button" className="btn btn-light btn-sm" disabled={busy || !clientId} onClick={() => save({ kind: "client", clientId }, clients.find((c) => c.id === clientId)?.companyName ?? "the client")}>Link</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNonSales((v) => !v)}>Not a sales client…</button>
      </div>
      {nonSales && (
        <div className="flex flex-wrap gap-2 items-center">
          <input className="input flex-1 min-w-0 basis-48" placeholder="Bank interest — HDFC FD" maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="What this deductor is" />
          <button type="button" className="btn btn-light btn-sm" disabled={busy || label.trim().length < 2} onClick={() => save({ kind: "non_sales", label: label.trim() }, label.trim())}>Save</button>
        </div>
      )}
    </div>
  );
}
