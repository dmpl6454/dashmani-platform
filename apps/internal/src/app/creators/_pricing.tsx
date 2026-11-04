"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useCreatorPricing, type CreatorPricedPage } from "@/lib/hooks/use-creators";
import { creatorClientPricePaise } from "@dashmani/shared/src/validators/creator";
import { BTN_GOLD, CARD, INPUT, ErrorBar, Pill, compact, fmtWhen, rupees } from "../campaigns/_ds";

// Creator page prices (owner decision 2026-11-04): the CREATOR sets their own price per format on
// creators.digitalsukoon.com — that is their payout. Staff add OUR MARGIN as a percentage on top:
// client price = creator price + margin %, rounded up to a whole rupee (the same shared function
// the API uses, so the preview here is exactly what clients are charged). Brand and
// entertainment campaigns each have their own margin; the reel song add-on is a fixed charge that
// is paid to the creator in full (no margin on it — owner, 2026-11-04).
// Inputs are kept as typed text until Save (no reformatting under the cursor).

type Field = "marginBps" | "entertainmentMarginBps" | "audioAddonPaise";
const FORMAT_LABEL: Record<string, string> = { reel: "Reel", post: "Post", carousel: "Carousel" };

const pctText = (bps: number | null) => (bps == null ? "" : String(bps / 100));
const rupeeText = (p: number | null) => (p == null ? "" : String(p / 100));
/** "25" → 2500 bps; "" → null; NaN → undefined (invalid). */
function parsePct(raw: string): number | null | undefined {
  const t = raw.trim().replace(/%$/, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n * 100) : undefined;
}

