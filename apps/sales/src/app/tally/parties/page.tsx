"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { useTallyParties, useTallySettings } from "@/lib/hooks";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { refreshTally } from "@/lib/tally";
import { Confirm, Empty, LoadError, Loading, PageHead, Toast } from "@/components/sales-ui";
import type { TallyPartyRow } from "@/lib/sales-types";

// Client → Tally ledger names for the current company (spec-tally §5.5). A name used by a confirmed
// export is locked: only an admin changes it, after renaming the ledger in Tally.

const STATES = [["all", "All"], ["new", "New"], ["mapped", "Mapped"], ["locked", "Locked"]] as const;
type Suggestion = { clientId: string; client: string; gstin: string | null; tallyName: string; by: "gstin" | "name" };

export default function TallyPartiesPage() {
  const { company, info } = useCompany();
  const { user } = useAuth();
  const admin = isAdminUser(user);
  const [q, setQ] = useState("");
  const [state, setState] = useState("all");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const { data, error, isLoading, mutate } = useTallyParties(debounced, state);
  const { data: setup } = useTallySettings();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<TallyPartyRow | null>(null);
  const [matchOpen, setMatchOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);

  const save = async (row: TallyPartyRow, extra: Record<string, unknown> = {}) => {
    try {
      await apiFetch(`/sales/tally/parties/${row.clientId}?company=${company}`, { method: "PUT", body: JSON.stringify({ ledgerName: edits[row.clientId] ?? row.ledgerName, existsInTally: row.existsInTally, ...extra }) });
      // a tick of "Already in Tally" saves the stored name and keeps any unsaved edit in the row
      if (extra.ledgerName === undefined) setEdits((e) => { const n = { ...e }; delete n[row.clientId]; return n; });
      await Promise.all([mutate(), refreshTally()]);
      setToast({ message: "Saved.", tone: "ok" });
    } catch (err) { setToast({ message: errorSentence(err), tone: "err" }); }
  };

  return (
    <>
      <PageHead kicker={<><Link href="/tally" className="hover:text-white">Tally</Link> · {info.short}</> as unknown as string} title="Party ledgers">
        {admin && <button type="button" className="btn" onClick={() => setMatchOpen(true)}>Match from Tally</button>}
      </PageHead>
      <div className="card p-3 mb-4 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] gap-2 items-center">
        <input className="input w-full" placeholder="Search clients" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="flex flex-wrap gap-1">{STATES.map(([k, label]) => <button key={k} type="button" onClick={() => setState(k)} className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${state === k ? "bg-indigo border-indigo text-white font-bold" : "border-border text-ink-3"}`}>{label}</button>)}</div>
      </div>
      {error ? <LoadError error={error} retry={() => mutate()} /> : isLoading && !data ? <Loading /> : !data?.length ? <Empty title="No clients here." /> : (
        <div className="card p-3 overflow-x-auto"><table className="w-full min-w-[640px] text-sm [&_td]:px-2 [&_th]:px-2"><thead><tr className="text-left text-ink-3 text-xs"><th className="py-1">Client</th><th>GSTIN</th><th>Tally ledger name</th><th>Already in Tally</th><th>Last used</th><th /></tr></thead>
          <tbody>{data.map((r) => { const dirty = edits[r.clientId] !== undefined && edits[r.clientId] !== r.ledgerName; return (
            <tr key={r.clientId} className="border-t border-border align-middle">
              <td className="py-1 break-words"><Link className="underline hover:text-white" href={`/clients/view?id=${r.clientId}`}>{r.client}</Link></td>
              <td className="font-mono text-xs break-all">{r.gstin ?? "—"}</td>
              <td className="min-w-[220px]">{r.lockedAt && !admin
                ? <span className="inline-flex items-center gap-1 break-words"><Lock size={12} aria-label="Locked" /> {r.ledgerName}</span>
                : <span className="flex items-center gap-1">{r.lockedAt && <Lock size={12} aria-label="Locked" />}<input className="input w-full" value={edits[r.clientId] ?? r.ledgerName} onChange={(e) => setEdits({ ...edits, [r.clientId]: e.target.value })} />{r.proposed && <span className="text-[10px] text-ink-4 uppercase">proposed</span>}</span>}</td>
              <td><input type="checkbox" checked={r.existsInTally} disabled={!!r.lockedAt && !admin} onChange={(e) => save({ ...r, existsInTally: e.target.checked }, { ledgerName: r.ledgerName })} aria-label="Already in Tally" /></td>
              <td>{r.lastRunNo ? `#${r.lastRunNo}` : "—"}</td>
              <td>{(dirty || (r.proposed && !r.lockedAt)) && <button type="button" className="btn btn-sm" onClick={() => (r.lockedAt ? setRenaming(r) : save(r))}>Save</button>}</td>
            </tr>); })}</tbody></table></div>
      )}
      {renaming && (
        <Confirm title="Renamed in Tally?" confirmLabel="Renamed in Tally — save" onClose={() => setRenaming(null)}
          onConfirm={async () => { await save(renaming, { confirmRenamedInTally: true }); setRenaming(null); }}
          body="Change it here only after renaming the ledger in Tally to exactly this name." />
      )}
      {matchOpen && <MatchDialog company={company} pushReady={!!setup?.pushEnabled && !!setup.settings.pushUrl} onClose={() => setMatchOpen(false)} onApplied={async (n, close = true) => { if (close) setMatchOpen(false); await Promise.all([mutate(), refreshTally()]); setToast({ message: `${n} ledger${n === 1 ? "" : "s"} matched.`, tone: "ok" }); }} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

function MatchDialog({ company, pushReady, onClose, onApplied }: { company: string; pushReady: boolean; onClose: () => void; onApplied: (n: number, close?: boolean) => void }) {
  const [result, setResult] = useState<{ suggestions: Suggestion[]; unmatched: number; conflicts: Array<{ tallyName: string; gstins: string[] }> } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (body: Record<string, unknown>) => {
    setBusy(true); setErr(null);
    try {
      const r = (await apiFetch<NonNullable<typeof result>>("/sales/tally/parties/match", { method: "POST", body: JSON.stringify({ companyKey: company, ...body }) })).data;
      setResult(r); setChosen(new Set(r.suggestions.map((s) => s.clientId)));
    } catch (e) { setErr(errorSentence(e)); } finally { setBusy(false); }
  };
  const readFile = (f: File) => {
    if (!/\.xml$/i.test(f.name) && !/xml/.test(f.type)) { setErr("Choose Tally's XML ledger export (a .xml file)."); return; }
    if (f.size > 5_000_000) { setErr("That file is over 5 MB — export only the ledgers (Export → Masters → Ledgers)."); return; }
    const reader = new FileReader();
    reader.onload = () => run({ source: "xml", xml: String(reader.result ?? "") });
    reader.onerror = () => setErr("Couldn't read that file.");
    reader.readAsText(f); // BOM-aware: UTF-16 exports decode too
  };
  const apply = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const mappings = result.suggestions.filter((s) => chosen.has(s.clientId)).map((s) => ({ clientId: s.clientId, ledgerName: s.tallyName, existsInTally: true }));
      const r = (await apiFetch<{ saved: number; skipped: Array<{ clientId: string; ledgerName: string; reason: string }> }>("/sales/tally/parties/apply", { method: "POST", body: JSON.stringify({ companyKey: company, mappings }) })).data;
      if (r.skipped.length) {
        const name = (id: string) => result.suggestions.find((s) => s.clientId === id)?.client ?? "A client";
        setErr(`${r.saved} saved. Not applied: ${r.skipped.map((x) => `${name(x.clientId)} → ${x.ledgerName} (${x.reason})`).join("; ")}.`);
        if (r.saved) onApplied(r.saved, false);
        return;
      }
      onApplied(r.saved);
    } catch (e) { setErr(errorSentence(e)); } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" onClick={onClose}>
      <div className="card p-5 max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 className="font-extrabold text-lg mb-3">Match from Tally</h3>
        {!result && (
          <div className="grid gap-3 text-sm">
            {pushReady && <button type="button" className="btn" disabled={busy} onClick={() => run({ source: "push" })}>Read from Tally now</button>}
            <label className="block"><span className="block text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-1">Use Tally&apos;s ledger export</span>
              <input type="file" accept=".xml,text/xml" className="input w-full" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
              <span className="block text-xs text-ink-4 mt-1">TallyPrime: Export → Masters → Ledgers → XML</span></label>
          </div>
        )}
        {busy && <Loading label="Matching…" />}
        {err && <p className="text-sm text-danger mt-2">{err}</p>}
        {result && (
          <div className="grid gap-2 text-sm">
            <p className="text-ink-3">{result.suggestions.length} matches · {result.unmatched} clients not found in Tally{result.conflicts.length ? ` · ${result.conflicts.length} conflicts` : ""}</p>
            <ul className="grid gap-1">{result.suggestions.map((s) => (
              <li key={s.clientId}><label className="flex items-start gap-2 break-words"><input type="checkbox" className="mt-1" checked={chosen.has(s.clientId)} onChange={(e) => setChosen((c) => { const n = new Set(c); if (e.target.checked) n.add(s.clientId); else n.delete(s.clientId); return n; })} />
                <span>{s.client} → <b>{s.tallyName}</b> <span className="text-xs text-ink-4">by {s.by === "gstin" ? "GSTIN" : "name"}</span></span></label></li>))}</ul>
            {result.conflicts.map((c) => <p key={c.tallyName} className="text-xs text-attention break-words">Conflict: {c.tallyName} ({c.gstins.join(" vs ")}) — check with your accountant.</p>)}
          </div>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          {result && <button type="button" className="btn" disabled={busy || chosen.size === 0} onClick={apply}>Apply {chosen.size} matches</button>}
        </div>
      </div>
    </div>
  );
}
