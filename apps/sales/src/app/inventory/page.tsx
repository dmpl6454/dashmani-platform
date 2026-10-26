"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Download, ExternalLink } from "lucide-react";
import { useInventory } from "@/lib/hooks";
import { downloadBlob } from "@/lib/api";
import { fmtCompact, fmtInr, todayIST } from "@/lib/format";
import { Empty, LoadError, Loading, PageHead, platformLabel, titleCase } from "@/components/sales-ui";
import type { InventoryChannel } from "@/lib/sales-types";

// Two views of one list. "Client catalogue" is exactly what clients see on the client portal under
// Campaigns — the API builds it from the same catalogue — bookable channels with an active price.
// "All channels" adds every other connected or tracked account, without a price, so the sales team
// can still quote it at a negotiated price. Either view exports to CSV as filtered and sorted.

type View = "catalogue" | "all";
type Sort = "followers" | "views" | "engagement" | "price";
const FORMAT_ORDER = ["post", "reel", "carousel", "story"];

function csvFor(rows: InventoryChannel[]): string {
  const active = (c: InventoryChannel) => c.offers.filter((o) => o.active);
  const formats = FORMAT_ORDER.filter((f) => rows.some((c) => active(c).some((o) => o.format === f)));
  const ent = formats.filter((f) => rows.some((c) => active(c).some((o) => o.format === f && o.entertainmentPricePaise != null)));
  const audio = rows.some((c) => active(c).some((o) => o.audioAddonPaise != null));
  const head = [
    "Channel", "Handle", "Platform", "Category", "In client catalogue", "Followers", "Views 28d", "Engagement %",
    ...formats.map((f) => `${titleCase(f)} price (Rs)`),
    ...ent.map((f) => `${titleCase(f)} entertainment price (Rs)`),
    ...(audio ? ["Audio add-on (Rs)"] : []),
    "Profile URL",
  ];
  const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rupees = (p: number | null | undefined) => (p == null ? "" : String(Math.round(p / 100)));
  const lines = rows.map((c) => {
    const offer = (f: string) => active(c).find((o) => o.format === f);
    return [
      c.name, c.handle ?? "", platformLabel(c.platform), c.category ?? "", c.inCatalogue ? "yes" : "no", c.followers ?? "", c.views28d ?? "", c.engagementRatePct ?? "",
      ...formats.map((f) => rupees(offer(f)?.pricePaise)),
      ...ent.map((f) => rupees(offer(f)?.entertainmentPricePaise)),
      ...(audio ? [rupees(active(c).find((o) => o.audioAddonPaise != null)?.audioAddonPaise)] : []),
      c.profileUrl ?? "",
    ].map(cell).join(",");
  });
  return [head.map(cell).join(","), ...lines].join("\r\n") + "\r\n";
}

