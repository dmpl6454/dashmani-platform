"use client";
import { useMemo, useState } from "react";
import { Button } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import {
  CAMPAIGN_LIMITS,
  CAMPAIGN_TYPE_LABELS,
  CAMPAIGN_TYPES,
  FORMAT_LABELS,
  type CampaignFormat,
  type CampaignType,
} from "@dashmani/shared/src/validators/campaign";
import { todayIST } from "@dashmani/shared/src/utils/date";
import {
  compact,
  mutateJson,
  offerPrice,
  rupees,
  useCatalogue,
  PLATFORM_LABEL,
  type Campaign,
} from "@/lib/campaign";
import { Card, ErrorBanner, Field, PlatformDot, inputCls, textareaCls } from "./_ui";
import { useHydrated } from "@/lib/hooks/use-hydrated";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");

// ── Step 1: details ─────────────────────────────────────────────────────────────

export function InfoForm({ initial, submitLabel, onSubmit, disabled }: {
  initial?: Partial<Pick<Campaign, "name" | "brand" | "objective" | "launchFrom" | "launchTo" | "campaignType">>;
  submitLabel: string;
  onSubmit: (v: { name: string; brand: string; objective: string | null; campaignType: CampaignType; launchFrom: string; launchTo: string }) => Promise<void>;
  disabled?: boolean;
}) {
  const today = todayIST();
  const [name, setName] = useState(initial?.name ?? "");
  const [brand, setBrand] = useState(initial?.brand ?? "");
  const [objective, setObjective] = useState(initial?.objective ?? "");
  const [campaignType, setCampaignType] = useState<CampaignType>(initial?.campaignType ?? "brand");
  const [from, setFrom] = useState(initial?.launchFrom ?? today);
  const [to, setTo] = useState(initial?.launchTo ?? today);
  // Submitting before hydration would GET-reload the page and drop the fields (see useHydrated).
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const local =
    name.trim().length < 2 ? "Give the campaign a name" :
    brand.trim().length < 2 ? "Enter the brand" :
    from < today ? "The start date can't be in the past" :
    to < from ? "The end date must be on or after the start" : null;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (local) return setError(local);
        setBusy(true);
        setError(null);
        try {
          await onSubmit({ name: name.trim(), brand: brand.trim(), objective: objective.trim() || null, campaignType, launchFrom: from, launchTo: to });
        } catch (err) {
          setError(errMsg(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Card title="Campaign details" sub="Tell us what you're promoting and when it should go live.">
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Campaign name" htmlFor="c-name">
              <input id="c-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="Diwali launch" disabled={disabled} />
            </Field>
            <Field label="Brand" htmlFor="c-brand">
              <input id="c-brand" className={inputCls} value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={200} placeholder="Your brand or product" disabled={disabled} />
            </Field>
          </div>
          <fieldset>
            <legend className="block text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-1.5">Campaign type</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {CAMPAIGN_TYPES.map((t) => (
                <label key={t} className={`flex items-start gap-2.5 rounded-xl border-2 px-3 py-2.5 cursor-pointer ${campaignType === t ? "border-ink" : "border-ink/15"}`}>
                  <input type="radio" name="ctype" value={t} checked={campaignType === t} onChange={() => setCampaignType(t)} disabled={disabled} className="mt-0.5 accent-[#403cfa]" />
                  <span>
                    <span className="block text-[13.5px] font-semibold text-ink">{CAMPAIGN_TYPE_LABELS[t]}</span>
                    <span className="block text-[12px] text-ink-3">{t === "brand" ? "A product, app or brand." : "A film, OTT show, song or event."}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="text-[12px] text-ink-3 mt-1.5">Prices on our accounts differ by campaign type.</p>
          </fieldset>
          <Field label="Objective (optional)" htmlFor="c-obj" hint="What should the posts achieve? Any do's and don'ts for our team.">
            <textarea id="c-obj" className={textareaCls} rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} maxLength={2000} disabled={disabled} />
          </Field>
          <div className="grid gap-4 grid-cols-2">
            <Field label="Go live from" htmlFor="c-from">
              <input id="c-from" type="date" className={inputCls} value={from} min={today} onChange={(e) => setFrom(e.target.value)} disabled={disabled} />
            </Field>
            <Field label="Go live by" htmlFor="c-to" hint={`Up to ${CAMPAIGN_LIMITS.launchWindowMaxDays} days`}>
              <input id="c-to" type="date" className={inputCls} value={to} min={from} onChange={(e) => setTo(e.target.value)} disabled={disabled} />
            </Field>
          </div>
          {error && <ErrorBanner>{error}</ErrorBanner>}
          {!disabled && (
            <div className="flex justify-end">
              <Button type="submit" variant="ink" disabled={busy || !hydrated} aria-live="polite" iconRight={<Icon.ArrowRight size={15} />}>
                {busy ? "Saving…" : submitLabel}
              </Button>
            </div>
          )}
        </div>
      </Card>
    </form>
  );
}


export { CreativeStep } from "./_creative";

// ── Step 3: accounts ────────────────────────────────────────────────────────────

type Sort = "followers" | "price" | "engagement";

export function AccountsStep({ campaign, onSaved }: { campaign: Campaign; onSaved: (c: Campaign) => void }) {
  const format = campaign.format as CampaignFormat;
  const { data, error: loadError, isLoading } = useCatalogue(true);
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState<"all" | "instagram" | "facebook" | "youtube">("all");
  const [sort, setSort] = useState<Sort>("followers");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(campaign.items.map((i) => i.rateCardId)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const offers = useMemo(() => {
    const rows = (data ?? []).flatMap((a) => {
      const o = a.offers.find((x) => x.format === format);
      const price = o ? offerPrice(o, campaign) : null;
      return o && price ? [{ ...a, offer: o, price }] : [];
    });
    return rows;
  }, [data, format, campaign]);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/^@/, "");
    return offers
      .filter((a) => platform === "all" || a.platform === platform)
      .filter((a) => !term || a.name.toLowerCase().includes(term) || (a.username ?? "").toLowerCase().includes(term) || (a.category ?? "").toLowerCase().includes(term))
      .sort((a, b) =>
        sort === "price" ? a.price.total - b.price.total :
        sort === "engagement" ? (b.engagementRatePct ?? -1) - (a.engagementRatePct ?? -1) :
        (b.followers ?? 0) - (a.followers ?? 0),
      );
  }, [offers, q, platform, sort]);

  const selected = offers.filter((a) => picked.has(a.offer.rateCardId));
  const total = selected.reduce((s, a) => s + a.price.total, 0);
  const withAudio = campaign.audioIntegration && format === "reel";
  const reach = selected.reduce((s, a) => s + (a.followers ?? 0), 0);
  const counts = { all: offers.length, instagram: 0, facebook: 0, youtube: 0 } as Record<string, number>;
  for (const a of offers) counts[a.platform]++;

  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const save = async () => {
    setError(null);
    if (picked.size === 0) return setError("Pick at least one account.");
    setBusy(true);
    try {
      onSaved(await mutateJson<Campaign>(`/client/campaigns/${campaign.id}/items`, "PUT", { rateCardIds: [...picked].filter((id) => offers.some((a) => a.offer.rateCardId === id)) }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 pb-24">
      <Card
        title="Choose accounts"
        sub={`Accounts on our network that carry a ${FORMAT_LABELS[format].toLowerCase()}. Prices are per account, for ${CAMPAIGN_TYPE_LABELS[campaign.campaignType].toLowerCase()}${withAudio ? ", including song audio integration" : ""}.`}
      >
        <div className="flex flex-wrap gap-2 items-center mb-3">
          <div className="relative flex-1 min-w-[180px]">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"><Icon.Search size={15} /></span>
            <input className={`${inputCls} pl-9`} placeholder="Search name, @handle or category" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search accounts" />
          </div>
          <select className={`${inputCls} !w-auto`} value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
            <option value="followers">Most followers</option>
            <option value="engagement">Highest engagement</option>
            <option value="price">Lowest price</option>
          </select>
        </div>
        <div className="flex flex-wrap gap-1.5 mb-4" role="tablist">
          {(["all", "instagram", "facebook", "youtube"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={platform === p}
              onClick={() => setPlatform(p)}
              className={`h-8 px-3 rounded-full text-[12.5px] font-semibold border-2 ${platform === p ? "bg-indigo text-white border-indigo" : "border-ink/15 text-ink-2"}`}
            >
              {p === "all" ? "All" : PLATFORM_LABEL[p]} <span className="opacity-70 tabular-nums">{counts[p] ?? 0}</span>
            </button>
          ))}
        </div>

        {loadError && <ErrorBanner>Couldn't load the accounts. Refresh the page.</ErrorBanner>}
        {isLoading && <div className="text-[13px] text-ink-3 py-6 text-center">Loading accounts…</div>}
        {data && visible.length === 0 && (
          <div className="text-[13px] text-ink-3 py-8 text-center">
            {offers.length === 0 ? `No accounts are open for ${FORMAT_LABELS[format].toLowerCase()} bookings yet. Try another format, or contact us.` : "No accounts match your search."}
          </div>
        )}

        <ul className="grid gap-2">
          {visible.map((a) => {
            const on = picked.has(a.offer.rateCardId);
            return (
              <li key={a.offer.rateCardId}>
                <label className={`flex items-center gap-3 rounded-xl border-2 px-3 py-2.5 cursor-pointer transition-colors ${on ? "border-ink bg-indigo/5" : "border-ink/10 hover:border-ink/30"}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(a.offer.rateCardId)} className="h-4 w-4 accent-[#403cfa] shrink-0" />
                  {a.pictureUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={a.pictureUrl} alt="" className="h-9 w-9 rounded-full object-cover shrink-0 bg-muted" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="h-9 w-9 rounded-full bg-muted grid place-items-center text-[13px] font-bold text-ink-2 shrink-0">{a.name[0]?.toUpperCase()}</span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <PlatformDot platform={a.platform} />
                      <span className="text-[13.5px] font-semibold text-ink truncate">{a.name}</span>
                      {a.profileUrl && (
                        <a href={a.profileUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="text-ink-3 hover:text-ink shrink-0" aria-label={`Open ${a.name}`}>
                          <Icon.External size={12} />
                        </a>
                      )}
                    </div>
                    <div className="text-[12px] text-ink-3 flex flex-wrap gap-x-3 gap-y-0.5">
                      {a.username && <span className="truncate max-w-[160px]">@{a.username}</span>}
                      <span>{PLATFORM_LABEL[a.platform]}</span>
                      {a.category && <span>{a.category}</span>}
                    </div>
                  </div>
                  <div className="hidden sm:grid grid-cols-2 gap-x-5 text-right shrink-0">
                    <span className="text-[13px] font-semibold text-ink tabular-nums">{compact(a.followers)}</span>
                    <span className="text-[13px] font-semibold text-ink tabular-nums" title="Engagements per view over the last 28 days">{a.engagementRatePct != null ? `${a.engagementRatePct}%` : "—"}</span>
                    <span className="text-[10.5px] uppercase tracking-wider text-ink-3">Followers</span>
                    <span className="text-[10.5px] uppercase tracking-wider text-ink-3">Engagement</span>
                  </div>
                  <div className="text-right shrink-0 w-[96px]">
                    <div className="text-[14px] font-bold text-ink tabular-nums">{rupees(a.price.total)}</div>
                    {a.price.addon > 0 && <div className="text-[10.5px] text-ink-3 tabular-nums" title="Base price + song audio">incl. {rupees(a.price.addon)} audio</div>}
                    <div className="sm:hidden text-[11px] text-ink-3 tabular-nums">{compact(a.followers)} followers</div>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="fixed bottom-0 left-0 right-0 lg:left-auto lg:right-6 lg:bottom-6 z-20 bg-surface border-t-2 lg:border-2 border-ink lg:rounded-2xl shadow-hard-ink px-4 py-3 flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-ink-3">{selected.length} account{selected.length === 1 ? "" : "s"} · {compact(reach)} followers</div>
          <div className="text-[17px] font-bold text-ink tabular-nums">{rupees(total)}</div>
        </div>
        {error && <span className="text-[12px] text-danger font-medium max-w-[220px]">{error}</span>}
        <Button variant="ink" onClick={save} disabled={busy || picked.size === 0} iconRight={<Icon.ArrowRight size={15} />}>
          {busy ? "Saving…" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
