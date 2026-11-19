"use client";
/**
 * A campaign's plan on the project page (sales portal only; owner, 2026-11-18):
 *  - Revenue: what the campaign is worth and how it is paid — GST (invoiced from the billing
 *    portal) or cash. Cash is an internal record only: it is not an invoice, so it never reaches
 *    GST returns, Tally or the client.
 *  - Pages: the pages planned for the campaign, picked from the inventory (our network + external
 *    pages) category by category, kept as they were when added, and downloadable as a CSV.
 * Both come from /v1/sales/pipeline/:id/… behind the sales permission — never from the Pipeline
 * routes, which every HR user can read.
 */
import { useMemo, useState } from "react";
import { Download, ExternalLink, Plus, Trash2, X } from "lucide-react";
import { apiFetch, downloadBlob } from "@/lib/api";
import { useCampaignPlan, useInventory } from "@/lib/hooks";
import { fmtCompact, fmtInr, toPaise, todayIST } from "@/lib/format";
import type { CampaignPage, CampaignPlan, InventoryChannel } from "@/lib/sales-types";

const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong — try again");
const PLATFORM: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube", snapchat: "Snapchat", x: "X", other: "Other" };
const keyOf = (c: InventoryChannel) => `${c.targetType}:${c.targetId}`;
const lowest = (c: InventoryChannel, k: "pricePaise" | "entertainmentPricePaise" | "eventPricePaise") => {
  const v = c.offers.filter((o) => o.active).map((o) => o[k]).filter((p): p is number => p != null);
  return v.length ? Math.min(...v) : null;
};

function pagesCsv(title: string, pages: CampaignPage[]): string {
  const cell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rupees = (p: number | null) => (p == null ? "" : String(Math.round(p / 100)));
  const head = ["Category", "Page", "Handle", "Platform", "Network", "Vendor", "Followers", "Brand price (Rs)", "Entertainment price (Rs)", "Event price (Rs)", "Link"];
  const lines = pages.map((p) =>
    [p.category ?? "", p.name, p.handle ? `${p.handle}` : "", PLATFORM[p.platform] ?? p.platform, p.source === "external" ? "External" : "Our network", p.vendorName ?? "", p.followers ?? "", rupees(p.brandPaise), rupees(p.entertainmentPaise), rupees(p.eventPaise), p.profileUrl ?? ""]
      .map(cell)
      .join(","),
  );
  return [`${cell(`Campaign: ${title}`)}`, head.map(cell).join(","), ...lines].join("\r\n") + "\r\n";
}

