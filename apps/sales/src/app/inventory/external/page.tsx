"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, Pencil, Plus } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useExternalPages, useVendors } from "@/lib/hooks";
import { fmtCompact, fmtInr } from "@/lib/format";
import { Empty, Field, LoadError, Loading, MoneyInput, PageHead, platformLabel, Toast } from "@/components/sales-ui";
import { Modal } from "@/components/ui";
import type { ExternalPage, Vendor } from "@/lib/sales-types";

// External pages and the vendors who sell them (owner, 2026-11-18): "Vendor adding — meme vendors
// Archit, Amit, Arif for Facebook pages; cricket vendor Mahesh", "Individual meme pages", "Inventory
// adding options category wise". Every page we buy posts on but do not own — the partner network
// and each vendor's pages — with its category and per-post prices. They show in Inventory (External
// pages) and can be quoted and attached to a Pipeline campaign; clients never see them.

const PLATFORMS = ["instagram", "facebook", "youtube", "x", "snapchat", "other"] as const;
const PRESET_CATEGORIES = ["Bollywood", "Meme", "Cricket", "Sports", "News", "Comedy", "Lifestyle", "Fashion", "Food", "Travel", "Regional", "Music"];

type PageForm = {
  id?: string; vendorId: string; platform: string; handle: string; name: string; profileUrl: string; followers: string; category: string;
  brandPaise: number; entertainmentPaise: number; eventPaise: number; audioPaise: number; notes: string; active: boolean;
};
const emptyPage = (vendorId = ""): PageForm => ({ vendorId, platform: "instagram", handle: "", name: "", profileUrl: "", followers: "", category: "", brandPaise: 0, entertainmentPaise: 0, eventPaise: 0, audioPaise: 0, notes: "", active: true });
type VendorForm = { id?: string; name: string; phone: string; email: string; notes: string; active: boolean };

const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong — try again");

