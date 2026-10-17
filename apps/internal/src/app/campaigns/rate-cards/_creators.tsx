"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, Search } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useCreatorRateTargets, type CreatorTarget } from "@/lib/hooks/use-campaign-creators";
import { BTN_GHOST, BTN_GOLD, CARD, INPUT, ErrorBar, PlatformDot, compact, rupees } from "../_ds";
import {
  CREATOR_MIN_PAYOUT_PAISE, CREATOR_SHARE_MAX_BPS, CREATOR_TARGET_TYPE, NOT_BOOKABLE_TEXT,
  bpsToPercent, percentToBps, previewPayout, rupeesToPaise,
} from "../_creator";

// "Creator pages" on the campaign rate card: the pages of approved creators, each priced like a network account PLUS
// the share of the price the creator is paid. STAFF ONLY. The share, the creator's payout and our cut are shown here
// and nowhere a client or a creator can see (the client sees the price and the creator's name; the creator sees only
// their own rupee amount, after TDS).
//
// The numbers on this screen are a PREVIEW. The API re-checks the share cap and the payout floor when a card is saved
// (SHARE_TOO_HIGH / PAYOUT_TOO_LOW), re-prices at checkout and recomputes at capture; the inline messages below just
// say the same thing sooner.

type Field = "pricePaise" | "entertainmentPricePaise" | "audioAddonPaise" | "share";
type FormatEdit = Partial<Record<Field, string>>;
type PageEdit = { category?: string; formats: Record<string, FormatEdit> };

const FIELD_LABEL: Record<Field, string> = { pricePaise: "Brand ₹", entertainmentPricePaise: "Ent. ₹", audioAddonPaise: "Audio ₹", share: "Share %" };
const FIELD_TITLE: Record<Field, string> = {
  pricePaise: "brand price",
  entertainmentPricePaise: "entertainment price",
  audioAddonPaise: "song audio add-on",
  share: "the creator's share",
};
const fieldsFor = (f: string): Field[] => (f === "reel" ? ["pricePaise", "entertainmentPricePaise", "audioAddonPaise", "share"] : ["pricePaise", "entertainmentPricePaise", "share"]);
const FORMAT_LABEL: Record<string, string> = { reel: "Reel", post: "Post", carousel: "Carousel" };
const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook" };

/** The value the inputs show when nothing has been typed: what is stored. */
function storedValue(t: CreatorTarget, format: string, field: Field): string {
  const c = t.cards.find((x) => x.format === format);
  if (!c) return "";
  if (field === "share") return c.shareBps != null ? bpsToPercent(c.shareBps) : "";
  const v = c[field];
  return v != null ? String(v / 100) : "";
}

interface PreviewLine {
  label: string;
  pricePaise: number;
  creatorGetsPaise: number;
  tdsPaise: number;
  ourCutPaise: number;
}
type FormatEval =
  | { kind: "empty" }
  | { kind: "error"; field: Field; message: string }
  | { kind: "ok"; brandPaise: number; entertainmentPaise: number | null; audioPaise: number | null; shareBps: number; lines: PreviewLine[] };

