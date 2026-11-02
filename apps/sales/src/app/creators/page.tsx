"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { fmtDate } from "@/lib/format";
import { CONNECTION_LABEL, CREATOR_STATUS_LABEL, useCreators } from "@/lib/creators";
import { Empty, LoadError, Loading, PageHead, StatusPill } from "@/components/sales-ui";

// Creators who signed up on creators.digitalsukoon.com, connected their Facebook Pages /
// Instagram accounts and asked to be approved. The same queue as the staff portal's Creators.

const TABS: Array<[string, string]> = [
  ["in_review", "In review"], ["approved", "Approved"], ["rejected", "Not approved"], ["suspended", "Suspended"], ["draft", "Setting up"], ["", "All"],
];

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

export default function CreatorsPage() {
  const [tab, setTab] = useState("in_review");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(typed), 250);
    return () => clearTimeout(t);
  }, [typed]);
  const { data, error, isLoading, mutate } = useCreators(tab, q);
  const counts = data?.counts;
  const total = counts ? Object.values(counts).reduce((s, v) => s + v, 0) : null;

  return (
    <>
      <PageHead kicker={counts ? `${counts.in_review} waiting for review · ${counts.approved} approved` : "Creators"} title="Creators" />
      <p className="text-sm text-ink-3 -mt-2 mb-4">Creators sign up on creators.digitalsukoon.com and connect their Facebook Pages and Instagram accounts. Approve the creator, then turn on the pages we may offer. Pages that are already on our own network can never be turned on.</p>
      <div className="card p-3 mb-4 flex flex-wrap gap-2 items-center">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Creator status">
          {TABS.map(([k, label]) => {
            const n = !counts ? null : k ? counts[k as keyof typeof counts] ?? 0 : total;
            return (
              <button key={k || "all"} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${tab === k ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:border-border hover:text-white"}`}>
                {label}{n != null && <span className="ml-1 tabular-nums opacity-70">{n}</span>}
              </button>
            );
          })}
        </div>
        <input className="input flex-1 min-w-[200px]" placeholder="Search name or email" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </div>
      {error ? <LoadError error={error} retry={() => mutate()} /> : isLoading && !data ? <Loading /> : !data?.creators.length ? (
        <Empty title={tab === "in_review" ? "Nobody is waiting for review." : "No creators here."} body="Creators appear once they sign up on the creator portal." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left">
              <tr className="border-b-2 border-border"><th className="p-3">Creator</th><th className="p-3">Status</th><th className="p-3">Facebook</th><th className="p-3">Pages</th><th className="p-3 text-right">Followers</th><th className="p-3">Submitted</th></tr>
            </thead>
            <tbody>
              {data.creators.map((c) => (
                <tr key={c.id} className="border-b border-rule hover:bg-muted/60">
                  <td className="p-3 min-w-0">
                    <Link href={`/creators/view?id=${c.id}`} className="font-bold hover:text-indigo-light">{c.name}</Link>
                    <div className="text-xs text-ink-4 break-all">{c.email}{c.country ? ` · ${c.country}` : ""}</div>
                  </td>
                  <td className="p-3"><StatusPill status={c.status} label={CREATOR_STATUS_LABEL[c.status] ?? c.status} /></td>
                  <td className="p-3 text-xs">{c.connectionStatus ? CONNECTION_LABEL[c.connectionStatus] ?? c.connectionStatus : <span className="text-ink-4">Not connected</span>}</td>
                  <td className="p-3">{c.pages}<span className="text-xs text-ink-4"> · {c.publishablePages} offerable</span></td>
                  <td className="p-3 text-right tabular-nums">{compact(c.followers)}</td>
                  <td className="p-3 text-xs">{c.submittedAt ? fmtDate(c.submittedAt) : <span className="text-ink-4">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
