"use client";
// Reconcile → Client balances (spec-reconcile §7.5): the "as of" and "from" days, stats, What to
// do next (Send to N), filters, a name search and one card per client.
import { useMemo, useState } from "react";
import { useSWRConfig } from "swr";
import { useConfirmations } from "@/lib/hooks";
import { useCompany } from "@/lib/company";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr, todayIST } from "@/lib/format";
import { drCrText, reconKey } from "@/lib/reconcile";
import { defaultAsOf, fyStartOf } from "@dashmani/shared/src/sales/recon";
import type { ConfirmationsView } from "@/lib/sales-types";
import { Confirm, Empty, Field, LoadError, Loading, Stat } from "@/components/sales-ui";
import { TodoCard } from "./todo-card";
import { FilterPills } from "./tab-bar";
import { ConfirmationCard } from "./confirmation-card";
import { ReplyDialog } from "./reply-dialog";
import { SendDialog } from "./send-dialog";

type Filter = "not_sent" | "waiting" | "disputed" | "confirmed" | "all";

export function BalancesTab({ asOf, from, onDates, toast }: { asOf?: string; from?: string; onDates: (asOf: string, from: string) => void; toast: (m: string, tone?: "ok" | "err") => void }) {
  const { company } = useCompany();
  const today = todayIST();
  const a = asOf ?? defaultAsOf(today);
  const f = from ?? fyStartOf(a);
  const { data, error, isLoading, mutate } = useConfirmations(a, f);
  const { mutate: globalMutate } = useSWRConfig();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reply, setReply] = useState<ConfirmationsView["rows"][number] | null>(null);
  const [sendRows, setSendRows] = useState<{ rows: ConfirmationsView["rows"]; resend: boolean } | null>(null);
  const [confirmOne, setConfirmOne] = useState<ConfirmationsView["rows"][number] | null>(null);
  const refresh = () => globalMutate(reconKey, undefined, { revalidate: true });

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => {
    const s = r.confirmation;
    const ok = filter === "all" ? true : filter === "not_sent" ? (!s || s.sentCount === 0) && r.balancePaise !== 0 : filter === "waiting" ? s?.status === "pending" && s.sentCount > 0 : s?.status === filter;
    return ok && (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase()));
  }), [data, filter, q]);

  if (error && (!data || data.company !== company)) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading && !data) return <Loading label="Adding up balances…" />;
  if (!data || data.company !== company) return <Loading />;
  const d = data;
  const stale = d.asOf !== a || d.from !== f;
  const c = d.counts;
  const notSentRows = d.rows.filter((r) => (!r.confirmation || r.confirmation.sentCount === 0) && r.balancePaise !== 0);
  const sendOne = async (clientId: string, resend: boolean, id?: string) => {
    try {
      const r = id && resend
        ? await apiFetch<{ email: { to: string[] } }>(`/sales/reconcile/confirmations/${id}/send?company=${company}`, { method: "POST", body: JSON.stringify({ refresh: true }) })
        : await apiFetch<{ email: { to: string[] } | null }>("/sales/reconcile/confirmations", { method: "POST", body: JSON.stringify({ companyKey: company, clientId, asOf: d.asOf, from: d.from, send: true, refresh: true }) });
      toast(r.data.email ? `Sent to ${r.data.email.to.join(", ")}.` : "Statement saved.");
      await refresh();
    } catch (err) { toast(errorSentence(err), "err"); }
  };
  const chips = [defaultAsOf(today), `${Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) >= 4 ? 0 : 1)}-03-31`, ...(Number(today.slice(5, 7)) > 9 ? [`${today.slice(0, 4)}-09-30`] : [])].filter((x, i, arr) => x <= today && arr.indexOf(x) === i);

  return (
    <div>
      {/* keepPreviousData: a failed date change leaves the old figures on screen — say so above them. */}
      {error && <div className="mb-4"><LoadError error={error} retry={() => mutate()} /></div>}
    <div className={stale ? "opacity-60" : ""} aria-busy={(stale && !error) || undefined}>
      <div className="flex flex-wrap gap-3 items-end mb-4">
        <Field label="Balance as of"><input type="date" className="input" value={d.asOf} max={today} onChange={(e) => e.target.value && onDates(e.target.value, fyStartOf(e.target.value))} /></Field>
        <Field label="Statement from"><input type="date" className="input" value={d.from} max={d.asOf} onChange={(e) => e.target.value && onDates(d.asOf, e.target.value)} /></Field>
        <div className="flex flex-wrap gap-2">{chips.map((ch) => <button key={ch} type="button" className="btn btn-ghost btn-sm" onClick={() => onDates(ch, fyStartOf(ch))}>{fmtDate(ch)}</button>)}</div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Stat label="Clients with a balance" value={String(c.withBalance)} sub={`${fmtInr(c.drPaise, { whole: true })} Dr · ${fmtInr(c.crPaise, { whole: true })} Cr`} />
        <Stat label="Not sent" value={String(c.notSent)} />
        <Stat label="Waiting for a reply" value={String(c.pending)} sub={c.overdue ? `${c.overdue} over 15 days` : undefined} />
        <Stat label="Disputed" tone={c.disputed ? "danger" : undefined} value={String(c.disputed)} sub={c.disputed ? `difference ${fmtInr(c.disputedPaise)}` : undefined} />
      </div>
      <TodoCard todo={d.todo} empty={`Every balance as of ${fmtDate(d.asOf)} is confirmed or has nothing to confirm.`} actionFor={(t, first) => {
        const cls = first ? "btn btn-sm" : "btn btn-ghost btn-sm";
        if (t.code === "send") return <button type="button" className={cls} onClick={() => setSendRows({ rows: notSentRows, resend: false })}>Send to {Math.min(25, notSentRows.length)}</button>;
        if (t.code === "overdue") return <button type="button" className={cls} onClick={() => setFilter("waiting")}>Show</button>;
        if (t.code === "disputed") return <button type="button" className={cls} onClick={() => setFilter("disputed")}>Show</button>;
        if (t.code === "stale") return <button type="button" className={cls} onClick={() => setSendRows({ rows: d.rows.filter((r) => r.confirmation?.stale), resend: true })}>Send again</button>;
        return null;
      }} />
      <div className="flex flex-wrap gap-2 items-center mb-1">
        <input className="input w-full sm:w-64" placeholder="Search clients" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search clients" />
        {picked.size > 0 && <button type="button" className="btn btn-light btn-sm" onClick={() => setSendRows({ rows: d.rows.filter((r) => picked.has(r.clientId)), resend: false })}>Send to {Math.min(25, picked.size)} selected</button>}
      </div>
      <FilterPills<Filter> label="Show" current={filter} onPick={setFilter} items={[
        { key: "not_sent", label: "Not sent", count: c.notSent }, { key: "waiting", label: "Waiting", count: c.pending }, { key: "disputed", label: "Disputed", count: c.disputed },
        { key: "confirmed", label: "Confirmed", count: c.confirmed }, { key: "all", label: "All", count: c.clients },
      ]} />
      {rows.length === 0 ? <Empty title={d.rows.length ? "Nothing here." : `No client has a balance or a document with this company up to ${fmtDate(d.asOf)}.`} /> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {rows.map((r) => (
            <ConfirmationCard key={r.clientId} r={r} asOf={d.asOf} from={d.from} checked={picked.has(r.clientId)}
              onCheck={(v) => setPicked((s) => { const n = new Set(s); if (v) n.add(r.clientId); else n.delete(r.clientId); return n; })}
              onSend={() => setConfirmOne(r)} onReply={() => setReply(r)} />
          ))}
        </div>
      )}
      {reply?.confirmation && <ReplyDialog c={reply.confirmation} name={reply.name} company={company} onClose={() => setReply(null)} onSaved={async (m) => { setReply(null); toast(m); await refresh(); }} />}
      {confirmOne && (
        <Confirm title={`${confirmOne.confirmation && confirmOne.confirmation.sentCount > 0 ? "Resend" : "Send"} the statement to ${confirmOne.name}?`} confirmLabel="Send"
          onClose={() => setConfirmOne(null)}
          onConfirm={async () => { const r = confirmOne; setConfirmOne(null); await sendOne(r.clientId, !!r.confirmation && r.confirmation.sentCount > 0, r.confirmation?.id); }}
          body={<>To: <span className="font-mono break-all">{confirmOne.email ?? "no email"}</span> (and the client&apos;s other billing emails), Cc: your accounts emails<br />Balance as of {fmtDate(d.asOf)}: {drCrText(confirmOne.balancePaise)}</>} />
      )}
      {sendRows && <SendDialog rows={sendRows.rows} initialResend={sendRows.resend} company={company} asOf={d.asOf} from={d.from} onClose={() => setSendRows(null)} onSent={async (m) => { setSendRows(null); setPicked(new Set()); toast(m); await refresh(); }} />}
    </div>
    </div>
  );
}