/** Whether a format's typed values make a valid card (and what the creator would get), mirroring the API's checks. */
function evaluate(t: CreatorTarget, format: string, valueOf: (field: Field) => string): FormatEval {
  const tdsBps = t.creator?.tdsBps ?? 0;
  const brandRaw = valueOf("pricePaise").trim();
  const entRaw = valueOf("entertainmentPricePaise").trim();
  const audioRaw = format === "reel" ? valueOf("audioAddonPaise").trim() : "";
  const shareRaw = valueOf("share").trim();
  const brand = rupeesToPaise(brandRaw);
  const ent = rupeesToPaise(entRaw);
  const audio = rupeesToPaise(audioRaw);
  if (brandRaw !== "" && brand === null) return { kind: "error", field: "pricePaise", message: "Enter the brand price in rupees." };
  if (entRaw !== "" && ent === null) return { kind: "error", field: "entertainmentPricePaise", message: "Enter the entertainment price in rupees, or leave it empty." };
  if (audioRaw !== "" && audio === null) return { kind: "error", field: "audioAddonPaise", message: "Enter the song audio add-on in rupees, or leave it empty." };
  if (brand === null) {
    if (ent !== null || audio !== null) return { kind: "error", field: "pricePaise", message: `Set the ${format} brand price first — it's what offers the format.` };
    return { kind: "empty" };
  }
  if (shareRaw === "") return { kind: "error", field: "share", message: "Set the creator's share." };
  const shareBps = percentToBps(shareRaw);
  if (shareBps === null) return { kind: "error", field: "share", message: "Enter a percentage with at most two decimals, like 70 or 62.5." };
  if (shareBps < 100) return { kind: "error", field: "share", message: "A share is at least 1%." };
  if (shareBps > CREATOR_SHARE_MAX_BPS) return { kind: "error", field: "share", message: `A creator's share can be at most ${CREATOR_SHARE_MAX_BPS / 100}% of the price.` };
  // The floor is judged at the card's LOWEST price (Brand or Entertainment). The song add-on only raises a price.
  const lowest = Math.min(brand, ent ?? Number.POSITIVE_INFINITY);
  const lowestPayout = previewPayout(lowest, shareBps, tdsBps).amountPaise;
  if (lowestPayout < CREATOR_MIN_PAYOUT_PAISE) {
    return {
      kind: "error",
      field: "share",
      message: `At the lowest price on this card (${rupees(lowest)}) the creator would be paid ${rupees(lowestPayout)}, which is under the ${rupees(CREATOR_MIN_PAYOUT_PAISE)} minimum. Raise the price or the share.`,
    };
  }
  const line = (label: string, price: number): PreviewLine => {
    const p = previewPayout(price, shareBps, tdsBps);
    return { label, pricePaise: price, creatorGetsPaise: p.amountPaise, tdsPaise: p.tdsPaise, ourCutPaise: p.ourCutPaise };
  };
  const lines = [line("Brand", brand)];
  if (ent !== null) lines.push(line("Entertainment", ent));
  if (audio !== null) {
    lines.push(line("Brand + song audio", brand + audio));
    if (ent !== null) lines.push(line("Entertainment + song audio", ent + audio));
  }
  return { kind: "ok", brandPaise: brand, entertainmentPaise: ent, audioPaise: audio, shareBps, lines };
}

