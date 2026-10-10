"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { ChevronLeft, Search } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { BTN_GOLD, CARD, INPUT, ErrorBar, PageHead, PlatformDot, compact } from "../_ds";

// Rate card: our price per account per format. Each format has a Brand price (required to
// offer the format at all), an Entertainment price (film / OTT / music campaigns; empty = not
// offered for those) and, on reels, a song-audio add-on (empty = not offered). Only accounts
// with at least one active price appear in the client catalogue.

type Target = {
  targetType: "meta_asset" | "social_account";
  targetId: string;
  platform: "instagram" | "facebook" | "youtube";
  name: string;
  username: string | null;
  followers: number | null;
  engagementRatePct: number | null;
  category: string | null;
  formats: string[];
  cards: Array<{ id: string; format: string; pricePaise: number; entertainmentPricePaise: number | null; audioAddonPaise: number | null; active: boolean }>;
};

const ALL_FORMATS = ["reel", "post", "carousel"] as const;
type Field = "pricePaise" | "entertainmentPricePaise" | "audioAddonPaise";
const FIELDS: Array<{ key: Field; short: string; label: string }> = [
  { key: "pricePaise", short: "Brand", label: "brand price" },
  { key: "entertainmentPricePaise", short: "Ent.", label: "entertainment price" },
  { key: "audioAddonPaise", short: "Audio", label: "song audio add-on" },
];
const fieldsFor = (f: string) => FIELDS.filter((x) => x.key !== "audioAddonPaise" || f === "reel");
const pk = (f: string, field: Field) => `${f}:${field}`;
const keyOf = (t: { targetType: string; targetId: string }) => `${t.targetType}:${t.targetId}`;