export default function ExternalPagesPage() {
  const pages = useExternalPages();
  const vendors = useVendors();
  const [vendorFilter, setVendorFilter] = useState("all");
  const [category, setCategory] = useState("all");
  const [q, setQ] = useState("");
  const [pageForm, setPageForm] = useState<PageForm | null>(null);
  const [vendorForm, setVendorForm] = useState<VendorForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const categories = useMemo(() => Array.from(new Set((pages.data ?? []).map((p) => p.category).filter((c): c is string => !!c))).sort(), [pages.data]);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (pages.data ?? [])
      .filter((p) => vendorFilter === "all" || (vendorFilter === "none" ? !p.vendorId : p.vendorId === vendorFilter))
      .filter((p) => category === "all" || (p.category ?? "") === category)
      .filter((p) => !term || p.name.toLowerCase().includes(term) || (p.handle ?? "").includes(term));
  }, [pages.data, vendorFilter, category, q]);

  if (pages.error) return <LoadError error={pages.error} retry={() => pages.mutate()} />;
  if (vendors.error) return <LoadError error={vendors.error} retry={() => vendors.mutate()} />;
  if (!pages.data || !vendors.data) return <Loading label="Loading external pages…" />;

  const savePage = async () => {
    if (!pageForm || busy) return;
    setBusy(true); setErr(null);
    const body = {
      vendorId: pageForm.vendorId || null, platform: pageForm.platform, handle: pageForm.handle || null, name: pageForm.name,
      profileUrl: pageForm.profileUrl || null, followers: pageForm.followers.trim() ? Math.round(Number(pageForm.followers.replace(/[, ]/g, ""))) : null,
      category: pageForm.category || null, brandPaise: pageForm.brandPaise || null, entertainmentPaise: pageForm.entertainmentPaise || null,
      eventPaise: pageForm.eventPaise || null, audioPaise: pageForm.audioPaise || null, notes: pageForm.notes, active: pageForm.active,
    };
    if (body.followers != null && !Number.isFinite(body.followers)) { setErr("Followers must be a number"); setBusy(false); return; }
    try {
      await apiFetch(pageForm.id ? `/sales/external-pages/${pageForm.id}` : "/sales/external-pages", { method: pageForm.id ? "PUT" : "POST", body: JSON.stringify(body) });
      setToast(pageForm.id ? "Page saved" : `${body.name} added`);
      setPageForm(null);
      await Promise.all([pages.mutate(), vendors.mutate()]);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const saveVendor = async () => {
    if (!vendorForm || busy) return;
    setBusy(true); setErr(null);
    try {
      await apiFetch(vendorForm.id ? `/sales/vendors/${vendorForm.id}` : "/sales/vendors", {
        method: vendorForm.id ? "PUT" : "POST",
        body: JSON.stringify({ name: vendorForm.name, phone: vendorForm.phone || null, email: vendorForm.email || null, notes: vendorForm.notes, active: vendorForm.active }),
      });
      setToast(vendorForm.id ? "Vendor saved" : `${vendorForm.name} added`);
      setVendorForm(null);
      await Promise.all([vendors.mutate(), pages.mutate()]);
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  };
  const editPage = (p: ExternalPage) => setPageForm({
    id: p.id, vendorId: p.vendorId ?? "", platform: p.platform, handle: p.handle ?? "", name: p.name, profileUrl: p.profileUrl ?? "",
    followers: p.followers == null ? "" : String(p.followers), category: p.category ?? "", brandPaise: p.brandPaise ?? 0,
    entertainmentPaise: p.entertainmentPaise ?? 0, eventPaise: p.eventPaise ?? 0, audioPaise: p.audioPaise ?? 0, notes: p.notes, active: p.active,
  });
  const editVendor = (v: Vendor) => setVendorForm({ id: v.id, name: v.name, phone: v.phone ?? "", email: v.email ?? "", notes: v.notes, active: v.active });
  const active = pages.data.filter((p) => p.active).length;

  return (
    <>
      <PageHead kicker={`${active} external page${active === 1 ? "" : "s"} offered · ${vendors.data.filter((v) => v.active).length} vendor${vendors.data.filter((v) => v.active).length === 1 ? "" : "s"}`} title="External pages & vendors">
        <Link href="/inventory" className="btn btn-light">Back to inventory</Link>
        <button type="button" className="btn btn-light" onClick={() => { setErr(null); setVendorForm({ name: "", phone: "", email: "", notes: "", active: true }); }}><Plus size={14} /> Vendor</button>
        <button type="button" className="btn" onClick={() => { setErr(null); setPageForm(emptyPage(vendorFilter !== "all" && vendorFilter !== "none" ? vendorFilter : "")); }}><Plus size={14} /> Page</button>
      </PageHead>

      <section aria-label="Vendors" className="mb-6">
        <h2 className="text-[11px] uppercase tracking-[0.12em] text-ink-3 mb-2">Vendors</h2>
        {vendors.data.length === 0 ? (
          <p className="text-sm text-ink-3">No vendors yet. Add one, then add the pages they sell (a page can also have no vendor, like the partner network).</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {vendors.data.map((v) => (
              <div key={v.id} className={`card px-3 py-2 flex items-center gap-3 ${v.active ? "" : "opacity-60"}`}>
                <button type="button" className="text-left" onClick={() => setVendorFilter(v.id)} aria-pressed={vendorFilter === v.id}>
                  <span className="block font-bold text-sm">{v.name}{!v.active && <span className="text-ink-4 font-normal"> · off</span>}</span>
                  <span className="block text-xs text-ink-3">{v.pageCount} page{v.pageCount === 1 ? "" : "s"}{v.phone ? ` · ${v.phone}` : ""}</span>
                </button>
                <button type="button" className="text-ink-3 hover:text-white" aria-label={`Edit ${v.name}`} onClick={() => { setErr(null); editVendor(v); }}><Pencil size={13} /></button>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="card p-3 mb-4 flex flex-wrap gap-2 items-center">
        <input className="input flex-1 min-w-[180px]" placeholder="Search name or handle" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-auto" value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} aria-label="Vendor">
          <option value="all">All vendors</option>
          <option value="none">No vendor (partner network)</option>
          {vendors.data.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="all">All categories</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {rows.length === 0 ? (
        <Empty title={pages.data.length === 0 ? "No external pages yet." : "No pages match."} body={pages.data.length === 0 ? "Add the pages you buy posts on, with their category and price per post." : "Try another vendor or category, or clear the search."} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left">
              <tr className="border-b-2 border-border">
                <th className="p-3">Page</th><th className="p-3">Category</th><th className="p-3">Vendor</th><th className="p-3 text-right">Followers</th><th className="p-3">Price per post</th><th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className={`border-b border-rule ${p.active ? "" : "opacity-60"}`}>
                  <td className="p-3 min-w-[200px]">
                    <div className="font-bold">{p.name} {p.profileUrl && <a href={p.profileUrl} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-white inline-block align-middle" aria-label="Open page"><ExternalLink size={12} /></a>}</div>
                    <div className="text-xs text-ink-3">{platformLabel(p.platform)}{p.handle ? ` · @${p.handle}` : ""}{!p.active && " · switched off"}</div>
                  </td>
                  <td className="p-3">{p.category ?? <span className="text-ink-4">—</span>}</td>
                  <td className="p-3">{p.vendor?.name ?? <span className="text-ink-4">—</span>}</td>
                  <td className="p-3 text-right font-mono">{fmtCompact(p.followers)}</td>
                  <td className="p-3 text-xs">
                    {[["Brand", p.brandPaise], ["Ent", p.entertainmentPaise], ["Event", p.eventPaise], ["Song +", p.audioPaise]]
                      .filter(([, v]) => v != null)
                      .map(([k, v]) => <span key={k as string} className="inline-block mr-2 whitespace-nowrap"><span className="text-ink-3">{k}</span> <span className="font-mono">{fmtInr(v as number, { whole: true })}</span></span>)}
                    {p.brandPaise == null && p.entertainmentPaise == null && p.eventPaise == null && <span className="text-ink-4">no price</span>}
                  </td>
                  <td className="p-3 text-right"><button type="button" className="btn btn-ghost btn-sm" onClick={() => { setErr(null); editPage(p); }}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pageForm && (
        <Modal title={pageForm.id ? "Edit page" : "Add a page"} onClose={() => setPageForm(null)}>
          <form className="grid grid-cols-1 gap-3" onSubmit={(e) => { e.preventDefault(); void savePage(); }}>
            <Field label="Page name"><input className="input" required maxLength={120} value={pageForm.name} onChange={(e) => setPageForm({ ...pageForm, name: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Platform">
                <select className="input" value={pageForm.platform} onChange={(e) => setPageForm({ ...pageForm, platform: e.target.value })}>
                  {PLATFORMS.map((p) => <option key={p} value={p}>{p === "other" ? "Other" : platformLabel(p)}</option>)}
                </select>
              </Field>
              <Field label="Handle" hint="Optional if you paste the link"><input className="input" placeholder="@memepage" value={pageForm.handle} onChange={(e) => setPageForm({ ...pageForm, handle: e.target.value })} /></Field>
            </div>
            <Field label="Link"><input className="input" type="url" placeholder="https://…" value={pageForm.profileUrl} onChange={(e) => setPageForm({ ...pageForm, profileUrl: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Category">
                <input className="input" list="ext-categories" maxLength={60} placeholder="Meme" value={pageForm.category} onChange={(e) => setPageForm({ ...pageForm, category: e.target.value })} />
                <datalist id="ext-categories">{Array.from(new Set([...categories, ...PRESET_CATEGORIES])).map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label="Followers"><input className="input text-right font-mono" inputMode="numeric" value={pageForm.followers} onChange={(e) => setPageForm({ ...pageForm, followers: e.target.value })} /></Field>
            </div>
            <Field label="Vendor">
              <select className="input" value={pageForm.vendorId} onChange={(e) => setPageForm({ ...pageForm, vendorId: e.target.value })}>
                <option value="">No vendor (partner network)</option>
                {vendors.data.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </Field>
            <p className="text-xs text-ink-3 -mb-1">Price per post (₹). Leave a type empty if the page doesn&apos;t take it.</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Brand"><MoneyInput paise={pageForm.brandPaise} onChange={(v) => setPageForm({ ...pageForm, brandPaise: v })} /></Field>
              <Field label="Entertainment"><MoneyInput paise={pageForm.entertainmentPaise} onChange={(v) => setPageForm({ ...pageForm, entertainmentPaise: v })} /></Field>
              <Field label="Event"><MoneyInput paise={pageForm.eventPaise} onChange={(v) => setPageForm({ ...pageForm, eventPaise: v })} /></Field>
              <Field label="Song add-on (reel)"><MoneyInput paise={pageForm.audioPaise} onChange={(v) => setPageForm({ ...pageForm, audioPaise: v })} /></Field>
            </div>
            <Field label="Notes"><textarea className="input min-h-[60px]" maxLength={2000} value={pageForm.notes} onChange={(e) => setPageForm({ ...pageForm, notes: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pageForm.active} onChange={(e) => setPageForm({ ...pageForm, active: e.target.checked })} /> Offered (listed in Inventory)</label>
            {err && <p role="alert" className="text-sm text-danger">{err}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => setPageForm(null)}>Cancel</button>
              <button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : "Save page"}</button>
            </div>
          </form>
        </Modal>
      )}

      {vendorForm && (
        <Modal title={vendorForm.id ? "Edit vendor" : "Add a vendor"} onClose={() => setVendorForm(null)}>
          <form className="grid grid-cols-1 gap-3" onSubmit={(e) => { e.preventDefault(); void saveVendor(); }}>
            <Field label="Name"><input className="input" required maxLength={120} value={vendorForm.name} onChange={(e) => setVendorForm({ ...vendorForm, name: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Phone"><input className="input" maxLength={30} value={vendorForm.phone} onChange={(e) => setVendorForm({ ...vendorForm, phone: e.target.value })} /></Field>
              <Field label="Email"><input className="input" type="email" maxLength={200} value={vendorForm.email} onChange={(e) => setVendorForm({ ...vendorForm, email: e.target.value })} /></Field>
            </div>
            <Field label="Notes" hint="What they sell, how they're paid…"><textarea className="input min-h-[60px]" maxLength={2000} value={vendorForm.notes} onChange={(e) => setVendorForm({ ...vendorForm, notes: e.target.value })} /></Field>
            {vendorForm.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={vendorForm.active} onChange={(e) => setVendorForm({ ...vendorForm, active: e.target.checked })} /> Active</label>}
            {err && <p role="alert" className="text-sm text-danger">{err}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => setVendorForm(null)}>Cancel</button>
              <button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : "Save vendor"}</button>
            </div>
          </form>
        </Modal>
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </>
  );
}
