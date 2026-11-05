"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { useEvents, useTallyRun } from "@/lib/hooks";
import { apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import { refreshTally } from "@/lib/tally";
import { Confirm, Empty, Field, LoadError, Loading, Money, PageHead, StatusPill, Toast } from "@/components/sales-ui";
import { EventList } from "@/components/document-view";
import type { TallyRunView } from "@/lib/sales-types";

// One Tally export (spec-tally §5.3): its files and the import steps, "Mark as imported" with
// Tally's own counts (the counted confirm, I8), Discard, push progress with Retry / Close, the
// items and their outcomes, and the "Tally should show" checklist.

const DOC_LABEL: Record<string, string> = { invoice: "Sales", credit_note: "Credit note", receipt: "Receipt", refund: "Payment (refund)" };
const TABS = ["all", "problems", "changes"] as const;

function RunView() {
  const id = useSearchParams().get("id");
  const { user } = useAuth();
  const admin = isAdminUser(user);
  const { data: r, error, isLoading, mutate } = useTallyRun(id);
  const { data: events, mutate: mutateEvents } = useEvents("tally_run", id);
  const [counts, setCounts] = useState({ created: "", altered: "0", cancelled: "0", errors: "0" });
  const [note, setNote] = useState("");
  const [modal, setModal] = useState<null | "discard" | "close" | "resolve">(null);
  const [reason, setReason] = useState("");
  const [tab, setTab] = useState<(typeof TABS)[number]>("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  if (!id) return <Empty title="No export selected." action={<Link href="/tally" className="btn">Back to Tally</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !r) return <Loading />;

  const refresh = async () => { await Promise.all([mutate(), mutateEvents(), refreshTally()]); };
  const fail = (err: unknown) => setToast({ message: errorSentence(err), tone: "err" });
  const post = async (path: string, body?: unknown) => { await apiFetch<TallyRunView>(path, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) }); await refresh(); };
  const n = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s) : NaN);
  const sum = n(counts.created) + n(counts.altered) + n(counts.cancelled);
  const mismatch = counts.created !== "" && Number.isFinite(sum) && sum !== r.voucherCount;
  const download = async (part: "masters" | "vouchers") => {
    try { const f = await apiFetchBlob(`/sales/tally/runs/${r.id}/file?part=${part}`); downloadBlob(f.blob, f.filename ?? `tally-export${r.runNo}-${part}.xml`); } catch (err) { fail(err); }
  };
  const items = r.items.filter((i) => tab === "all" || (tab === "problems" ? ["failed", "blocked", "unknown"].includes(i.outcome) : i.action === "alter" || i.action === "cancel"));
  const docLink = (i: TallyRunView["items"][number]) => (i.docType === "invoice" ? `/invoices/view?id=${i.docId}` : i.docType === "receipt" ? `/payments/view?id=${i.docId}` : null);
  const should = r.summary?.tallyShouldShow;

  return (
    <>
      <PageHead kicker={<><Link href="/tally" className="hover:text-white">Tally</Link> · {r.channel === "file" ? "File" : r.channel === "push" ? "Sent to Tally" : "Resolved by hand"}</> as unknown as string}
        title={<>Export #{r.runNo} <StatusPill status={r.status} /></>}>
        {r.files.masters && <button type="button" className="btn btn-light btn-sm" onClick={() => download("masters")}>Download masters</button>}
        {r.files.vouchers && <button type="button" className="btn btn-light btn-sm" onClick={() => download("vouchers")}>Download vouchers</button>}
      </PageHead>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 grid grid-cols-[minmax(0,1fr)] gap-4 content-start">
          <section className="card p-4">
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div><dt className="text-xs text-ink-3">Period</dt><dd>{fmtDate(r.periodFrom)} – {fmtDate(r.periodTo)}</dd></div>
              <div className="min-w-0"><dt className="text-xs text-ink-3">Tally company</dt><dd className="break-words">{r.tallyCompany}</dd></div>
              <div className="min-w-0"><dt className="text-xs text-ink-3">Registration</dt><dd className="font-mono text-xs break-all">{r.scopeGstin ?? "All"}</dd></div>
              <div><dt className="text-xs text-ink-3">Mode</dt><dd>{r.mode === "new_only" ? "New and changed" : "Everything"}</dd></div>
              <div><dt className="text-xs text-ink-3">Vouchers</dt><dd>{r.voucherCount}{r.blockedCount ? ` (+${r.blockedCount} held back)` : ""}</dd></div>
              <div><dt className="text-xs text-ink-3">New ledgers</dt><dd>{r.masterCount}</dd></div>
              <div><dt className="text-xs text-ink-3">Control total</dt><dd><Money paise={r.controlTotalPaise} /></dd></div>
              <div><dt className="text-xs text-ink-3">Built</dt><dd>{r.createdBy?.name ?? "—"}, {fmtDate(r.createdAt)}</dd></div>
            </dl>
            <p className="text-xs text-ink-4 font-mono break-all mt-3">{r.previewHash}</p>
            {r.statusNote && <p className="text-sm text-ink-3 mt-2 break-words">Note: {r.statusNote}</p>}
            {r.tallyReported && <p className="text-sm text-ink-3 mt-1">Tally reported {r.tallyReported.created} created · {r.tallyReported.altered} altered · {r.tallyReported.cancelled} cancelled · {r.tallyReported.errors} errors.</p>}
          </section>

          {r.channel === "file" && r.status === "open" && (
            <>
              <div className="card border-attention p-3 text-sm">
                <p className="font-bold mb-1">Import into TallyPrime in this order:</p>
                <ol className="list-decimal ml-5 grid gap-1 break-words">
                  {r.files.masters && <li>Import → Masters → the masters file → <em>Ignore Duplicates</em>.</li>}
                  <li>Import → Transactions → the vouchers file.</li>
                  <li>Come back and type what Tally reported.</li>
                </ol>
                <p className="text-xs text-ink-3 mt-2">Never choose &apos;Modify with New Data&apos; — it would overwrite your ledgers&apos; GST settings.</p>
              </div>
              <form className="card p-4 grid grid-cols-[minmax(0,1fr)] gap-3" onSubmit={async (e) => {
                e.preventDefault();
                try { await post(`/sales/tally/runs/${r.id}/confirm`, { created: n(counts.created), altered: n(counts.altered), cancelled: n(counts.cancelled), errors: n(counts.errors), note }); setToast({ message: `Export #${r.runNo} marked as imported.`, tone: "ok" }); } catch (err) { fail(err); }
              }}>
                <h2 className="font-bold">Mark as imported into Tally</h2>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {(["created", "altered", "cancelled", "errors"] as const).map((k) => (
                    <Field key={k} label={k[0].toUpperCase() + k.slice(1)}><input className="input w-full" inputMode="numeric" value={counts[k]} onChange={(e) => setCounts({ ...counts, [k]: e.target.value })} /></Field>
                  ))}
                </div>
                {mismatch && <p className="text-sm text-danger">{sum} ≠ {r.voucherCount} vouchers in this export</p>}
                <Field label="Who imported it, and when"><textarea className="input w-full min-h-[70px]" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
                <div className="flex flex-col sm:flex-row gap-2">
                  <button type="submit" className="btn w-full sm:w-auto" disabled={counts.created === "" || note.trim().length < 3}>Mark as imported</button>
                  <button type="button" className="btn btn-danger w-full sm:w-auto" onClick={() => setModal("discard")}>Discard export</button>
                </div>
              </form>
            </>
          )}

          {r.channel === "push" && r.progress && (
            <section className="card p-4 grid gap-3">
              <div className="h-2 bg-muted w-full"><div className="h-2 bg-indigo" style={{ width: `${r.progress.total ? Math.round((r.progress.done / r.progress.total) * 100) : 0}%` }} /></div>
              <p className="text-sm">Sent {r.progress.done} · failed {r.progress.failed} · waiting {r.progress.waiting}</p>
              {r.stale && <div className="card border-attention p-3 text-sm">This send stopped (the server restarted). Resume it — Tally is checked first, so nothing is sent twice. {admin && <button type="button" className="btn btn-sm ml-2" onClick={async () => { try { await post(`/sales/tally/runs/${r.id}/retry`); } catch (err) { fail(err); } }}>Resume</button>}</div>}
              {r.pushResult?.error && (
                <div className="card border-danger p-3 text-sm break-words">{r.pushResult.error}
                  <button type="button" className="btn btn-light btn-sm ml-2" onClick={() => download("vouchers")}>Download the file instead</button></div>
              )}
              {r.status === "partial" && admin && (
                <div className="flex flex-col sm:flex-row gap-2">
                  <button type="button" className="btn w-full sm:w-auto" onClick={async () => { try { await post(`/sales/tally/runs/${r.id}/retry`); } catch (err) { fail(err); } }}>Retry failed</button>
                  <button type="button" className="btn btn-light w-full sm:w-auto" onClick={() => setModal("close")}>Close with failures</button>
                </div>
              )}
            </section>
          )}

          <section className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="flex flex-wrap gap-1">{TABS.map((t) => <button key={t} type="button" onClick={() => setTab(t)} className={`px-3 py-1 text-[12px] uppercase tracking-[0.08em] border-2 ${tab === t ? "bg-indigo border-indigo text-white font-bold" : "border-border text-ink-3"}`}>{t}</button>)}</div>
              {admin && picked.size > 0 && <button type="button" className="btn btn-sm" onClick={() => setModal("resolve")}>Mark selected as done in Tally</button>}
            </div>
            <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm [&_td]:px-2 [&_th]:px-2"><thead><tr className="text-left text-ink-3 text-xs"><th />{["Type", "Number", "Date", "Action", "Result", "Tally id", "Message"].map((h) => <th key={h} className="py-1">{h}</th>)}</tr></thead>
              <tbody>{items.map((i) => { const href = docLink(i); const pickable = admin && ["failed", "blocked"].includes(i.outcome); return (
                <tr key={i.id} className="border-t border-border align-top"><td className="py-1 pr-1">{pickable && <input type="checkbox" checked={picked.has(i.id)} onChange={(e) => setPicked((s) => { const x = new Set(s); if (e.target.checked) x.add(i.id); else x.delete(i.id); return x; })} aria-label={`Select ${i.docNumber}`} />}</td>
                  <td>{DOC_LABEL[i.docType]}</td><td className="font-mono break-all">{href ? <Link className="underline hover:text-white" href={href}>{i.docNumber}</Link> : i.docNumber}</td>
                  <td>{fmtDate(i.docDate)}</td><td>{i.action}</td><td><StatusPill status={i.outcome} /></td><td className="font-mono text-xs">{i.tallyVchId ?? "—"}</td>
                  <td className="text-xs text-danger break-words max-w-[280px]">{i.error ?? ""}</td></tr>); })}</tbody></table></div>
            {r.itemsTruncated && <p className="text-xs text-ink-3 mt-2">Showing the first 2,000 documents.</p>}
          </section>

          {should && (
            <section className="card p-4">
              <h2 className="font-bold mb-2">After importing, Tally should show</h2>
              <div className="overflow-x-auto"><table className="w-full min-w-[520px] text-sm [&_td]:px-2 [&_th]:px-2"><thead><tr className="text-left text-ink-3 text-xs"><th className="py-1">Registration</th><th>Month</th><th className="text-right">B2B taxable</th><th className="text-right">B2C taxable</th><th className="text-right">Tax</th><th className="text-right">Credit notes</th><th>Invoices</th></tr></thead>
                <tbody>{should.gst.map((g) => <tr key={g.gstin + g.month} className="border-t border-border"><td className="py-1">{g.label}</td><td>{g.month}</td><td className="text-right"><Money paise={g.b2b.taxablePaise} /></td><td className="text-right"><Money paise={g.b2c.taxablePaise} /></td>
                  <td className="text-right"><Money paise={g.b2b.cgstPaise + g.b2b.sgstPaise + g.b2b.igstPaise + g.b2c.cgstPaise + g.b2c.sgstPaise + g.b2c.igstPaise} /></td><td className="text-right"><Money paise={g.creditNotes.taxablePaise} /></td>
                  <td className="text-xs">{g.documents.issued} / {g.documents.cancelled} cancelled</td></tr>)}</tbody></table></div>
              {should.tds.map((t) => <p key={t.fy} className="text-sm mt-2">{t.ledger}: +<Money paise={t.paise} /> ({t.receipts} receipts)</p>)}
            </section>
          )}
        </div>
        <aside className="min-w-0"><EventList events={events} /></aside>
      </div>

      {modal === "discard" && (
        <Confirm danger title={`Discard export #${r.runNo}?`} confirmLabel="Discard" onClose={() => setModal(null)}
          onConfirm={async () => { try { await post(`/sales/tally/runs/${r.id}/discard`, { reason }); setModal(null); setToast({ message: "Discarded. Its documents come out in the next export.", tone: "ok" }); } catch (err) { fail(err); } }}
          body={<>Use this if the file was never imported, or Tally refused it. Its documents go back to &apos;not in Tally&apos; and come out in the next export.
            <Field label="Reason" className="mt-3"><input className="input w-full" value={reason} onChange={(e) => setReason(e.target.value)} /></Field></>} />
      )}
      {modal === "close" && (
        <Confirm title={`Close export #${r.runNo}?`} confirmLabel="Close" onClose={() => setModal(null)}
          onConfirm={async () => { try { await post(`/sales/tally/runs/${r.id}/close`, { reason }); setModal(null); } catch (err) { fail(err); } }}
          body={<>The failed documents stay &apos;not in Tally&apos; and come out in the next export.<Field label="Reason" className="mt-3"><input className="input w-full" value={reason} onChange={(e) => setReason(e.target.value)} /></Field></>} />
      )}
      {modal === "resolve" && (
        <Confirm title={`Mark ${picked.size} as done in Tally?`} confirmLabel="Mark as done" onClose={() => setModal(null)}
          onConfirm={async () => {
            try {
              const docs = r.items.filter((i) => picked.has(i.id)).map((i) => ({ docType: i.docType, docId: i.docId }));
              await apiFetch("/sales/tally/resolve", { method: "POST", body: JSON.stringify({ companyKey: r.companyKey, docs, note: reason }) });
              setPicked(new Set()); setModal(null); await refresh(); setToast({ message: "Recorded as done in Tally.", tone: "ok" });
            } catch (err) { fail(err); }
          }}
          body={<>Only when Tally already matches the portal for these documents (entered or fixed there by hand).<Field label="Note" className="mt-3"><input className="input w-full" value={reason} onChange={(e) => setReason(e.target.value)} /></Field></>} />
      )}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function TallyRunPage() {
  return <Suspense fallback={<Loading />}><RunView /></Suspense>;
}
