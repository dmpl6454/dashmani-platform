"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { useInventory } from "@/lib/hooks";
import { fmtCompact, fmtInr } from "@/lib/format";
import { Empty, LoadError, Loading, PageHead, platformLabel, titleCase } from "@/components/sales-ui";

// Every channel on every platform with its live numbers and the prices on its rate card.
// A channel without a price is still listed — the sales team can quote it at a negotiated price.

export default function InventoryPage() {
  const { data, error, isLoading, mutate } = useInventory();
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState("all");
  const [onlyPriced, setOnlyPriced] = useState(false);
  const [sort, setSort] = useState<"followers" | "views" | "engagement" | "price">("followers");

  const platforms = useMemo(() => Array.from(new Set((data ?? []).map((c) => c.platform))).sort(), [data]);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const minPrice = (c: { offers: Array<{ pricePaise: number; active: boolean }> }) => {
      const prices = c.offers.filter((o) => o.active).map((o) => o.pricePaise);
      return prices.length ? Math.min(...prices) : null;
    };
    return (data ?? [])
      .filter((c) => platform === "all" || c.platform === platform)
      .filter((c) => !onlyPriced || c.offers.some((o) => o.active))
      .filter((c) => !term || c.name.toLowerCase().includes(term) || (c.handle ?? "").toLowerCase().includes(term) || (c.category ?? "").toLowerCase().includes(term))
      .sort((a, b) => {
        if (sort === "views") return (b.views28d ?? -1) - (a.views28d ?? -1);
        if (sort === "engagement") return (b.engagementRatePct ?? -1) - (a.engagementRatePct ?? -1);
        if (sort === "price") return (minPrice(a) ?? Number.MAX_SAFE_INTEGER) - (minPrice(b) ?? Number.MAX_SAFE_INTEGER);
        return (b.followers ?? -1) - (a.followers ?? -1);
      });
  }, [data, q, platform, onlyPriced, sort]);

  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !data) return <Loading label="Listing every channel…" />;
  const priced = data.filter((c) => c.offers.some((o) => o.active)).length;
  return (
    <>
      <PageHead kicker={`${data.length} channels · ${priced} with a rate card`} title="Inventory">
        <Link href="/quotes/edit" className="btn">New quote</Link>
      </PageHead>
      <div className="card p-3 mb-4 flex flex-wrap gap-2 items-center">
        <input className="input flex-1 min-w-[200px]" placeholder="Search name, handle or category" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-auto" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="all">All platforms</option>
          {platforms.map((p) => <option key={p} value={p}>{platformLabel(p)}</option>)}
        </select>
        <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="followers">Most followers</option>
          <option value="views">Most views (28d)</option>
          <option value="engagement">Best engagement</option>
          <option value="price">Lowest price</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-ink-3 px-2"><input type="checkbox" checked={onlyPriced} onChange={(e) => setOnlyPriced(e.target.checked)} /> Priced only</label>
      </div>
      {rows.length === 0 ? <Empty title="No channels match." body="Try another platform or clear the search." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left">
              <tr className="border-b-2 border-border">
                <th className="p-3">Channel</th><th className="p-3">Platform</th><th className="p-3 text-right">Followers</th><th className="p-3 text-right">Views 28d</th><th className="p-3 text-right">Eng.</th><th className="p-3">Rate card</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={`${c.targetType}:${c.targetId}`} className="border-b border-rule hover:bg-muted/60">
                  <td className="p-3 min-w-[220px]">
                    <div className="flex items-center gap-2 min-w-0">
                      {c.pictureUrl ? <img src={c.pictureUrl} alt="" className="w-7 h-7 rounded-full shrink-0" /> : <span className="w-7 h-7 rounded-full bg-muted shrink-0" aria-hidden />}
                      <div className="min-w-0">
                        <div className="font-bold truncate">{c.name} {c.profileUrl && <a href={c.profileUrl} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-white inline-block align-middle" aria-label="Open profile"><ExternalLink size={12} /></a>}</div>
                        <div className="text-xs text-ink-3 truncate">{c.handle ? `@${c.handle}` : ""}{c.category ? ` · ${c.category}` : ""}{!c.bookable ? " · tracked only" : ""}</div>
                      </div>
                    </div>
                  </td>
                  <td className="p-3 whitespace-nowrap">{platformLabel(c.platform)}</td>
                  <td className="p-3 text-right font-mono">{fmtCompact(c.followers)}</td>
                  <td className="p-3 text-right font-mono">{fmtCompact(c.views28d)}</td>
                  <td className="p-3 text-right font-mono">{c.engagementRatePct == null ? "—" : `${c.engagementRatePct}%`}</td>
                  <td className="p-3">
                    {c.offers.filter((o) => o.active).length === 0 ? <span className="text-ink-4">no price set</span> : (
                      <div className="flex flex-wrap gap-1">
                        {c.offers.filter((o) => o.active).map((o) => (
                          <span key={o.rateCardId} className="border border-border px-1.5 py-0.5 text-xs whitespace-nowrap">{titleCase(o.format)} <span className="font-mono">{fmtInr(o.pricePaise, { whole: true })}</span>{o.entertainmentPricePaise != null && <span className="text-ink-3"> · ent {fmtInr(o.entertainmentPricePaise, { whole: true })}</span>}</span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-ink-4 mt-3">Followers and 28-day views come from Meta for connected Pages and accounts; tracked-only channels show the last synced follower count. Rate-card prices are edited on the staff portal under Campaigns → Rate cards.</p>
    </>
  );
}