export default function InventoryPage() {
  const { data, error, isLoading, mutate } = useInventory();
  const [view, setView] = useState<View>("catalogue");
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState("all");
  const [sort, setSort] = useState<Sort>("followers");

  const scoped = useMemo(() => (data ?? []).filter((c) => view === "all" || c.inCatalogue), [data, view]);
  const platforms = useMemo(() => Array.from(new Set(scoped.map((c) => c.platform))).sort(), [scoped]);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const minPrice = (c: InventoryChannel) => {
      const prices = c.offers.filter((o) => o.active).map((o) => o.pricePaise);
      return prices.length ? Math.min(...prices) : null;
    };
    return scoped
      .filter((c) => platform === "all" || c.platform === platform)
      .filter((c) => !term || c.name.toLowerCase().includes(term) || (c.handle ?? "").toLowerCase().includes(term) || (c.category ?? "").toLowerCase().includes(term))
      .sort((a, b) => {
        if (sort === "views") return (b.views28d ?? -1) - (a.views28d ?? -1);
        if (sort === "engagement") return (b.engagementRatePct ?? -1) - (a.engagementRatePct ?? -1);
        if (sort === "price") return (minPrice(a) ?? Number.MAX_SAFE_INTEGER) - (minPrice(b) ?? Number.MAX_SAFE_INTEGER);
        return (b.followers ?? -1) - (a.followers ?? -1);
      });
  }, [scoped, q, platform, sort]);

  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !data) return <Loading label="Loading the catalogue…" />;
  const listed = data.filter((c) => c.inCatalogue).length;
  const exportCsv = () => {
    const name = `inventory-${view === "catalogue" ? "client-catalogue" : "all-channels"}${platform === "all" ? "" : `-${platform}`}-${todayIST()}.csv`;
    downloadBlob(new Blob(["﻿" + csvFor(rows)], { type: "text/csv;charset=utf-8" }), name);
  };
  return (
    <>
      <PageHead kicker={`${listed} channels in the client catalogue · ${data.length} tracked in all`} title="Inventory">
        <button type="button" className="btn btn-light" onClick={exportCsv} disabled={rows.length === 0}><Download size={14} /> Export CSV ({rows.length})</button>
        <Link href="/quotes/edit" className="btn">New quote</Link>
      </PageHead>
      <div className="card p-3 mb-4 flex flex-wrap gap-2 items-center">
        <div className="flex gap-1" role="tablist" aria-label="Inventory view">
          <button type="button" role="tab" aria-selected={view === "catalogue"} className={`btn btn-sm ${view === "catalogue" ? "" : "btn-ghost"}`} onClick={() => { setView("catalogue"); setPlatform("all"); }}>Client catalogue ({listed})</button>
          <button type="button" role="tab" aria-selected={view === "all"} className={`btn btn-sm ${view === "all" ? "" : "btn-ghost"}`} onClick={() => { setView("all"); setPlatform("all"); }}>All channels ({data.length})</button>
        </div>
        <input className="input flex-1 min-w-[200px]" placeholder="Search name, handle or category" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-auto" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="all">All platforms</option>
          {platforms.map((p) => <option key={p} value={p}>{platformLabel(p)}</option>)}
        </select>
        <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="followers">Most followers</option>
          <option value="views">Most views (28d)</option>
          <option value="engagement">Best engagement</option>
          <option value="price">Lowest price</option>
        </select>
      </div>
      {rows.length === 0 ? (
        <Empty title="No channels match." body={view === "catalogue" ? "Nothing in the client catalogue matches. Try another platform, clear the search, or switch to all channels." : "Try another platform or clear the search."} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left">
              <tr className="border-b-2 border-border">
                <th className="p-3">Channel</th><th className="p-3">Platform</th><th className="p-3 text-right">Followers</th><th className="p-3 text-right">Views 28d</th><th className="p-3 text-right">Eng.</th><th className="p-3">{view === "catalogue" ? "Client price" : "Rate card"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const offers = c.offers.filter((o) => o.active);
                return (
                  <tr key={`${c.targetType}:${c.targetId}`} className="border-b border-rule hover:bg-muted/60">
                    <td className="p-3 min-w-[220px]">
                      <div className="flex items-center gap-2 min-w-0">
                        {c.pictureUrl ? <img src={c.pictureUrl} alt="" className="w-7 h-7 rounded-full shrink-0" /> : <span className="w-7 h-7 rounded-full bg-muted shrink-0" aria-hidden />}
                        <div className="min-w-0">
                          <div className="font-bold truncate">{c.name} {c.profileUrl && <a href={c.profileUrl} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-white inline-block align-middle" aria-label="Open profile"><ExternalLink size={12} /></a>}</div>
                          <div className="text-xs text-ink-3 truncate">{c.handle ? `@${c.handle}` : ""}{c.category ? ` · ${c.category}` : ""}{!c.inCatalogue ? (c.bookable ? " · not in client catalogue" : " · tracked only") : ""}</div>
                        </div>
                      </div>
                    </td>
                    <td className="p-3 whitespace-nowrap">{platformLabel(c.platform)}</td>
                    <td className="p-3 text-right font-mono">{fmtCompact(c.followers)}</td>
                    <td className="p-3 text-right font-mono">{fmtCompact(c.views28d)}</td>
                    <td className="p-3 text-right font-mono">{c.engagementRatePct == null ? "—" : `${c.engagementRatePct}%`}</td>
                    <td className="p-3">
                      {offers.length === 0 ? <span className="text-ink-4">{c.offers.length > 0 ? "price withdrawn" : "no price set"}</span> : (
                        <div className="flex flex-wrap gap-1">
                          {offers.map((o) => (
                            <span key={o.rateCardId} className="border border-border px-1.5 py-0.5 text-xs whitespace-nowrap">{titleCase(o.format)} <span className="font-mono">{fmtInr(o.pricePaise, { whole: true })}</span>{o.entertainmentPricePaise != null && <span className="text-ink-3"> · ent {fmtInr(o.entertainmentPricePaise, { whole: true })}</span>}</span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-ink-4 mt-3">The client catalogue is what clients see on the client portal under Campaigns, served from the same list. Followers and 28-day views come from Meta for connected Pages and accounts; tracked-only channels show the last synced follower count. Prices are edited on the staff portal under Campaigns → Rate cards and show here within a minute.</p>
    </>
  );
}