export function CampaignPlanPanel({ projectId, title, readOnly }: { projectId: string; title: string; readOnly: boolean }) {
  const { data, error, mutate } = useCampaignPlan(projectId);
  const [picking, setPicking] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (error) {
    return (
      <section aria-label="Campaign plan" className="px-4 pb-4 text-[13px]">
        <p className="text-ink-3">Couldn&apos;t load the campaign&apos;s revenue and pages.</p>
        <button type="button" onClick={() => void mutate()} className="mt-1 h-9 px-3 rounded-lg text-[12.5px] font-semibold text-ink-2 hover:bg-muted">Try again</button>
      </section>
    );
  }
  if (!data) return <section aria-label="Campaign plan" className="px-4 pb-4 text-[13px] text-ink-3">Loading revenue and pages…</section>;

  const remove = async (p: CampaignPage) => {
    setMsg(null);
    try {
      const r = await apiFetch<{ pages: CampaignPage[] }>(`/sales/pipeline/${projectId}/pages/${p.id}`, { method: "DELETE" });
      await mutate({ ...data, pages: r.data.pages }, { revalidate: false });
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const download = () => {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "campaign";
    downloadBlob(new Blob(["﻿" + pagesCsv(title, data.pages)], { type: "text/csv;charset=utf-8" }), `pages-${slug}-${todayIST()}.csv`);
  };
  const byCategory = new Map<string, CampaignPage[]>();
  for (const p of data.pages) byCategory.set(p.category ?? "", [...(byCategory.get(p.category ?? "") ?? []), p]);

  return (
    <section aria-label="Campaign plan" className="px-4 pb-4 space-y-4">
      <RevenueBlock projectId={projectId} plan={data} readOnly={readOnly} onSaved={(revenue) => void mutate({ ...data, revenue }, { revalidate: false })} />

      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] uppercase tracking-[0.12em] text-ink-3">Pages ({data.pages.length})</span>
          <span className="ml-auto flex items-center gap-1">
            {data.pages.length > 0 && (
              <button type="button" onClick={download} className="h-9 px-2.5 rounded-lg text-[12.5px] font-semibold text-ink-2 hover:bg-muted inline-flex items-center gap-1">
                <Download size={13} aria-hidden /> CSV
              </button>
            )}
            {!readOnly && (
              <button type="button" onClick={() => { setMsg(null); setPicking(true); }} className="h-9 px-2.5 rounded-lg text-[12.5px] font-semibold text-ink-2 hover:bg-muted inline-flex items-center gap-1">
                <Plus size={13} aria-hidden /> Add pages
              </button>
            )}
          </span>
        </div>
        {data.pages.length === 0 ? (
          <p className="text-[12.5px] text-ink-3">No pages planned yet. Add them from the inventory by category.</p>
        ) : (
          <div className="space-y-2">
            {Array.from(byCategory).map(([cat, list]) => (
              <div key={cat || "none"}>
                <p className="text-[12px] font-semibold text-ink-2">{cat || "No category"} · {list.length}</p>
                <ul className="divide-y divide-rule">
                  {list.map((p) => (
                    <li key={p.id} className="flex items-center gap-2 py-1.5 text-[12.5px] min-w-0">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-ink">
                          {p.name}
                          {p.profileUrl && (
                            <a href={p.profileUrl} target="_blank" rel="noreferrer" aria-label={`Open ${p.name}`} className="ml-1 inline-block align-middle text-ink-3 hover:text-ink"><ExternalLink size={11} /></a>
                          )}
                        </span>
                        <span className="block truncate text-ink-3">
                          {PLATFORM[p.platform] ?? p.platform} · {fmtCompact(p.followers)}
                          {p.vendorName ? ` · via ${p.vendorName}` : p.source === "external" ? " · external" : ""}
                          {p.brandPaise != null ? ` · ${fmtInr(p.brandPaise, { whole: true })}` : ""}
                        </span>
                      </span>
                      {!readOnly && (
                        <button type="button" onClick={() => void remove(p)} aria-label={`Remove ${p.name}`} className="h-8 w-8 grid place-items-center rounded-lg text-ink-3 hover:bg-muted shrink-0">
                          <Trash2 size={13} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="text-[11.5px] text-ink-4">Prices are the lowest per-post price when each page was added.</p>
          </div>
        )}
        {msg && <p role="alert" className="mt-1 text-[12.5px] text-danger">{msg}</p>}
      </div>

      {picking && (
        <PagePicker
          projectId={projectId}
          already={new Set(data.pages.map((p) => p.pageKey))}
          onClose={() => setPicking(false)}
          onAdded={(pages) => { void mutate({ ...data, pages }, { revalidate: false }); setPicking(false); }}
        />
      )}
    </section>
  );
}

function RevenueBlock({ projectId, plan, readOnly, onSaved }: { projectId: string; plan: CampaignPlan; readOnly: boolean; onSaved: (r: CampaignPlan["revenue"]) => void }) {
  const r = plan.revenue;
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<"gst" | "cash">("gst");
  const [received, setReceived] = useState("");
  const [receivedOn, setReceivedOn] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const open = () => {
    setAmount(r ? String(r.amountPaise / 100) : "");
    setMode(r?.paymentMode ?? "gst");
    setReceived(r && r.receivedPaise ? String(r.receivedPaise / 100) : "");
    setReceivedOn(r?.receivedOn ?? "");
    setNote(r?.note ?? "");
    setMsg(null);
    setEditing(true);
  };
  const save = async () => {
    const a = toPaise(amount);
    const rec = received.trim() ? toPaise(received) : 0;
    if (a == null || a < 0) return setMsg("Enter the campaign's value in rupees");
    if (rec == null) return setMsg("Enter the amount received in rupees");
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch<CampaignPlan["revenue"]>(`/sales/pipeline/${projectId}/revenue`, {
        method: "PUT",
        body: JSON.stringify({ amountPaise: a, paymentMode: mode, receivedPaise: rec, receivedOn: receivedOn || null, note }),
      });
      onSaved(res.data);
      setEditing(false);
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    try {
      await apiFetch(`/sales/pipeline/${projectId}/revenue`, { method: "DELETE" });
      onSaved(null);
      setEditing(false);
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <div className="text-[13px]">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-[0.12em] text-ink-3">Revenue</span>
          {!readOnly && (
            <button type="button" onClick={open} className="ml-auto h-9 px-3 rounded-lg text-[12.5px] font-semibold text-ink-2 hover:bg-muted">{r ? "Edit" : "Add revenue"}</button>
          )}
        </div>
        {r ? (
          <div className="mt-1 space-y-0.5">
            <p>
              <span className="font-mono font-bold text-ink">{fmtInr(r.amountPaise, { whole: true })}</span>{" "}
              <span className={`ml-1 px-1.5 py-0.5 text-[11px] font-semibold border ${r.paymentMode === "cash" ? "border-attention text-attention" : "border-border text-ink-2"}`}>
                {r.paymentMode === "cash" ? "Cash · no GST" : "GST invoice"}
              </span>
            </p>
            <p className="text-ink-3">
              Received {fmtInr(r.receivedPaise, { whole: true })}
              {r.receivedOn ? ` on ${r.receivedOn}` : ""} · due {fmtInr(Math.max(0, r.amountPaise - r.receivedPaise), { whole: true })}
            </p>
            {r.note && <p className="text-ink-3 whitespace-pre-line">{r.note}</p>}
            {r.paymentMode === "cash" && <p className="text-[11.5px] text-ink-4">Cash is an internal record only — not an invoice, not in GST returns.</p>}
          </div>
        ) : (
          <p className="mt-1 text-ink-3">Not recorded yet.</p>
        )}
      </div>
    );
  }
  return (
    <form className="space-y-2 text-[13px]" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <span className="text-[11px] uppercase tracking-[0.12em] text-ink-3">Revenue</span>
      <label className="block">
        <span className="block text-ink-3 text-[12px] mb-0.5">Campaign value (₹)</span>
        <input className="input w-full text-right font-mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      </label>
      <fieldset className="flex gap-3">
        <legend className="sr-only">Payment mode</legend>
        <label className="flex items-center gap-1.5"><input type="radio" name="pm" checked={mode === "gst"} onChange={() => setMode("gst")} /> GST invoice</label>
        <label className="flex items-center gap-1.5"><input type="radio" name="pm" checked={mode === "cash"} onChange={() => setMode("cash")} /> Cash (no GST)</label>
      </fieldset>
      {mode === "cash" && <p className="text-[11.5px] text-ink-4">Recorded here only. It is not an invoice and does not go into GST returns or Tally.</p>}
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="block text-ink-3 text-[12px] mb-0.5">Received (₹)</span>
          <input className="input w-full text-right font-mono" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} />
        </label>
        <label className="block">
          <span className="block text-ink-3 text-[12px] mb-0.5">On</span>
          <input className="input w-full" type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
        </label>
      </div>
      <label className="block">
        <span className="block text-ink-3 text-[12px] mb-0.5">Note</span>
        <textarea className="input w-full min-h-[50px]" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {msg && <p role="alert" className="text-[12.5px] text-danger">{msg}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className="h-10 px-4 rounded-xl bg-indigo text-white text-[13px] font-semibold disabled:opacity-60">{busy ? "Saving…" : "Save revenue"}</button>
        <button type="button" onClick={() => setEditing(false)} className="h-10 px-4 rounded-xl text-[13px] font-semibold text-ink-2 hover:bg-muted">Cancel</button>
        {r && <button type="button" disabled={busy} onClick={() => void clear()} className="ml-auto h-10 px-3 rounded-xl text-[13px] font-semibold text-ink-3 hover:bg-muted">Remove</button>}
      </div>
    </form>
  );
}

function PagePicker({ projectId, already, onClose, onAdded }: { projectId: string; already: Set<string>; onClose: () => void; onAdded: (pages: CampaignPage[]) => void }) {
  const { data, error, mutate } = useInventory();
  const [view, setView] = useState<"all" | "network" | "external">("all");
  const [category, setCategory] = useState("all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Only pages with a price are sold: our catalogue + offered external pages.
  const sellable = useMemo(() => (data ?? []).filter((c) => c.inCatalogue || c.source === "external"), [data]);
  const scoped = useMemo(() => sellable.filter((c) => view === "all" || c.source === view), [sellable, view]);
  const categories = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of scoped) n.set(c.category ?? "", (n.get(c.category ?? "") ?? 0) + 1);
    return Array.from(n).sort((a, b) => (a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0])));
  }, [scoped]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return scoped
      .filter((c) => category === "all" || (c.category ?? "") === category)
      .filter((c) => !t || c.name.toLowerCase().includes(t) || (c.handle ?? "").toLowerCase().includes(t) || (c.vendorName ?? "").toLowerCase().includes(t));
  }, [scoped, category, q]);
  const addable = rows.filter((c) => !already.has(keyOf(c)));
  const allPicked = addable.length > 0 && addable.every((c) => picked.has(keyOf(c)));

  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const toggleAll = () => setPicked((s) => { const n = new Set(s); for (const c of addable) { if (allPicked) n.delete(keyOf(c)); else n.add(keyOf(c)); } return n; });
  const add = async () => {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await apiFetch<{ added: number; pages: CampaignPage[] }>(`/sales/pipeline/${projectId}/pages`, { method: "POST", body: JSON.stringify({ pageKeys: Array.from(picked) }) });
      onAdded(r.data.pages);
    } catch (e) {
      setMsg(errText(e));
      void mutate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-3 bg-black/75" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Add pages" onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-surface border-2 border-white/30">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-rule">
          <h2 className="text-lg font-extrabold">Add pages</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto h-9 w-9 grid place-items-center text-ink-3 hover:text-ink"><X size={16} /></button>
        </div>
        <div className="px-4 py-3 flex flex-wrap gap-2 border-b border-rule">
          <select className="input w-auto" value={view} onChange={(e) => { setView(e.target.value as typeof view); setCategory("all"); }} aria-label="Network">
            <option value="all">All pages</option>
            <option value="network">Our network</option>
            <option value="external">External pages</option>
          </select>
          <select className="input w-auto max-w-[200px]" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
            <option value="all">All categories</option>
            {categories.map(([c, n]) => <option key={c || "none"} value={c}>{c || "No category"} ({n})</option>)}
          </select>
          <input className="input flex-1 min-w-[150px]" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {error ? (
            <div className="p-6 text-center text-sm"><p className="text-ink-2">Couldn&apos;t load the inventory.</p><button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => void mutate()}>Try again</button></div>
          ) : !data ? (
            <p className="p-6 text-center text-sm text-ink-3">Loading the inventory…</p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-ink-3">No pages match.</p>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left sticky top-0 bg-surface">
                <tr className="border-b border-rule">
                  <th className="p-2 w-8"><input type="checkbox" aria-label={allPicked ? "Unselect all shown" : "Select all shown"} checked={allPicked} disabled={addable.length === 0} onChange={toggleAll} /></th>
                  <th className="p-2">Page</th><th className="p-2 text-right">Followers</th><th className="p-2 text-right">From</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const k = keyOf(c);
                  const has = already.has(k);
                  const price = lowest(c, "pricePaise") ?? lowest(c, "entertainmentPricePaise") ?? lowest(c, "eventPricePaise");
                  return (
                    <tr key={k} className={`border-b border-rule ${has ? "opacity-50" : "hover:bg-muted/60 cursor-pointer"}`} onClick={() => !has && toggle(k)}>
                      <td className="p-2"><input type="checkbox" aria-label={`Select ${c.name}`} checked={has || picked.has(k)} disabled={has} onChange={() => toggle(k)} onClick={(e) => e.stopPropagation()} /></td>
                      <td className="p-2 min-w-0">
                        <span className="block font-semibold truncate max-w-[300px]">{c.name}{has && <span className="text-ink-4 font-normal"> · added</span>}</span>
                        <span className="block text-[11.5px] text-ink-3 truncate max-w-[300px]">{PLATFORM[c.platform] ?? c.platform}{c.category ? ` · ${c.category}` : ""}{c.vendorName ? ` · via ${c.vendorName}` : c.source === "external" ? " · external" : ""}</span>
                      </td>
                      <td className="p-2 text-right font-mono">{fmtCompact(c.followers)}</td>
                      <td className="p-2 text-right font-mono whitespace-nowrap">{price == null ? "—" : fmtInr(price, { whole: true })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="px-4 py-3 border-t border-rule flex items-center gap-2">
          {msg ? <p role="alert" className="text-[12.5px] text-danger flex-1">{msg}</p> : <p className="text-[12.5px] text-ink-3 flex-1">{picked.size} selected</p>}
          <button type="button" onClick={onClose} className="h-10 px-4 rounded-xl text-[13px] font-semibold text-ink-2 hover:bg-muted">Cancel</button>
          <button type="button" disabled={busy || picked.size === 0} onClick={() => void add()} className="h-10 px-4 rounded-xl bg-indigo text-white text-[13px] font-semibold disabled:opacity-60">
            {busy ? "Adding…" : `Add ${picked.size || ""} page${picked.size === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
