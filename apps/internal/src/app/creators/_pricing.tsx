"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { useCreatorPricing, type CreatorPricedPage } from "@/lib/hooks/use-creators";
import { BTN_GOLD, CARD, INPUT, ErrorBar, Pill, compact, rupees } from "../campaigns/_ds";

// Staff set, per creator page and format, what the CLIENT pays and what we PAY the creator
// (settled by hand). Prices are kept as typed text until Save and converted to paise only then,
// so typing never reformats the field under the cursor (the ₹5.00 bug on the sales portal).

type Field = "pricePaise" | "entertainmentPricePaise" | "audioAddonPaise" | "creatorPayoutPaise";
const FIELDS: Array<{ key: Field; label: string; hint: string }> = [
  { key: "pricePaise", label: "Client price", hint: "Brand campaigns. Empty = not offered." },
  { key: "entertainmentPricePaise", label: "Entertainment", hint: "Film / OTT / music. Empty = not offered." },
  { key: "audioAddonPaise", label: "Song add-on", hint: "Reels only. Empty = no song." },
  { key: "creatorPayoutPaise", label: "Creator payout", hint: "What we pay the creator per post." },
];
const FORMAT_LABEL: Record<string, string> = { reel: "Reel", post: "Post", carousel: "Carousel" };

const toText = (p: number | null | undefined) => (p == null ? "" : String(p / 100));

function PageCard({ page, creatorId, onSaved }: { page: CreatorPricedPage; creatorId: string; onSaved: (pages: CreatorPricedPage[]) => void }) {
  const initial = () => {
    const out: Record<string, Record<Field, string>> = {};
    for (const f of page.formats) {
      const c = page.cards.find((x) => x.format === f);
      out[f] = {
        pricePaise: toText(c?.pricePaise),
        entertainmentPricePaise: toText(c?.entertainmentPricePaise),
        audioAddonPaise: toText(c?.audioAddonPaise),
        creatorPayoutPaise: toText(c?.creatorPayoutPaise),
      };
    }
    return out;
  };
  const [vals, setVals] = useState(initial);
  const [category, setCategory] = useState(page.category ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setErr("");
    setSaved(false);
    const cards: Array<Record<string, unknown>> = [];
    for (const f of page.formats) {
      const row: Record<string, number | null> = {};
      for (const { key, label } of FIELDS) {
        if (key === "audioAddonPaise" && f !== "reel") continue;
        const raw = vals[f][key].trim();
        const r = raw === "" ? null : Number(raw.replace(/[,₹\s]/g, ""));
        if (r !== null && (!Number.isFinite(r) || r < 1)) return setErr(`Check the ${FORMAT_LABEL[f]} ${label.toLowerCase()}.`);
        row[key] = r === null ? null : Math.round(r * 100);
      }
      const had = page.cards.some((c) => c.format === f);
      if (row.pricePaise == null) {
        if (row.entertainmentPricePaise != null || row.audioAddonPaise != null || row.creatorPayoutPaise != null) {
          return setErr(`Set the ${FORMAT_LABEL[f]} client price first — it's what offers the format.`);
        }
        if (had) cards.push({ assetId: page.assetId, format: f, pricePaise: null });
        continue;
      }
      if (row.creatorPayoutPaise != null && (row.creatorPayoutPaise > row.pricePaise || (row.entertainmentPricePaise != null && row.creatorPayoutPaise > row.entertainmentPricePaise))) {
        return setErr(`The ${FORMAT_LABEL[f]} payout can't be more than what the client pays.`);
      }
      cards.push({ assetId: page.assetId, format: f, ...row, category: category.trim() || null });
    }
    if (cards.length === 0) return setErr("Nothing to save — enter a client price for at least one format.");
    setBusy(true);
    try {
      const r = await apiFetch<{ data: { pages: CreatorPricedPage[] } }>(`/admin/creators/${creatorId}/pricing`, {
        method: "PUT",
        body: JSON.stringify({ cards }),
      });
      onSaved(r.data.pages);
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "That didn't save.");
    } finally {
      setBusy(false);
    }
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
          <span title={page.disconnected ? "Disconnected" : !page.enabled ? "Turn the page on above to list it" : "Add a client price to list it"}>
            <Pill label={page.disconnected ? "Disconnected" : !page.enabled ? "Page off — not listed" : "Not priced — not listed"} color="#738395" />
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12.5px] min-w-[640px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[.06em] text-ds-t3">
              <th className="py-1.5 pr-3 font-semibold">Format</th>
              {FIELDS.map((f) => <th key={f.key} className="py-1.5 pr-3 font-semibold" title={f.hint}>{f.label} (₹)</th>)}
            </tr>
          </thead>
          <tbody>
            {page.formats.map((f) => (
              <tr key={f}>
                <td className="py-1.5 pr-3 text-ds-t2">{FORMAT_LABEL[f] ?? f}</td>
                {FIELDS.map(({ key, label }) => (
                  <td key={key} className="py-1.5 pr-3">
                    {key === "audioAddonPaise" && f !== "reel" ? (
                      <span className="text-ds-t4">—</span>
                    ) : (
                      <input
                        inputMode="decimal"
                        className={`${INPUT} h-9`}
                        value={vals[f][key]}
                        placeholder="—"
                        aria-label={`${FORMAT_LABEL[f]} ${label}`}
                        onChange={(e) => {
                          const v = e.target.value;
                          setSaved(false);
                          setVals((prev) => ({ ...prev, [f]: { ...prev[f], [key]: v } }));
                        }}
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block w-[220px]">
          <span className="block text-[11.5px] text-ds-t3 mb-1">Category shown to clients</span>
          <input className={`${INPUT} h-9`} value={category} maxLength={60} onChange={(e) => { setSaved(false); setCategory(e.target.value); }} placeholder="e.g. Food" />
        </label>
        <button type="button" className={BTN_GOLD} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save prices"}</button>
        {saved && <span role="status" className="text-[12px] text-ds-teal">Saved.</span>}
      </div>
      {page.cards.some((c) => c.creatorPayoutPaise != null) && (
        <p className="mt-2 text-[11.5px] text-ds-t4">
          Margin per post: {page.cards.map((c) => `${FORMAT_LABEL[c.format] ?? c.format} ${c.creatorPayoutPaise != null ? rupees(c.pricePaise - c.creatorPayoutPaise) : "—"}`).join(" · ")}
        </p>
      )}
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
          A page is listed in the client portal&apos;s campaign accounts beside our own pages once {creatorApproved ? "" : "the creator is approved, "}it is turned on and has a client price.
          Clients pay the client price (+ GST); the creator is paid the payout by hand after the post goes live. The creator never sees the client price,
          and accepts or declines each booked post before anything is posted.
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
