"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { useRecurring } from "@/lib/hooks";
import { companyName } from "@/lib/company";
import { errorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import type { Recurring } from "@/lib/sales-types";
import { Confirm, Empty, LoadError, Loading, Money, PageHead, StatusPill, Toast } from "@/components/sales-ui";
import { FREQUENCY_LABEL, MODE_LABEL, recurringTaxable } from "@/components/recurring-table";

// One recurring invoice: its schedule, the invoices it has made, and pause / resume / end /
// "Run now" (bills the next period immediately, exactly as the daily job would).

interface RunResult { result: { invoiceId: string | null; issued: boolean; emailed: boolean; error: string | null; skipped?: string | null; period?: string | null }; recurring: Recurring }

function View() {
  const id = useSearchParams().get("id");
  const { data: r, error, isLoading, mutate } = useRecurring(id);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | "end" | "run">(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  if (!id) return <Empty title="No recurring invoice selected." action={<Link href="/recurring" className="btn">Back to recurring</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !r) return <Loading />;

  async function act(action: "pause" | "resume" | "end") {
    setBusy(true);
    try {
      await apiFetch(`/sales/recurring/${id}/${action}`, { method: "POST" });
      await mutate();
      setToast({ message: action === "pause" ? "Paused. Nothing is billed until it is resumed." : action === "resume" ? "Resumed from the next period." : "Ended. No further invoices.", tone: "ok" });
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
    } finally {
      setBusy(false);
    }
  }
  async function runNow() {
    setBusy(true);
    try {
      const res = await apiFetch<RunResult>(`/sales/recurring/${id}/run`, { method: "POST" });
      await mutate(res.data.recurring, { revalidate: false });
      const out = res.data.result;
      setToast(out.error
        ? { message: out.invoiceId ? `Invoice created, but: ${out.error}` : out.error, tone: "err" }
        : { message: out.issued ? (out.emailed ? "Invoice issued and emailed." : "Invoice issued.") : "Draft invoice created.", tone: "ok" });
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
    } finally {
      setBusy(false);
    }
  }

  const row = (label: string, value: React.ReactNode) => <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">{label}</dt><dd>{value}</dd></div>;
  return (
    <>
      <PageHead kicker={<Link href="/recurring" className="hover:text-white">Recurring</Link> as unknown as string} title={r.title}>
        {r.status !== "ended" && <Link href={`/recurring/edit?id=${r.id}`} className="btn btn-light">Edit</Link>}
        {r.status === "active" && <button type="button" className="btn" disabled={busy} onClick={() => setConfirm("run")}>Run now</button>}
        {r.status === "active" && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => act("pause")}>Pause</button>}
        {r.status === "paused" && <button type="button" className="btn" disabled={busy} onClick={() => act("resume")}>Resume</button>}
        {r.status !== "ended" && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setConfirm("end")}>End</button>}
      </PageHead>
      {r.lastError && <div className="card p-3 mb-4 text-sm border-danger text-danger" role="alert">Last run{r.lastRunAt ? ` (${fmtDate(r.lastRunAt)})` : ""}: {r.lastError}</div>}
      <section className="card p-4 mb-5">
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
          {row("Status", <StatusPill status={r.status} />)}
          {row("Client", <Link href={`/clients/view?id=${r.client.id}`} className="hover:text-indigo-light">{r.client.companyName}</Link>)}
          {row("Billed by", companyName(r.companyKey))}
          {row("Billed from", r.sellerGstin ? <span className="font-mono">{r.sellerGstin}</span> : "Automatic")}
          {row("Every", `${FREQUENCY_LABEL[r.frequency] ?? r.frequency} · day ${r.dayOfMonth}`)}
          {row("Next run", r.status === "ended" ? "—" : `${fmtDate(r.nextRunDate)} · ${r.nextPeriodLabel}`)}
          {row("Each period", MODE_LABEL[r.mode] ?? r.mode)}
          {row("Runs", `${fmtDate(r.startDate)} → ${r.endDate ? fmtDate(r.endDate) : "until ended"}`)}
          {row("Per period (pre-GST)", <Money paise={recurringTaxable(r)} />)}
          {row("Kind", r.kind === "proforma" ? "Proforma" : "Tax invoice")}
          {row("Due after", r.dueDays == null ? "Company default" : `${r.dueDays} days`)}
          {row("Last run", r.lastRunAt ? fmtDate(r.lastRunAt) : "Never")}
        </dl>
      </section>
      <section className="card p-4 mb-5">
        <h2 className="font-bold mb-3">Lines</h2>
        <ul className="text-sm grid gap-1">{r.lines.map((l, i) => <li key={i} className="flex justify-between gap-3"><span>{l.description}{l.quantity > 1 ? ` × ${l.quantity}` : ""}</span><Money paise={Math.max(0, l.quantity * l.unitPricePaise - (l.discountPaise ?? 0))} /></li>)}</ul>
      </section>
      <section className="card overflow-x-auto">
        <h2 className="font-bold p-4 pb-2">Invoices made</h2>
        {!r.invoices?.length ? <p className="p-4 pt-0 text-sm text-ink-3">None yet. The first one is made on {fmtDate(r.nextRunDate)}.</p> : (
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-3">Invoice</th><th className="p-3">Issued</th><th className="p-3">Status</th><th className="p-3 text-right">Total</th></tr></thead>
            <tbody>{r.invoices.map((i) => (
              <tr key={i.id} className="border-b border-rule">
                <td className="p-3"><Link href={`/invoices/view?id=${i.id}`} className="font-mono hover:text-indigo-light">{i.number ?? "Draft"}</Link>{i.notes && <span className="block text-xs text-ink-3">{i.notes.split("\n")[0]}</span>}</td>
                <td className="p-3">{fmtDate(i.issueDate)}</td><td className="p-3"><StatusPill status={i.status} /></td><td className="p-3 text-right"><Money paise={i.totalPaise} /></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      {confirm === "run" && <Confirm title="Bill the next period now?" body={`This creates the invoice for ${r.nextPeriodLabel} immediately (${MODE_LABEL[r.mode]?.toLowerCase()}), and the next run moves on a period.`} confirmLabel="Run now" onConfirm={async () => { await runNow(); setConfirm(null); }} onClose={() => setConfirm(null)} />}
      {confirm === "end" && <Confirm danger title="End this recurring invoice?" body="No further invoices are made. Invoices already made are not touched. This cannot be undone." confirmLabel="End it" onConfirm={async () => { await act("end"); setConfirm(null); }} onClose={() => setConfirm(null)} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function RecurringViewPage() {
  return <Suspense fallback={<Loading />}><View /></Suspense>;
}
