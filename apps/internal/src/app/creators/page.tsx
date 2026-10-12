"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { useCreators, CREATOR_STATUS_ORDER } from "@/lib/hooks/use-creators";
import { CARD, INPUT, ErrorBar, PageHead, compact, fmtWhen } from "../campaigns/_ds";
import { CREATOR_STATUS, CreatorStatusPill } from "./_status";

// Creator portal review queue: creators who connected their pages and asked to be approved.

const TABS: Array<{ key: string; label: string }> = [
  ...CREATOR_STATUS_ORDER.map((s) => ({ key: s as string, label: CREATOR_STATUS[s].label })),
  { key: "", label: "All" },
];

export default function CreatorsPage() {
  usePageTitle("Creators");
  const [tab, setTab] = useState<string>("in_review");
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(typed), 250);
    return () => clearTimeout(t);
  }, [typed]);

  const { data, error, isLoading } = useCreators(tab, q);
  const rows = data?.creators ?? [];
  const counts = data?.counts;
  const total = counts ? Object.values(counts).reduce((s, v) => s + v, 0) : 0;

  return (
    <div className="pb-8">
      <PageHead
        title="Creators"
        sub={!counts ? "Loading…" : `${counts.in_review} waiting for review · ${counts.approved} approved`}
      />

      <div className="flex flex-col md:flex-row md:items-center gap-3 mb-4">
        <div className="flex gap-1.5 flex-wrap flex-1" role="tablist" aria-label="Creator status">
          {TABS.map((t) => {
            const n = !counts ? null : t.key ? counts[t.key as keyof typeof counts] ?? 0 : total;
            const on = t.key === tab;
            return (
              <button
                key={t.key || "all"}
                role="tab"
                aria-selected={on}
                type="button"
                onClick={() => setTab(t.key)}
                className={`h-9 px-3.5 rounded-full text-[12.5px] font-semibold border transition-colors ${on ? "border-ds-gold text-ds-gold bg-[rgba(233,189,98,.08)]" : "border-ds-line2 text-ds-t2 hover:text-ds-text"}`}
              >
                {t.label} {n != null && <span className="tabular-nums opacity-70">{n}</span>}
              </button>
            );
          })}
        </div>
        <label className="relative md:w-[280px] shrink-0">
          <span className="sr-only">Search creators</span>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ds-t4 pointer-events-none" />
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search name or email"
            className={`${INPUT} pl-9`}
          />
        </label>
      </div>

      {error && <ErrorBar message="Couldn't load creators. Refresh to try again." />}

      <section className={`${CARD} overflow-hidden ${error ? "mt-4" : ""}`}>
        {!data && isLoading && <div className="py-14 text-center text-ds-t3 text-[13px]">Loading…</div>}
        {data && rows.length === 0 && (
          <div className="py-14 text-center text-ds-t3 text-[13px]">{q ? `No creators match “${q}”.` : "Nothing here."}</div>
        )}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px] min-w-[860px]">
              <thead>
                <tr className="text-left text-[11.5px] uppercase tracking-[.06em] text-ds-t3 border-b border-[#132430]">
                  <th className="px-5 py-3 font-semibold">Name</th>
                  <th className="px-3 py-3 font-semibold">Email</th>
                  <th className="px-3 py-3 font-semibold">Country</th>
                  <th className="px-3 py-3 font-semibold text-right">Pages</th>
                  <th className="px-3 py-3 font-semibold text-right">Publishable</th>
                  <th className="px-3 py-3 font-semibold text-right">Followers</th>
                  <th className="px-3 py-3 font-semibold">Status</th>
                  <th className="px-5 py-3 font-semibold">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-[#132430] last:border-0 hover:bg-ds-hover transition-colors">
                    <td className="px-5 py-3 max-w-[220px]">
                      <Link href={`/creators/${r.id}`} className="font-semibold text-ds-text hover:text-ds-gold truncate block" title={r.name}>
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-ds-t2 max-w-[240px] truncate" title={r.email}>{r.email}</td>
                    <td className="px-3 py-3 text-ds-t2">{r.country ?? "—"}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-ds-t2">{r.pages}</td>
                    <td className="px-3 py-3 text-right tabular-nums" style={{ color: r.publishablePages > 0 ? "#00D7A0" : undefined }}>{r.publishablePages}</td>
                    <td className="px-3 py-3 text-right tabular-nums text-ds-text">{compact(r.followers)}</td>
                    <td className="px-3 py-3"><CreatorStatusPill status={r.status} /></td>
                    <td className="px-5 py-3 text-ds-t3 whitespace-nowrap">{r.submittedAt ? fmtWhen(r.submittedAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