function PageCard({ page, creatorId, onSaved }: { page: CreatorPricedPage; creatorId: string; onSaved: (pages: CreatorPricedPage[]) => void }) {
  const [vals, setVals] = useState(() =>
    Object.fromEntries(page.formats.map((f) => [f.format, {
      marginBps: pctText(f.marginBps),
      entertainmentMarginBps: pctText(f.entertainmentMarginBps),
      audioAddonPaise: rupeeText(f.audioAddonPaise),
      active: f.active,
    }])) as Record<string, Record<Field, string> & { active: boolean }>,
  );
  const [category, setCategory] = useState(page.category ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  const set = (format: string, patch: Partial<Record<Field, string> & { active: boolean }>) => {
    setSaved(false);
    setVals((prev) => ({ ...prev, [format]: { ...prev[format], ...patch } }));
  };

  const save = async () => {
    setErr("");
    setSaved(false);
    const cards: Array<Record<string, unknown>> = [];
    for (const f of page.formats) {
      const v = vals[f.format];
      const m = parsePct(v.marginBps);
      const em = parsePct(v.entertainmentMarginBps);
      if (m === undefined || em === undefined) return setErr(`Check the ${FORMAT_LABEL[f.format]} margin — a percentage from 0 to 1000.`);
      let audio: number | null = null;
      if (f.format === "reel" && v.audioAddonPaise.trim() !== "") {
        const r = Number(v.audioAddonPaise.replace(/[,₹\s]/g, ""));
        if (!Number.isFinite(r) || r < 1) return setErr("Check the reel song add-on.");
        audio = Math.round(r * 100);
      }
      if (m == null && (em != null || audio != null)) return setErr(`Set the ${FORMAT_LABEL[f.format]} brand margin first — it's what lists the format.`);
      const touched = m != null || f.marginBps != null || f.entertainmentMarginBps != null || f.audioAddonPaise != null || v.active !== f.active;
      if (!touched) continue;
      cards.push({
        assetId: page.assetId, format: f.format, marginBps: m, entertainmentMarginBps: em,
        ...(f.format === "reel" ? { audioAddonPaise: audio } : {}),
        active: v.active, category: category.trim() || null,
      });
    }
    if (cards.length === 0) return setErr("Nothing to save — enter a margin for at least one format.");
    setBusy(true);
    try {
      const r = await apiFetch<{ data: { pages: CreatorPricedPage[] } }>(`/admin/creators/${creatorId}/pricing`, { method: "PUT", body: JSON.stringify({ cards }) });
      onSaved(r.data.pages);
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "That didn't save.");
    } finally {
      setBusy(false);
    }
  };

  /** Live preview of the client price from what is typed now. */
  const preview = (creatorPrice: number | null, raw: string) => {
    const bps = parsePct(raw);
    if (creatorPrice == null || bps == null) return "—";
    return rupees(creatorClientPricePaise(creatorPrice, bps));
  };

  return (
    <div className="px-5 py-4 border-t border-[#132430]">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="font-semibold text-ds-text">{page.name}</span>
        <span className="text-[12px] text-ds-t3">{page.username ? `@${page.username} · ` : ""}{page.platform === "instagram" ? "Instagram" : "Facebook Page"} · {compact(page.followers)} followers</span>
        <span className="flex-1" />
        {page.listed ? (
          <Pill label="Listed to clients" color="#00D7A0" />
        ) : (
          <Pill label={page.disconnected ? "Disconnected" : !page.enabled ? "Page off — not listed" : "Not priced — not listed"} color="#738395" />
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px] min-w-[860px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[.06em] text-ds-t3">
              <th className="py-1.5 pr-3 font-semibold">Format</th>
              <th className="py-1.5 pr-3 font-semibold" title="Set by the creator — this is what we pay them per post">Creator price</th>
              <th className="py-1.5 pr-3 font-semibold">Brand margin %</th>
              <th className="py-1.5 pr-3 font-semibold">Client pays</th>
              <th className="py-1.5 pr-3 font-semibold" title="Empty = not offered for film / OTT / music campaigns">Ent. margin %</th>
              <th className="py-1.5 pr-3 font-semibold">Client pays (ent.)</th>
              <th className="py-1.5 pr-3 font-semibold" title="Reels only, a fixed charge on top — paid to the creator in full, no margin. Empty = no song.">Song add-on ₹ (to creator)</th>
              <th className="py-1.5 pr-3 font-semibold">On</th>
            </tr>
          </thead>
          <tbody>
            {page.formats.map((f) => {
              const v = vals[f.format];
              return (
                <tr key={f.format} className="align-middle">
                  <td className="py-1.5 pr-3 text-ds-t2">{FORMAT_LABEL[f.format] ?? f.format}</td>
                  <td className="py-1.5 pr-3 tabular-nums">
                    {f.creatorPricePaise != null ? (
                      <span title={f.creatorUpdatedAt ? `Set by the creator ${fmtWhen(f.creatorUpdatedAt)}` : undefined}>{rupees(f.creatorPricePaise)}</span>
                    ) : (
                      <span className="text-ds-t4">not set by creator</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 w-[110px]">
                    <input inputMode="decimal" className={`${INPUT} h-9`} value={v.marginBps} placeholder="—" aria-label={`${FORMAT_LABEL[f.format]} brand margin percent`} onChange={(e) => set(f.format, { marginBps: e.target.value })} />
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums text-ds-text">{preview(f.creatorPricePaise, v.marginBps)}</td>
                  <td className="py-1.5 pr-3 w-[110px]">
                    <input inputMode="decimal" className={`${INPUT} h-9`} value={v.entertainmentMarginBps} placeholder="—" aria-label={`${FORMAT_LABEL[f.format]} entertainment margin percent`} onChange={(e) => set(f.format, { entertainmentMarginBps: e.target.value })} />
                  </td>
                  <td className="py-1.5 pr-3 tabular-nums text-ds-text">{preview(f.creatorPricePaise, v.entertainmentMarginBps)}</td>
                  <td className="py-1.5 pr-3 w-[120px]">
                    {f.format === "reel" ? (
                      <input inputMode="decimal" className={`${INPUT} h-9`} value={v.audioAddonPaise} placeholder="—" aria-label="Reel song add-on" onChange={(e) => set(f.format, { audioAddonPaise: e.target.value })} />
                    ) : (
                      <span className="text-ds-t4">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">
                    <input type="checkbox" className="h-4 w-4 accent-[#E9BD62]" checked={v.active} onChange={(e) => set(f.format, { active: e.target.checked })} aria-label={`${FORMAT_LABEL[f.format]} listed`} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block w-[220px]">
          <span className="block text-[11.5px] text-ds-t3 mb-1">Category shown to clients</span>
          <input className={`${INPUT} h-9`} value={category} maxLength={60} onChange={(e) => { setSaved(false); setCategory(e.target.value); }} placeholder="e.g. Food" />
        </label>
        <button type="button" className={BTN_GOLD} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save margins"}</button>
        {saved && <span role="status" className="text-[12px] text-ds-teal">Saved.</span>}
      </div>
      {err && <div className="mt-2"><ErrorBar message={err} onClose={() => setErr("")} /></div>}
    </div>
  );
}

export function CreatorPricing({ creatorId, creatorApproved }: { creatorId: string; creatorApproved: boolean }) {
  const { data, error, mutate } = useCreatorPricing(creatorId);
  return (
    <section className={`${CARD} overflow-hidden mt-4`}>
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-[15px] font-semibold text-ds-text">Prices</h2>
        <p className="mt-1 text-[12.5px] text-ds-t3">
          The creator sets their own price per format — that is their payout, paid by hand after the post is live. You add our margin as a percentage on top
          (the reel song add-on carries no margin: it is added to the creator&apos;s payout in full);
          the client pays the creator&apos;s price + margin (rounded up to the rupee, + GST). A format is listed {creatorApproved ? "" : "once the creator is approved, "}when the page is on,
          the creator has set a price and you have set a brand margin. If the creator changes their price, the client price for new bookings follows;
          posts already booked keep the price and payout they were booked at. The creator never sees the margin or the client price.
        </p>
      </div>
      {error && !data && <div className="px-5 pb-4"><ErrorBar message={error.message || "Couldn't load the prices."} /></div>}
      {!data && !error && <div className="px-5 pb-5 text-[13px] text-ds-t3">Loading…</div>}
      {data && data.length === 0 && <div className="px-5 pb-5 text-[13px] text-ds-t3 border-t border-[#132430] pt-4">No pages connected.</div>}
      {data?.map((p) => (
        <PageCard key={p.assetId} page={p} creatorId={creatorId} onSaved={(pages) => mutate(pages, { revalidate: false })} />
      ))}
    </section>
  );
}
