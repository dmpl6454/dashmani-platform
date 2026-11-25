"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import { ago, useBatches, when, type Batch } from "@/lib/links";
import { Empty, Field, LoadError, Loading, PageHead } from "@/components/sales-ui";
import { LinkIntake, useIntakeCounts, type IntakeValue } from "@/components/links/link-intake";

// Link Analytics — batches of Facebook / Instagram post links whose metrics we read from Meta's
// official API (docs/link-analytics/SPEC.md). This page lists batches and starts a new one; one
// batch's dashboard is /links/view?id=.

const STATE_LABEL: Record<Batch["state"], string> = { idle: "Done", running: "Checking", paused: "Paused" };

function NewBatch({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [keep, setKeep] = useState(false);
  const [intake, setIntake] = useState<IntakeValue>({ text: "", mode: "paste", fileName: null });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { counts, tooMany } = useIntakeCounts(intake, keep);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) return setErr("Give the batch a name.");
    setBusy(true);
    try {
      const r = await apiFetch<{ id: string }>("/sales/links/batches", { method: "POST", body: JSON.stringify({ name, notes: notes || null, keepDuplicates: keep, text: intake.text, mode: intake.mode }) });
      router.push(`/links/view?id=${r.data.id}`);
    } catch (e2) {
      setErr(errorSentence(e2));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card p-4 mb-6 grid grid-cols-1 gap-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Batch name"><input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="e.g. Diwali campaign — week 1" autoFocus /></Field>
        <Field label="Notes (optional)"><input className="input w-full" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="Client, campaign, anything useful" /></Field>
      </div>
      <LinkIntake value={intake} onChange={setIntake} keepDuplicates={keep} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        Keep duplicate links as separate rows (the post is still read once)
      </label>
      {err && <p className="text-sm text-danger" role="alert">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn" disabled={busy || !counts?.valid || Boolean(tooMany)} aria-live="polite">
          {busy ? "Creating…" : counts?.valid ? `Create batch and check ${counts.unique} post${counts.unique === 1 ? "" : "s"}` : "Create batch"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
      <p className="text-xs text-ink-3">
        Metrics come only from Meta&apos;s official API. Posts on our connected Pages and Instagram accounts get full insights; other Instagram business and creator accounts get public likes, comments and reel views; everything else is marked Restricted with the reason — never zeros.
      </p>
    </form>
  );
}

export default function LinksPage() {
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const { data, error, isLoading, mutate } = useBatches(archived);
  const worker = data?.worker;

  return (
    <>
      <PageHead kicker="Social post metrics from Meta" title="Link analytics">
        {!creating && <button type="button" className="btn" onClick={() => setCreating(true)}>New batch</button>}
      </PageHead>
      {worker && !worker.enabled && <p className="card p-3 mb-4 text-sm text-attention">The background checker is switched off on this server, so batches won&apos;t progress.</p>}
      {worker?.throttledUntil && <p className="card p-3 mb-4 text-sm text-attention">Meta asked us to slow down ({worker.throttleReason}). Checking resumes {ago(worker.throttledUntil).replace(" ago", "")} — at {when(worker.throttledUntil).split(", ")[1]}.</p>}
      {creating && <NewBatch onClose={() => setCreating(false)} />}

      <div className="flex gap-1 mb-3" role="tablist" aria-label="Batches">
        {[[false, "Batches"], [true, "Archived"]].map(([k, label]) => (
          <button key={String(k)} type="button" role="tab" aria-selected={archived === k} onClick={() => setArchived(k as boolean)} className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${archived === k ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:border-border hover:text-white"}`}>{label as string}</button>
        ))}
      </div>

      {error ? <LoadError error={error} retry={() => mutate()} /> : isLoading && !data ? <Loading /> : !data?.batches.length ? (
        <Empty title={archived ? "No archived batches." : "No batches yet."} body={archived ? "Archived batches are deleted 30 days after archiving." : "Paste a list of Facebook or Instagram post links to start."} action={!archived && !creating ? <button type="button" className="btn" onClick={() => setCreating(true)}>New batch</button> : undefined} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left">
              <tr className="border-b-2 border-border">
                <th className="p-3">Batch</th><th className="p-3">State</th><th className="p-3 text-right">Links</th><th className="p-3 text-right">Posts</th>
                <th className="p-3 text-right">Verified</th><th className="p-3 text-right">Restricted</th><th className="p-3 text-right">Failed</th><th className="p-3 text-right">Pending</th><th className="p-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {data.batches.map((b) => (
                <tr key={b.id} className="border-b border-rule hover:bg-muted/60">
                  <td className="p-3 min-w-0">
                    <Link href={`/links/view?id=${b.id}`} className="font-bold hover:text-indigo-light">{b.name}</Link>
                    {b.refreshEveryHours && <div className="text-xs text-ink-4">Refreshes every {b.refreshEveryHours} h</div>}
                  </td>
                  <td className="p-3 text-xs">{STATE_LABEL[b.state]}</td>
                  <td className="p-3 text-right tabular-nums">{b.counts.total}</td>
                  <td className="p-3 text-right tabular-nums">{b.counts.unique}</td>
                  <td className="p-3 text-right tabular-nums text-success">{b.counts.verified}</td>
                  <td className="p-3 text-right tabular-nums text-attention">{b.counts.restricted}</td>
                  <td className="p-3 text-right tabular-nums text-danger">{b.counts.failed}</td>
                  <td className="p-3 text-right tabular-nums">{b.counts.pending}</td>
                  <td className="p-3 text-xs">{fmtDate(b.createdAt)}{b.createdBy ? <div className="text-ink-4">{b.createdBy}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
