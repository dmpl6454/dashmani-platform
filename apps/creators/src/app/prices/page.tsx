"use client";
import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { errorSentence } from "@/lib/messages";
import type { CreatorPagePrices } from "@/lib/types";
import { Banner, Loading, PageHead } from "@/components/ui";

// Prices: the creator sets their own price for one post per page and format. That price is
// what they are paid. Values are kept as typed text until Save (nothing is reformatted under the
// cursor) and converted to paise only then.

const FORMAT_LABEL: Record<string, string> = { reel: "Reel", post: "Post", carousel: "Carousel" };
const PLATFORM: Record<string, string> = { instagram: "Instagram", facebook: "Facebook Page" };
const toText = (p: number | null) => (p == null ? "" : String(p / 100));
/** Typed rupees → number (commas, ₹ and spaces allowed); null when empty, NaN when not a number. */
const parseRupees = (raw: string): number | null => (raw.trim() === "" ? null : Number(raw.replace(/[,₹\s]/g, "")));
const fmtRupees = (r: number) => `₹${r.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
/** A new price below this share of the old one is asked about before it is saved (₹60 for ₹6,000). */
const SHARP_DROP = 0.1;

export default function PricesPage() {
  const { creator } = useAuth();
  const { data, error, isLoading, mutate } = useSWR<CreatorPagePrices[]>("/creator/prices", fetcher, { revalidateOnFocus: false });

  if (isLoading && !data) return <Loading label="Loading your prices…" />;
  if (error && !data) {
    return (
      <Banner tone="danger" role="alert" title="We couldn't load your prices." action={<button className="btn btn-sm" onClick={() => mutate()}>Try again</button>}>
        {errorSentence(error)}
      </Banner>
    );
  }
  if (!data) return null;
  const readOnly = creator?.status === "suspended";

  return (
    <div className="flex flex-col gap-6">
      <PageHead kicker="Prices" title="Your price per post">
        Set what you want to be paid for one post on each page, in Indian rupees (₹). A format is listed for brands once your
        price is in and our team has finished pricing it; each one shows whether it is listed. Brands see your page with our service included; you are paid your price after the post is live.
        If a brand adds a song to a reel, the song add-on is paid to you in full on top of your price.
        Changing a price applies to new bookings only — posts already booked keep the price they were booked at.
      </PageHead>
      {readOnly && <Banner tone="warn" title="Your account is suspended, so prices can't be changed." />}
      {data.length === 0 ? (
        <div className="card p-6 text-sm text-ink-3">
          No pages connected yet. <Link href="/connect" className="underline">Connect your pages</Link> first.
        </div>
      ) : (
        data.map((p) => <PageForm key={p.assetId} page={p} readOnly={readOnly} onSaved={(next) => mutate(next, { revalidate: false })} />)
      )}
    </div>
  );
}

function PageForm({ page, readOnly, onSaved }: { page: CreatorPagePrices; readOnly: boolean; onSaved: (next: CreatorPagePrices[]) => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(page.prices.map((x) => [x.format, toText(x.pricePaise)])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  // Formats whose new price is a sharp drop; saving waits for a second click.
  const [confirmDrop, setConfirmDrop] = useState<string[] | null>(null);

  const save = async (confirmed = false) => {
    setErr("");
    setDone("");
    const prices: Array<{ assetId: string; format: string; pricePaise: number | null }> = [];
    const drops: string[] = [];
    for (const x of page.prices) {
      const r = parseRupees(vals[x.format] ?? "");
      if (r !== null && (!Number.isFinite(r) || r < 1 || r > 1_000_000)) return setErr(`Check the ${FORMAT_LABEL[x.format]} price — a number of rupees, at least ₹1.`);
      const paise = r === null ? null : Math.round(r * 100);
      if (paise === x.pricePaise) continue;
      prices.push({ assetId: page.assetId, format: x.format, pricePaise: paise });
      if (paise != null && x.pricePaise != null && paise < x.pricePaise * SHARP_DROP) {
        drops.push(`${FORMAT_LABEL[x.format]} from ${fmtRupees(x.pricePaise / 100)} to ${fmtRupees(paise / 100)}`);
      }
    }
    if (prices.length === 0) return setErr("Nothing changed.");
    if (drops.length && !confirmed) return setConfirmDrop(drops);
    setConfirmDrop(null);
    setBusy(true);
    try {
      const r = await apiFetch<CreatorPagePrices[]>("/creator/prices", { method: "PUT", body: JSON.stringify({ prices }) });
      onSaved(r.data);
      const saved = r.data.find((p) => p.assetId === page.assetId);
      setDone(
        saved
          ? `Saved — ${saved.prices.map((p) => `${FORMAT_LABEL[p.format]} ${p.pricePaise == null ? "not offered" : fmtRupees(p.pricePaise / 100)}`).join(" · ")}.`
          : "Saved.",
      );
    } catch (e) {
      setErr(errorSentence(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-5 flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-extrabold">{page.name}</h2>
        <span className="text-[13px] text-ink-3">{page.username ? `@${page.username} · ` : ""}{PLATFORM[page.platform]}</span>
        {!page.enabled && <span className="text-[12px] text-ink-3">· not switched on by our team yet</span>}
      </div>
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
        {page.prices.map((x) => (
          <label key={x.format} className="field">
            <span className="field-label">{FORMAT_LABEL[x.format]} (₹)</span>
            <input
              className="input"
              inputMode="decimal"
              value={vals[x.format] ?? ""}
              placeholder="Not offered"
              disabled={readOnly || busy}
              onChange={(e) => { setDone(""); setConfirmDrop(null); setVals((v) => ({ ...v, [x.format]: e.target.value })); }}
            />
            <PriceReadback raw={vals[x.format] ?? ""} format={x.format} />
            {x.pricePaise != null && (
              x.listed
                ? <span className="text-[12px] text-success">Listed — brands can book it</span>
                : <span className="text-[12px] text-ink-3">{page.enabled ? "Not listed yet — our team is finishing its pricing" : "Not listed — the page isn't switched on yet"}</span>
            )}
          </label>
        ))}
      </div>
      <p className="text-[12px] text-ink-3">Leave a format empty to stop offering it.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-sm" onClick={() => save()} disabled={readOnly || busy}>{busy ? "Saving…" : "Save prices"}</button>
        <span role="status" className="text-[13px] text-success">{done}</span>
      </div>
      {confirmDrop && (
        <Banner
          tone="warn"
          title="Is that price right?"
          action={
            <>
              <button type="button" className="btn btn-sm" onClick={() => save(true)} disabled={busy}>Yes, save it</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirmDrop(null)}>Change it</button>
            </>
          }
        >
          {confirmDrop.join("; ")} — that is less than a tenth of your current price. New bookings use it straight away.
        </Banner>
      )}
      {err && <Banner tone="danger" role="alert">{err}</Banner>}
    </section>
  );
}

/** What the typed text means, in rupees, under the field (₹60 vs ₹6,000 is easy to mistype). */
function PriceReadback({ raw, format }: { raw: string; format: string }) {
  const r = parseRupees(raw);
  if (r === null || !Number.isFinite(r) || r < 1) return null;
  return <span className="text-[12px] text-ink-3 tabular-nums">{fmtRupees(r)} per {FORMAT_LABEL[format]?.toLowerCase() ?? format}</span>;
}
