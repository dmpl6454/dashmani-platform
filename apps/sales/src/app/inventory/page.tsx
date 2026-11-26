"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Download, ExternalLink } from "lucide-react";
import { useInventory } from "@/lib/hooks";
import { downloadBlob } from "@/lib/api";
import { fmtCompact, fmtInr, todayIST } from "@/lib/format";
import { Empty, LoadError, Loading, PageHead, platformLabel, titleCase } from "@/components/sales-ui";
import type { InventoryChannel } from "@/lib/sales-types";

// Three views of one list. "Our network" is the client catalogue: exactly what clients see on the
// client portal under Campaigns — the API builds it from the same catalogue — bookable channels with
// an active price. "Partner network" is the external pages we buy posts on (Pinkvilla, Filmygyan…),
// with the owner sheet's prices; sales inventory only, never shown to clients. "All channels" adds
// every other connected or tracked account, without a price, so the sales team can still quote it at
// a negotiated price. Every view exports to CSV as filtered and sorted.

type View = "catalogue" | "partner" | "all";
type Sort = "followers" | "views" | "engagement" | "price";
const FORMAT_ORDER = ["post", "reel", "carousel", "story"];

function csvFor(rows: InventoryChannel[]): string {
  const active = (c: InventoryChannel) => c.offers.filter((o) => o.active);
  const formats = FORMAT_ORDER.filter((f) => rows.some((c) => active(c).some((o) => o.format === f)));
  const ent = formats.filter((f) => rows.some((c) => active(c).some((o) => o.format === f && o.entertainmentPricePaise != null)));
  const evt = formats.filter((f) => rows.some((c) => active(c).some((o) => o.format === f && o.eventPricePaise != null)));
  const audio = rows.some((c) => active(c).some((o) => o.audioAddonPaise != null));
  const head = [
    "Channel", "Handle", "Platform", "Category", "Network", "In client catalogue", "Followers", "Views 28d", "Engagement %",
    ...formats.map((f) => `${titleCase(f)} price (Rs)`),
    ...ent.map((f) => `${titleCase(f)} entertainment price (Rs)`),
    ...evt.map((f) => `${titleCase(f)} event price (Rs)`),
    ...(audio ? ["Audio add-on (Rs)"] : []),
    "Profile URL",
  ];
  const cell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rupees = (p: number | null | undefined) => (p == null ? "" : String(Math.round(p / 100)));
  const lines = rows.map((c) => {
    const offer = (f: string) => active(c).find((o) => o.format === f);
    return [
      c.name, c.handle ?? "", platformLabel(c.platform), c.category ?? "", c.source === "partner" ? "Partner" : "Our network", c.inCatalogue ? "yes" : "no", c.followers ?? "", c.views28d ?? "", c.engagementRatePct ?? "",
      ...formats.map((f) => rupees(offer(f)?.pricePaise)),
      ...ent.map((f) => rupees(offer(f)?.entertainmentPricePaise)),
      ...evt.map((f) => rupees(offer(f)?.eventPricePaise)),
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

  const scoped = useMemo(
    () => (data ?? []).filter((c) => (view === "all" ? true : view === "partner" ? c.source === "partner" : c.inCatalogue)),
    [data, view],
  );
  const platforms = useMemo(() => Array.from(new Set(scoped.map((c) => c.platform))).sort(), [scoped]);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const minPrice = (c: InventoryChannel) => {
      const prices = c.offers.filter((o) => o.active).flatMap((o) => [o.pricePaise, o.entertainmentPricePaise, o.eventPricePaise]).filter((p): p is number => p != null);
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

  // The price cell is a small grid with the SAME columns on every row (format, brand, then
  // entertainment / event / song only when some row in view has one), so amounts line up down
  // the page instead of wrapping as chips of different widths.
  const priceCols = useMemo(() => {
    const offers = rows.flatMap((c) => c.offers.filter((o) => o.active));
    const cols: Array<{ key: "brand" | "ent" | "event" | "song"; label: string }> = [{ key: "brand", label: "Brand" }];
    if (offers.some((o) => o.entertainmentPricePaise != null)) cols.push({ key: "ent", label: "Ent." });
    if (offers.some((o) => o.eventPricePaise != null)) cols.push({ key: "event", label: "Event" });
    if (offers.some((o) => o.audioAddonPaise != null)) cols.push({ key: "song", label: "Song +" });
    return cols;
  }, [rows]);
  const priceGrid = { gridTemplateColumns: `5.5rem repeat(${priceCols.length}, 6.5rem)` };

  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !data) return <Loading label="Loading the catalogue…" />;
  const listed = data.filter((c) => c.inCatalogue).length;
  const partners = data.filter((c) => c.source === "partner").length;
  const exportCsv = () => {
    const name = `inventory-${view === "catalogue" ? "our-network" : view === "partner" ? "partner-network" : "all-channels"}${platform === "all" ? "" : `-${platform}`}-${todayIST()}.csv`;
    downloadBlob(new Blob(["﻿" + csvFor(rows)], { type: "text/csv;charset=utf-8" }), name);
  };
  return (
    <>
      <PageHead kicker={`${listed} channels on our network · ${partners} partner pages · ${data.length} in all`} title="Inventory">
        <button type="button" className="btn btn-light" onClick={exportCsv} disabled={rows.length === 0}><Download size={14} /> Export CSV ({rows.length})</button>
        <Link href="/quotes/edit" className="btn">New quote</Link>
      </PageHead>
      <div className="card p-3 mb-4 flex flex-wrap gap-2 items-center">
        <div className="flex gap-1" role="tablist" aria-label="Inventory view">
          <button type="button" role="tab" aria-selected={view === "catalogue"} className={`btn btn-sm ${view === "catalogue" ? "" : "btn-ghost"}`} onClick={() => { setView("catalogue"); setPlatform("all"); }}>Our network ({listed})</button>
          <button type="button" role="tab" aria-selected={view === "partner"} className={`btn btn-sm ${view === "partner" ? "" : "btn-ghost"}`} onClick={() => { setView("partner"); setPlatform("all"); }}>Partner network ({partners})</button>
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
        <Empty title="No channels match." body={view === "catalogue" ? "Nothing in the client catalogue matches. Try another platform, clear the search, or switch to all channels." : view === "partner" && partners === 0 ? "No partner pages are loaded yet. They come from the owner's rate sheet (scripts/import-campaign-rate-cards.ts)." : "Try another platform or clear the search."} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left whitespace-nowrap">
              <tr className="border-b-2 border-border align-bottom">
                <th className="p-3 font-semibold">Channel</th>
                <th className="p-3 font-semibold">Platform</th>
                <th className="p-3 font-semibold text-right">Followers</th>
                <th className="p-3 font-semibold text-right">Views 28d</th>
                <th className="p-3 font-semibold text-right">Eng.</th>
                <th className="p-3 pl-6 font-semibold">
                  <div className="mb-1.5 text-ink-2">{view === "catalogue" ? "Client price" : view === "partner" ? "Price per post" : "Rate card"}</div>
                  <div className="grid gap-x-3 text-[10.5px] text-ink-4" style={priceGrid}>
                    <span>Format</span>
                    {priceCols.map((p) => <span key={p.key} className="text-right">{p.label}</span>)}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const offers = c.offers.filter((o) => o.active);
                return (
                  <tr key={`${c.targetType}:${c.targetId}`} className="border-b border-rule hover:bg-muted/60 align-top">
                    <td className="p-3 min-w-[240px] max-w-[320px]">
                      <div className="flex items-center gap-2.5 min-w-0">
                        {c.pictureUrl ? (
                          <img loading="lazy" decoding="async" src={c.pictureUrl} alt="" className="w-8 h-8 rounded-full shrink-0 object-cover" />
                        ) : (
                          <span className="w-8 h-8 rounded-full bg-muted shrink-0 grid place-items-center text-[12px] font-bold text-ink-3" aria-hidden>{c.name.trim().charAt(0).toUpperCase()}</span>
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-bold truncate" title={c.name}>{c.name}</span>
                            {c.profileUrl && <a href={c.profileUrl} target="_blank" rel="noreferrer" className="shrink-0 text-ink-3 hover:text-white" aria-label={`Open ${c.name} profile`}><ExternalLink size={12} /></a>}
                          </div>
                          <div className="text-xs text-ink-3 truncate">{c.handle ? `@${c.handle}` : ""}{c.category ? ` · ${c.category}` : ""}{c.source === "partner" ? " · partner page, not offered to clients" : !c.inCatalogue ? (c.bookable ? " · not in client catalogue" : " · tracked only") : ""}</div>
                        </div>
                      </div>
                    </td>
                    <td className="p-3 whitespace-nowrap leading-8">{platformLabel(c.platform)}</td>
                    <td className="p-3 text-right font-mono tabular-nums leading-8">{fmtCompact(c.followers)}</td>
                    <td className="p-3 text-right font-mono tabular-nums leading-8">{fmtCompact(c.views28d)}</td>
                    <td className="p-3 text-right font-mono tabular-nums leading-8">{c.engagementRatePct == null ? "—" : `${c.engagementRatePct}%`}</td>
                    <td className="p-3 pl-6">
                      {offers.length === 0 ? <span className="text-ink-4 leading-8">{c.offers.length > 0 ? "price withdrawn" : "no price set"}</span> : (
                        <div className="space-y-1 py-1">
                          {[...offers].sort((a, b) => FORMAT_ORDER.indexOf(a.format) - FORMAT_ORDER.indexOf(b.format)).map((o) => {
                            const value = (k: "brand" | "ent" | "event" | "song") =>
                              k === "brand" ? o.pricePaise : k === "ent" ? o.entertainmentPricePaise : k === "event" ? o.eventPricePaise : o.audioAddonPaise;
                            return (
                              <div key={o.rateCardId ?? o.format} className="grid gap-x-3 items-baseline whitespace-nowrap text-[13px]" style={priceGrid}>
                                <span className="text-ink-2">{titleCase(o.format)}</span>
                                {priceCols.map((p) => {
                                  const v = value(p.key);
                                  return (
                                    <span key={p.key} className={`text-right font-mono tabular-nums ${p.key === "brand" ? "text-ink font-semibold" : "text-ink-3"}`}>
                                      {v == null ? <span className="text-ink-4">—</span> : fmtInr(v, { whole: true })}
                                    </span>
                                  );
                                })}
                              </div>
                            );
                          })}
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
      <p className="text-xs text-ink-4 mt-3">Our network is the client catalogue: what clients see on the client portal under Campaigns, served from the same list. Partner pages are external pages we buy posts on; they are never offered to clients, and their followers and prices are the ones on the owner's rate sheet. Followers and 28-day views come from Meta for connected Pages and accounts; tracked-only channels show the last synced follower count. Prices are edited on the staff portal under Campaigns → Rate cards and show here within a minute.</p>
    </>
  );
}