export function CreatorPages({ onPendingChange }: { onPendingChange?: (changedPages: number) => void }) {
  const { data, error, mutate, isLoading } = useCreatorRateTargets();
  const [edits, setEdits] = useState<Record<string, PageEdit>>({});
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const valueOf = (t: CreatorTarget, f: string, field: Field) => edits[t.targetId]?.formats[f]?.[field] ?? storedValue(t, f, field);
  const categoryOf = (t: CreatorTarget) => edits[t.targetId]?.category ?? t.category ?? "";
  const setValue = (t: CreatorTarget, f: string, field: Field, v: string) => {
    setOk("");
    setEdits((e) => {
      const page = e[t.targetId] ?? { formats: {} };
      return { ...e, [t.targetId]: { ...page, formats: { ...page.formats, [f]: { ...page.formats[f], [field]: v } } } };
    });
  };
  const setCategory = (t: CreatorTarget, v: string) => {
    setOk("");
    setEdits((e) => ({ ...e, [t.targetId]: { formats: e[t.targetId]?.formats ?? {}, category: v } }));
  };

  const formatDirty = (t: CreatorTarget, f: string) => fieldsFor(f).some((x) => (edits[t.targetId]?.formats[f]?.[x] ?? storedValue(t, f, x)).trim() !== storedValue(t, f, x).trim());
  const categoryDirty = (t: CreatorTarget) => edits[t.targetId]?.category !== undefined && edits[t.targetId]!.category!.trim() !== (t.category ?? "");

  const evals = useMemo(() => {
    const m = new Map<string, FormatEval>();
    for (const t of data ?? []) for (const f of t.formats) m.set(`${t.targetId}:${f}`, evaluate(t, f, (field) => edits[t.targetId]?.formats[f]?.[field] ?? storedValue(t, f, field)));
    return m;
  }, [data, edits]);

  const changedPages = (data ?? []).filter((t) => categoryDirty(t) || t.formats.some((f) => formatDirty(t, f)));
  // A card that is being edited and is not valid blocks saving everything: the API takes the whole batch or nothing.
  const blocked = changedPages.filter((t) => t.formats.some((f) => formatDirty(t, f) && evals.get(`${t.targetId}:${f}`)?.kind === "error"));
  // Tell the page whether our save bar is up, so its own bar can move out of the way.
  const pending = changedPages.length;
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(0);
  }, [pending, onPendingChange]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/^@/, "");
    return (data ?? []).filter((t) => !term || t.name.toLowerCase().includes(term) || (t.username ?? "").toLowerCase().includes(term) || (t.creator?.name ?? "").toLowerCase().includes(term));
  }, [data, q]);

  const save = async () => {
    setErr("");
    setOk("");
    type Out = {
      targetType: string; targetId: string; format: string; pricePaise: number | null;
      entertainmentPricePaise?: number | null; audioAddonPaise?: number | null; shareBps?: number; category?: string | null;
    };
    const cards: Out[] = [];
    for (const t of changedPages) {
      const category = categoryDirty(t) ? edits[t.targetId]!.category!.trim() || null : undefined;
      let wrote = false;
      for (const f of t.formats) {
        if (!formatDirty(t, f)) continue;
        const ev = evals.get(`${t.targetId}:${f}`);
        if (!ev || ev.kind === "error") return setErr(`Fix the ${f} card for ${t.name} first.`);
        if (ev.kind === "empty") {
          // The brand price was cleared: the card goes (an account without a card is simply not offered).
          if (t.cards.some((c) => c.format === f)) {
            cards.push({ targetType: CREATOR_TARGET_TYPE, targetId: t.targetId, format: f, pricePaise: null, ...(category !== undefined ? { category } : {}) });
            wrote = true;
          }
          continue;
        }
        cards.push({
          targetType: CREATOR_TARGET_TYPE,
          targetId: t.targetId,
          format: f,
          pricePaise: ev.brandPaise,
          entertainmentPricePaise: ev.entertainmentPaise,
          ...(f === "reel" ? { audioAddonPaise: ev.audioPaise } : {}),
          shareBps: ev.shareBps,
          ...(category !== undefined ? { category } : {}),
        });
        wrote = true;
      }
      if (category !== undefined && !wrote) {
        // Category only: it is stored per account on its cards, so write it onto one that is complete.
        const any = t.cards.find((c) => c.shareBps != null);
        if (!any || any.shareBps == null) return setErr(`Set a price and a share for ${t.name} before giving it a category.`);
        cards.push({ targetType: CREATOR_TARGET_TYPE, targetId: t.targetId, format: any.format, pricePaise: any.pricePaise, shareBps: any.shareBps, category });
      }
    }
    if (cards.length === 0) {
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
      // The API says exactly what it refused (share too high, payout too low, a page that is no longer priceable…).
      setErr(e?.message || "Couldn't save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-10" style={changedPages.length > 0 ? { paddingBottom: 96 } : undefined} aria-labelledby="creator-pages-h">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 mb-3">
        <div className="min-w-0 flex-1 basis-[320px]">
          <h2 id="creator-pages-h" className="text-[20px] font-bold tracking-[-.02em] text-ds-text">Creator pages</h2>
          <p className="mt-1 text-[13px] text-ds-t2 max-w-[780px]">
            Pages of approved creators (switch a page on in <Link href="/creators" className="text-ds-gold hover:underline">Creators</Link> first). Price them like any account, then set the <strong className="text-ds-text">share of the price the creator gets</strong>. The creator sees the exact rupee amount before accepting; the client sees the price and the creator&apos;s name as the provider of the post, never the share. Clients can book a page only once its creator&apos;s bank account is active.
          </p>
        </div>
        <div className="relative w-full sm:w-[280px]">
          <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-ds-t3" />
          <input className={`${INPUT} pl-9`} placeholder="Search creator pages" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search creator pages" />
        </div>
      </div>

      {error && !data && (
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[220px]"><ErrorBar message="Couldn't load creator pages." /></div>
          <button type="button" className={BTN_GHOST} onClick={() => void mutate()}>Try again</button>
        </div>
      )}
      {err && <div className="mb-3"><ErrorBar message={err} onClose={() => setErr("")} /></div>}
      {ok && <div role="status" className="mb-3 px-3.5 py-2.5 rounded-[8px] bg-[rgba(0,215,160,.08)] border border-[rgba(0,215,160,.3)] text-ds-teal text-[12.5px]">{ok}</div>}

      {isLoading && !data && <p className="py-10 text-center text-[13px] text-ds-t3">Loading creator pages…</p>}
      {data && data.length === 0 && (
        <div className={`${CARD} p-6 text-[13px] text-ds-t3`}>
          No creator pages to price yet. A page shows up here once its creator is approved and the page is switched on in <Link href="/creators" className="text-ds-gold hover:underline">Creators</Link>.
        </div>
      )}
      {data && data.length > 0 && rows.length === 0 && <div className={`${CARD} p-6 text-[13px] text-ds-t3`}>No creator pages match.</div>}

      <div className="grid gap-4 xl:grid-cols-2">
        {rows.map((t) => (
          <PageCard
            key={t.targetId}
            t={t}
            changed={categoryDirty(t) || t.formats.some((f) => formatDirty(t, f))}
            valueOf={(f, field) => valueOf(t, f, field)}
            dirty={(f) => formatDirty(t, f)}
            evalOf={(f) => evals.get(`${t.targetId}:${f}`) ?? { kind: "empty" }}
            category={categoryOf(t)}
            onValue={(f, field, v) => setValue(t, f, field, v)}
            onCategory={(v) => setCategory(t, v)}
          />
        ))}
      </div>

      {changedPages.length > 0 && (
        // Fixed like the network table's bar (the page lifts that one above this one while both are up).
        <div className="fixed bottom-5 left-5 right-5 sm:left-auto z-30 rounded-[14px] border border-ds-line3 bg-ds-card px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2 shadow-[0_12px_32px_rgba(0,0,0,.5)]">
          <span className="text-[13px] text-ds-t2">
            {changedPages.length} creator page{changedPages.length === 1 ? "" : "s"} changed
            {blocked.length > 0 && <span className="block sm:inline sm:ml-2 text-ds-redsoft">Fix the highlighted card{blocked.length === 1 ? "" : "s"} to save.</span>}
          </span>
          <button type="button" className="text-[12.5px] text-ds-t3 hover:text-ds-text" onClick={() => setEdits({})} disabled={busy}>Discard</button>
          <button type="button" className={BTN_GOLD} disabled={busy || blocked.length > 0} onClick={save}>{busy ? "Saving…" : "Save creator prices"}</button>
        </div>
      )}
    </section>
  );
}

function PageCard({ t, changed, valueOf, dirty, evalOf, category, onValue, onCategory }: {
  t: CreatorTarget;
  changed: boolean;
  valueOf: (format: string, field: Field) => string;
  dirty: (format: string) => boolean;
  evalOf: (format: string) => FormatEval;
  category: string;
  onValue: (format: string, field: Field, v: string) => void;
  onCategory: (v: string) => void;
}) {
  const tdsBps = t.creator?.tdsBps ?? 0;
  const notBookable = t.creator?.notBookable ?? null;
  return (
    <article className={`${CARD} p-4 sm:p-5 min-w-0 ${changed ? "border-[rgba(233,189,98,.45)]" : ""}`} aria-label={`${t.name}, creator page`}>
      <header className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <PlatformDot platform={t.platform} />
        <div className="min-w-0 flex-1 basis-[180px]">
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-[14.5px] font-semibold text-ds-text truncate min-w-0">{t.name}</h3>
            {t.profileUrl && (
              <a href={t.profileUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 text-ds-t3 hover:text-ds-gold" aria-label={`Open ${t.name} on ${PLATFORM_LABEL[t.platform] ?? t.platform}`}>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
          <div className="text-[12px] text-ds-t3 break-words">
            {PLATFORM_LABEL[t.platform] ?? t.platform}{t.username ? ` · @${t.username}` : ""} · {compact(t.followers)} followers
          </div>
        </div>
        <span className="inline-flex items-center h-6 px-2.5 rounded-full text-[11.5px] font-semibold text-ds-purple bg-ds-purple/10 max-w-full" title="The creator who owns this page and is paid for posts on it">
          <span className="truncate">Creator: {t.creator?.name ?? "unknown"}</span>
        </span>
      </header>

      {notBookable ? (
        <div className="mt-3 px-3 py-2 rounded-[8px] bg-[rgba(233,189,98,.08)] border border-[rgba(233,189,98,.35)] text-ds-gold text-[12px]">
          <strong>Not visible to clients yet.</strong> {NOT_BOOKABLE_TEXT[notBookable]} You can still set its prices now.
        </div>
      ) : (
        <div className="mt-3 px-3 py-2 rounded-[8px] bg-[rgba(0,215,160,.07)] border border-[rgba(0,215,160,.25)] text-ds-teal text-[12px]">
          Bank account active — clients can book this page with the prices below once creator bookings are switched on.
        </div>
      )}

      <div className="mt-3 max-w-[340px]">
        <label htmlFor={`cat-${t.targetId}`} className="block text-[10.5px] uppercase tracking-[.1em] font-semibold text-ds-t3 mb-1">Category</label>
        <input id={`cat-${t.targetId}`} className={`${INPUT} h-9`} value={category} maxLength={60} placeholder="e.g. Bollywood news" onChange={(e) => onCategory(e.target.value)} />
      </div>

      <div className="mt-4 grid gap-4">
        {t.formats.map((f) => (
          <FormatBlock key={f} t={t} format={f} valueOf={(field) => valueOf(f, field)} dirty={dirty(f)} ev={evalOf(f)} onValue={(field, v) => onValue(f, field, v)} />
        ))}
      </div>

      <p className="mt-4 text-[11.5px] text-ds-t4 leading-relaxed">
        {tdsBps > 0
          ? `${tdsBps / 100}% TDS is withheld from the creator's share and is not ours. `
          : "No TDS rate is set for this creator, so the amounts above are before any tax withheld. "}
        &ldquo;We keep&rdquo; is the price minus the creator&apos;s share. Razorpay&apos;s 0.25% transfer fee + GST and the gateway fee are ours, never taken from the creator.
      </p>
    </article>
  );
}

function FormatBlock({ t, format, valueOf, dirty, ev, onValue }: {
  t: CreatorTarget;
  format: string;
  valueOf: (field: Field) => string;
  dirty: boolean;
  ev: FormatEval;
  onValue: (field: Field, v: string) => void;
}) {
  const card = t.cards.find((c) => c.format === format);
  const fields = fieldsFor(format);
  const errField = ev.kind === "error" ? ev.field : null;
  // Only complain about what the user touched: an untouched stored card that the API accepted is not an error.
  const showError = ev.kind === "error" && dirty;
  const idBase = `${t.targetId}-${format}`;
  return (
    <div className="min-w-0 rounded-[12px] bg-ds-inset px-3 py-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h4 className="text-[12.5px] font-semibold text-ds-text">{FORMAT_LABEL[format] ?? format}</h4>
        {card && card.active && card.shareBps != null && <span className="text-[11px] font-semibold text-ds-teal">Saved</span>}
        {card && !card.active && <span className="text-[11px] font-semibold text-ds-gold">Switched off</span>}
        {card && card.active && card.shareBps == null && <span className="text-[11px] font-semibold text-ds-gold">No share set</span>}
      </div>
      <div className={`grid grid-cols-2 gap-2 ${fields.length === 4 ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
        {fields.map((field) => {
          const invalid = showError && errField === field;
          return (
            <div key={field} className="min-w-0">
              <label htmlFor={`${idBase}-${field}`} className="block text-[10.5px] uppercase tracking-[.08em] font-semibold text-ds-t3 mb-1" title={FIELD_TITLE[field]}>{FIELD_LABEL[field]}</label>
              <div className="relative">
                <input
                  id={`${idBase}-${field}`}
                  className={`${INPUT} h-9 px-2 tabular-nums ${field === "share" ? "pr-6" : ""} aria-[invalid=true]:border-[#E5484D]`}
                  inputMode="decimal"
                  autoComplete="off"
                  value={valueOf(field)}
                  placeholder={field === "share" ? "e.g. 70" : "—"}
                  aria-invalid={invalid}
                  aria-describedby={invalid ? `${idBase}-err` : undefined}
                  onChange={(e) => onValue(field, e.target.value)}
                />
                {field === "share" && <span aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[12px] text-ds-t3">%</span>}
              </div>
            </div>
          );
        })}
      </div>

      {showError && ev.kind === "error" && <p id={`${idBase}-err`} role="alert" className="mt-2 text-[12px] text-ds-redsoft">{ev.message}</p>}
      {ev.kind === "ok" && (
        <ul className="mt-2.5 grid gap-1 text-[12px] text-ds-t2" aria-label={`What the creator is paid for a ${format}`}>
          {ev.lines.map((l) => (
            <li key={l.label} className="break-words">
              <span className="text-ds-t5 font-semibold">{l.label} {rupees(l.pricePaise)}</span>
              {" · "}creator gets <strong className="text-ds-text tabular-nums">{rupees(l.creatorGetsPaise)}</strong> after TDS
              {" · "}we keep <strong className="text-ds-text tabular-nums">{rupees(l.ourCutPaise)}</strong> before Razorpay fees
            </li>
          ))}
        </ul>
      )}
      {ev.kind === "ok" && card && !card.active && dirty && <p className="mt-1.5 text-[11.5px] text-ds-gold">This card is switched off. Saving switches it back on.</p>}
      {card && !card.active && !dirty && (
        <p className="mt-2 text-[11.5px] text-ds-gold">Switched off (for example because the page changed hands). It isn&apos;t offered to clients. Set a share and save to switch it back on.</p>
      )}
      {card && card.active && card.shareBps == null && !dirty && (
        <p className="mt-2 text-[11.5px] text-ds-gold">This card has no share, so it isn&apos;t offered to clients. Set a share and save.</p>
      )}
    </div>
  );
}