export default function RateCardsPage() {
  usePageTitle("Campaign rate card");
  const { data, error, mutate } = useSWR<Target[]>("/admin/campaign-rate-cards", (u: string) => apiFetch<{ data: Target[] }>(u).then((r) => r.data), { revalidateOnFocus: false });
  // Edits: key → { category?, prices: format → rupees string }
  const [edits, setEdits] = useState<Record<string, { category?: string; prices: Record<string, string> }>>({});
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState<"all" | "instagram" | "facebook" | "youtube">("all");
  const [onlyPriced, setOnlyPriced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/^@/, "");
    return (data ?? []).filter((t) =>
      (platform === "all" || t.platform === platform) &&
      (!onlyPriced || t.cards.length > 0) &&
      (!term || t.name.toLowerCase().includes(term) || (t.username ?? "").toLowerCase().includes(term) || (t.category ?? "").toLowerCase().includes(term)),
    );
  }, [data, q, platform, onlyPriced]);

  const priceOf = (t: Target, f: string, field: Field) => {
    const e = edits[keyOf(t)]?.prices[pk(f, field)];
    if (e !== undefined) return e;
    const v = t.cards.find((x) => x.format === f)?.[field];
    return v != null ? String(v / 100) : "";
  };
  const categoryOf = (t: Target) => edits[keyOf(t)]?.category ?? t.category ?? "";
  const setPrice = (t: Target, f: string, field: Field, v: string) =>
    setEdits((e) => ({ ...e, [keyOf(t)]: { ...e[keyOf(t)], prices: { ...(e[keyOf(t)]?.prices ?? {}), [pk(f, field)]: v } } }));
  const setCategory = (t: Target, v: string) =>
    setEdits((e) => ({ ...e, [keyOf(t)]: { prices: e[keyOf(t)]?.prices ?? {}, category: v } }));

  const changed = Object.keys(edits).length;

  const save = async () => {
    setErr("");
    setOk("");
    const byKey = new Map((data ?? []).map((t) => [keyOf(t), t]));
    type Out = { targetType: string; targetId: string; format: string; pricePaise: number | null; entertainmentPricePaise?: number | null; audioAddonPaise?: number | null; category?: string | null };
    const cards: Out[] = [];
    for (const [k, e] of Object.entries(edits)) {
      const t = byKey.get(k);
      if (!t) continue;
      const category = e.category !== undefined ? e.category.trim() || null : undefined;
      const formats = [...new Set(Object.keys(e.prices).map((x) => x.split(":")[0]))];
      for (const f of formats) {
        const vals: Partial<Record<Field, number | null>> = {};
        for (const { key, label } of fieldsFor(f)) {
          const raw = priceOf(t, f, key).trim();
          const rupees = raw === "" ? null : Number(raw.replace(/[,₹\s]/g, ""));
          if (rupees !== null && (!Number.isFinite(rupees) || rupees < 1)) return setErr(`Check the ${f} ${label} for ${t.name}.`);
          vals[key] = rupees === null ? null : Math.round(rupees * 100);
        }
        const existed = t.cards.some((c) => c.format === f);
        if (vals.pricePaise == null) {
          if (vals.entertainmentPricePaise != null || vals.audioAddonPaise != null) return setErr(`Set the ${f} brand price for ${t.name} first — it's what offers the format.`);
          if (!existed) continue;
        }
        cards.push({
          targetType: t.targetType,
          targetId: t.targetId,
          format: f,
          pricePaise: vals.pricePaise ?? null,
          entertainmentPricePaise: vals.entertainmentPricePaise ?? null,
          ...(f === "reel" ? { audioAddonPaise: vals.audioAddonPaise ?? null } : {}),
          ...(category !== undefined ? { category } : {}),
        });
      }
      if (category !== undefined && formats.length === 0) {
        // Category only: write it onto an existing card (category is per account).
        const any = t.cards[0];
        if (!any) return setErr(`Set at least one price for ${t.name} before giving it a category.`);
        cards.push({ targetType: t.targetType, targetId: t.targetId, format: any.format, pricePaise: any.pricePaise, category });
      }
    }
    if (!cards.length) {
      setEdits({});
      return;
    }
    setBusy(true);
    try {
      const r = await apiFetch<{ data: { upserted: number; deleted: number } }>("/admin/campaign-rate-cards", { method: "PUT", body: JSON.stringify({ cards }) });
      setOk(`Saved — ${r.data.upserted} price${r.data.upserted === 1 ? "" : "s"} set${r.data.deleted ? `, ${r.data.deleted} removed` : ""}.`);
      setEdits({});
      await mutate();
    } catch (e: any) {
      setErr(e.message || "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-24">
      <Link href="/campaigns" className="mt-6 inline-flex items-center gap-1 text-[12.5px] text-ds-t3 hover:text-ds-text"><ChevronLeft className="h-4 w-4" />Campaign bookings</Link>
      <PageHead
        title="Rate card"
        sub="Rupees per account and format. Brand = brand campaigns (empty = format not offered). Ent. = film / OTT / music campaigns (empty = not offered for those). Audio = song integration add-on on reels. Clients see accounts with at least one price."
      />

      <div className="flex flex-wrap gap-2 items-center mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-[360px]">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-ds-t3" />
          <input className={`${INPUT} pl-9`} placeholder="Search accounts" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search accounts" />
        </div>
        {(["all", "instagram", "facebook", "youtube"] as const).map((p) => (
          <button key={p} type="button" onClick={() => setPlatform(p)} aria-pressed={platform === p}
            className={`h-9 px-3.5 rounded-full text-[12.5px] font-semibold border ${platform === p ? "border-ds-gold text-ds-gold" : "border-ds-line2 text-ds-t2"}`}>
            {p === "all" ? "All" : p[0].toUpperCase() + p.slice(1)}
          </button>
        ))}
        <label className="inline-flex items-center gap-2 text-[12.5px] text-ds-t2 ml-1">
          <input type="checkbox" checked={onlyPriced} onChange={(e) => setOnlyPriced(e.target.checked)} /> Priced only
        </label>
      </div>

      {error && <ErrorBar message="Couldn't load accounts." />}
      {err && <div className="mb-3"><ErrorBar message={err} onClose={() => setErr("")} /></div>}
      {ok && <div className="mb-3 px-3.5 py-2.5 rounded-[8px] bg-[rgba(0,215,160,.08)] border border-[rgba(0,215,160,.3)] text-ds-teal text-[12.5px]">{ok}</div>}

      <section className={`${CARD} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-[13px]">
            <thead>
              <tr className="bg-ds-inset text-[10.5px] uppercase tracking-[.1em] text-ds-t3">
                <th className="text-left font-semibold px-5 h-[46px]">Account</th>
                <th className="text-right font-semibold px-3">Followers</th>
                <th className="text-left font-semibold px-3 w-[170px]">Category</th>
                {ALL_FORMATS.map((f) => (
                  <th key={f} className="text-left font-semibold px-2">
                    {f} ₹
                    <div className="flex gap-1.5 mt-0.5 normal-case tracking-normal text-[10px] text-ds-t4">
                      {fieldsFor(f).map((x) => <span key={x.key} className="w-[76px]">{x.short}</span>)}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!data && !error && <tr><td colSpan={6} className="py-12 text-center text-ds-t3">Loading…</td></tr>}
              {data && rows.length === 0 && <tr><td colSpan={6} className="py-12 text-center text-ds-t3">No accounts match.</td></tr>}
              {rows.map((t) => (
                <tr key={keyOf(t)} className={`border-t border-[#132430] ${edits[keyOf(t)] ? "bg-[rgba(233,189,98,.04)]" : ""}`}>
                  <td className="px-5 py-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <PlatformDot platform={t.platform} />
                      <span className="font-semibold text-ds-text truncate max-w-[260px]">{t.name}</span>
                    </div>
                    {t.username && <div className="text-[11.5px] text-ds-t3 pl-[18px]">@{t.username}</div>}
                  </td>
                  <td className="px-3 text-right tabular-nums text-ds-t2">{compact(t.followers)}</td>
                  <td className="px-3">
                    <input className={`${INPUT} h-9`} value={categoryOf(t)} maxLength={60} placeholder="e.g. Bollywood news" onChange={(e) => setCategory(t, e.target.value)} aria-label={`Category for ${t.name}`} />
                  </td>
                  {ALL_FORMATS.map((f) => (
                    <td key={f} className="px-2">
                      {t.formats.includes(f) ? (
                        <div className="flex gap-1.5">
                          {fieldsFor(f).map((x) => (
                            <input
                              key={x.key}
                              className={`${INPUT} h-9 w-[76px] px-2 tabular-nums`}
                              inputMode="decimal"
                              value={priceOf(t, f, x.key)}
                              placeholder="—"
                              title={x.label}
                              onChange={(e) => setPrice(t, f, x.key, e.target.value)}
                              aria-label={`${f} ${x.label} for ${t.name}`}
                            />
                          ))}
                        </div>
                      ) : (
                        <span className="text-ds-t4 text-[12px] px-2">n/a</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {changed > 0 && (
        <div className="fixed bottom-5 right-5 z-30 rounded-[14px] border border-ds-line3 bg-ds-card px-4 py-3 flex items-center gap-3 shadow-[0_12px_32px_rgba(0,0,0,.5)]">
          <span className="text-[13px] text-ds-t2">{changed} account{changed === 1 ? "" : "s"} changed</span>
          <button type="button" className="text-[12.5px] text-ds-t3 hover:text-ds-text" onClick={() => setEdits({})}>Discard</button>
          <button type="button" className={BTN_GOLD} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save prices"}</button>
        </div>
      )}
    </div>
  );
}
