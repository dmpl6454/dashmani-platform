"use client";
import { useMemo, useState } from "react";
import { Button } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import {
  CAMPAIGN_LIMITS,
  CAMPAIGN_TYPE_LABELS,
  CAMPAIGN_TYPES,
  FORMAT_LABELS,
  daysBetween,
  type CampaignFormat,
  type CampaignType,
} from "@dashmani/shared/src/validators/campaign";
import { addDaysIST, todayIST } from "@dashmani/shared/src/utils/date";
import { categoryKey, categoryTabs, inCategory } from "@dashmani/shared/src/campaign/categories";
import { ApiError } from "@/lib/api";
import {
  compact,
  mutateJson,
  offerPrice,
  renderPending,
  rupees,
  useCatalogue,
  PLATFORM_LABEL,
  type Campaign,
} from "@/lib/campaign";
import { Card, ErrorBanner, Field, PlatformDot, inputCls, textareaCls } from "./_ui";
import { useHydrated } from "@/lib/hooks/use-hydrated";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong. Please try again.");

/** Search matches a category the same way the category tabs group it (case and spacing ignored). */
const matchesCategory = (category: string | null, term: string) => {
  const want = categoryKey(term);
  return want !== "" && categoryKey(category).includes(want);
};

// ── Step 1: details ─────────────────────────────────────────────────────────────

type InfoField = "c-name" | "c-brand" | "c-from" | "c-to";
/** API field names (validation `details[].field`) → the input that shows the error. */
const INFO_FIELD: Record<string, InfoField> = { name: "c-name", brand: "c-brand", launchFrom: "c-from", launchTo: "c-to" };
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export function InfoForm({ initial, submitLabel, onSubmit, disabled }: {
  initial?: Partial<Pick<Campaign, "name" | "brand" | "objective" | "launchFrom" | "launchTo" | "campaignType">>;
  submitLabel: string;
  onSubmit: (v: { name: string; brand: string; objective: string | null; campaignType: CampaignType; launchFrom: string; launchTo: string }) => Promise<void>;
  disabled?: boolean;
}) {
  const today = todayIST();
  // Default window: tomorrow + a week, so it is still open after our review. Today stays allowed.
  const defFrom = addDaysIST(today, 1);
  const maxDays = CAMPAIGN_LIMITS.launchWindowMaxDays;
  const [name, setName] = useState(initial?.name ?? "");
  const [brand, setBrand] = useState(initial?.brand ?? "");
  const [objective, setObjective] = useState(initial?.objective ?? "");
  const [campaignType, setCampaignType] = useState<CampaignType>(initial?.campaignType ?? "brand");
  const [from, setFrom] = useState(initial?.launchFrom ?? defFrom);
  const [to, setTo] = useState(initial?.launchTo ?? addDaysIST(defFrom, 7));
  // Submitting before hydration would GET-reload the page and drop the fields (see useHydrated).
  const hydrated = useHydrated();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ field: InfoField; msg: string } | null>(null);

  const local: { field: InfoField; msg: string } | null =
    name.trim().length < 2 ? { field: "c-name", msg: "Give the campaign a name" } :
    brand.trim().length < 2 ? { field: "c-brand", msg: "Enter the brand or title" } :
    !isYmd(from) ? { field: "c-from", msg: "Pick the earliest posting date" } :
    !isYmd(to) ? { field: "c-to", msg: "Pick the latest posting date" } :
    from < today ? { field: "c-from", msg: "The earliest posting date can't be in the past" } :
    to < from ? { field: "c-to", msg: "The latest posting date must be on or after the earliest" } :
    daysBetween(from, to) > maxDays ? { field: "c-to", msg: `The launch window can be at most ${maxDays} days` } : null;

  const fail = (f: { field: InfoField; msg: string } | null, msg: string) => {
    setFieldErr(f);
    // A message that belongs to a field is shown (and announced) on that field only; the banner
    // is for errors with no field, so nothing is read twice or left behind once the field is fixed.
    setError(f ? null : msg);
    if (f) document.getElementById(f.field)?.focus();
  };
  /** The error under one field, cleared as soon as that field is edited. */
  const errFor = (f: InfoField) => (fieldErr?.field === f ? fieldErr.msg : null);
  const edited = (f: InfoField) => {
    if (fieldErr?.field === f) setFieldErr(null);
  };

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (local) return fail(local, local.msg);
        setBusy(true);
        setError(null);
        setFieldErr(null);
        try {
          await onSubmit({ name: name.trim(), brand: brand.trim(), objective: objective.trim() || null, campaignType, launchFrom: from, launchTo: to });
        } catch (err) {
          const key = err instanceof ApiError ? err.details?.[0]?.field?.split(".").pop() : undefined;
          const field = key ? INFO_FIELD[key] : undefined;
          fail(field ? { field, msg: errMsg(err) } : null, errMsg(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Card title="Campaign details" sub="Tell us what you're promoting and the dates between which we may post it.">
        <div className="grid grid-cols-1 gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Campaign name" htmlFor="c-name" error={errFor("c-name")}>
              <input id="c-name" className={inputCls} value={name} onChange={(e) => { setName(e.target.value); edited("c-name"); }} maxLength={200} placeholder="Diwali launch" disabled={disabled} />
            </Field>
            <Field label="Brand or title" htmlFor="c-brand" error={errFor("c-brand")}>
              <input id="c-brand" className={inputCls} value={brand} onChange={(e) => { setBrand(e.target.value); edited("c-brand"); }} maxLength={200} placeholder="Brand, product, film or show" disabled={disabled} />
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
          {/* Stacked on phones: two date fields side by side wrap their labels unevenly below ~370px. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Earliest posting date" htmlFor="c-from" error={errFor("c-from")}>
              <input id="c-from" type="date" className={inputCls} value={from} min={today} onChange={(e) => { setFrom(e.target.value); edited("c-from"); }} disabled={disabled} />
            </Field>
            <Field
              label="Latest posting date"
              htmlFor="c-to"
              error={errFor("c-to")}
              hint={`We post on each account some time between these dates · up to ${maxDays} days apart · our team reviews within a working day first`}
            >
              <input id="c-to" type="date" className={inputCls} value={to} min={from} max={isYmd(from) ? addDaysIST(from, maxDays) : undefined} onChange={(e) => { setTo(e.target.value); edited("c-to"); }} disabled={disabled} />
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

export function AccountsStep({ campaign, onSaved, onEdit }: {
  campaign: Campaign;
  onSaved: (c: Campaign) => void;
  /**
   * Jump to the step whose choice hides accounts (campaign type → Details, song → Content).
   * `next` is the campaign after the ticks made here were saved, so the detour loses nothing.
   */
  onEdit?: (s: "info" | "creative", next?: Campaign) => void;
}) {
  const format = campaign.format as CampaignFormat;
  const fmt = FORMAT_LABELS[format].toLowerCase();
  const { data, error: loadError, isLoading, mutate: reload } = useCatalogue(true);
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState<"all" | "instagram" | "facebook" | "youtube">("all");
  // null = every category; otherwise a categoryKey() from categoryTabs().
  const [cat, setCat] = useState<string | null>(null);
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

  // Accounts that carry this format but are left out by a choice the client made: the campaign
  // type (no entertainment price) or the song option (no add-on). Said out loud, never silent.
  const hidden = useMemo(() => {
    let byType = 0;
    let bySong = 0;
    for (const a of data ?? []) {
      const o = a.offers.find((x) => x.format === format);
      if (!o || offerPrice(o, campaign)) continue;
      const base = campaign.campaignType === "entertainment" ? o.entertainmentPricePaise : o.pricePaise;
      if (base == null) byType++;
      else bySong++;
    }
    return { byType, bySong };
  }, [data, format, campaign]);

  const offerIds = useMemo(() => new Set(offers.map((a) => a.offer.rateCardId)), [offers]);
  // Picked earlier but no longer offered (withdrawn, or the type/format/song changed since).
  const gone = data ? campaign.items.filter((i) => picked.has(i.rateCardId) && !offerIds.has(i.rateCardId)) : [];

  // The rows on the selected platform tab. Category counts are per platform and, like the platform
  // counts, ignore the search box.
  const onPlatform = useMemo(
    () => offers.filter((a) => platform === "all" || a.platform === platform),
    [offers, platform],
  );
  const catTabs = useMemo(() => categoryTabs(onPlatform), [onPlatform]);
  // Labels come from every account for this format, so a category reads the same on each platform tab.
  const labelOf = useMemo(() => new Map(categoryTabs(offers).map((t) => [t.key, t.label])), [offers]);
  // A category picked on another platform or format may not exist here: then show everything.
  const activeCat = cat !== null && catTabs.some((t) => t.key === cat) ? cat : null;

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase().replace(/^@/, "");
    return inCategory(onPlatform, activeCat)
      .filter((a) => !term || a.name.toLowerCase().includes(term) || (a.username ?? "").toLowerCase().includes(term) || matchesCategory(a.category, term))
      .sort((a, b) =>
        sort === "price" ? a.price.total - b.price.total :
        sort === "engagement" ? (b.engagementRatePct ?? -1) - (a.engagementRatePct ?? -1) :
        (b.followers ?? 0) - (a.followers ?? 0),
      );
  }, [onPlatform, activeCat, q, sort]);

  const selected = offers.filter((a) => picked.has(a.offer.rateCardId));
  const total = selected.reduce((s, a) => s + a.price.total, 0);
  const withAudio = campaign.audioIntegration && format === "reel";
  const reach = selected.reduce((s, a) => s + (a.followers ?? 0), 0);
  const counts = { all: offers.length, instagram: 0, facebook: 0, youtube: 0 } as Record<string, number>;
  for (const a of offers) counts[a.platform]++;
  // Only platforms that actually have accounts get a tab (there are no YouTube rate cards today).
  const tabs = (["all", "instagram", "facebook", "youtube"] as const).filter((p) => p === "all" || counts[p] > 0 || platform === p);

  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const save = async () => {
    setError(null);
    const ids = [...picked].filter((id) => offerIds.has(id));
    if (ids.length === 0) return setError("Pick at least one account.");
    setBusy(true);
    try {
      onSaved(await mutateJson<Campaign>(`/client/campaigns/${campaign.id}/items`, "PUT", { rateCardIds: ids }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // "3 more accounts don't …" when some are listed; "3 accounts don't …" when none are.
  const hiddenLead = (n: number) => `${n}${offers.length > 0 ? " more" : ""} ${n === 1 ? "account doesn't" : "accounts don't"}`;
  // Ticks are local until Continue — save them before leaving so the detour doesn't drop them.
  const leave = async (s: "info" | "creative") => {
    if (!onEdit) return;
    setError(null);
    const ids = [...picked].filter((id) => offerIds.has(id));
    const before = new Set(campaign.items.map((i) => i.rateCardId));
    const changed = ids.length !== before.size || ids.some((id) => !before.has(id));
    if (ids.length === 0 || !changed) return onEdit(s);
    setBusy(true);
    try {
      onEdit(s, await mutateJson<Campaign>(`/client/campaigns/${campaign.id}/items`, "PUT", { rateCardIds: ids }));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const jump = (s: "info" | "creative", label: string) =>
    onEdit ? (
      <button type="button" disabled={busy} className="underline font-semibold text-ink-2 hover:text-ink disabled:opacity-60" onClick={() => leave(s)}>{label}</button>
    ) : (
      label
    );
  const term = q.trim();
  const emptyText =
    offers.length === 0
      ? hidden.byType + hidden.bySong > 0
        ? `No account takes a ${fmt} with the choices you made so far.`
        : `No accounts are open for ${fmt} posts yet. Try another format, or contact us.`
      : term
        ? `No accounts match “${term}”.`
        : platform !== "all"
          ? `No ${PLATFORM_LABEL[platform]} accounts carry a ${fmt} for this campaign.`
          : "No accounts match your search.";

  return (
    // grid-cols-1 = minmax(0, 1fr): a bare `grid` sizes its one column to the widest content, so a
    // long account name (truncate = nowrap) pushed the card — and the price — off a phone screen.
    <div className="grid grid-cols-1 gap-4 pb-24">
      <Card
        title="Choose accounts"
        sub={`Accounts on our network that carry a ${fmt}. Prices are per account, for ${CAMPAIGN_TYPE_LABELS[campaign.campaignType].toLowerCase()}${withAudio ? ", including the song" : ""}.`}
      >
        {renderPending(campaign) && <p role="status" className="text-[12.5px] text-ink-3 mb-3">Your preview is being prepared in the background — pick your accounts meanwhile.</p>}
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
          {tabs.map((p) => (
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

        {/* Category tabs appear once there are two or more to choose between: one category is just the list. */}
        {catTabs.length > 1 && (
          <div className="mb-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-1.5">Category</p>
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Categories">
              <button
                type="button"
                role="tab"
                aria-selected={activeCat === null}
                onClick={() => setCat(null)}
                className={`h-8 px-3 rounded-full text-[12.5px] font-semibold border-2 ${activeCat === null ? "bg-indigo text-white border-indigo" : "border-ink/15 text-ink-2"}`}
              >
                All <span className="opacity-70 tabular-nums">{onPlatform.length}</span>
              </button>
              {catTabs.map((t) => (
                <button
                  key={t.key === "" ? "(uncategorised)" : t.key}
                  type="button"
                  role="tab"
                  aria-selected={activeCat === t.key}
                  onClick={() => setCat(t.key)}
                  className={`max-w-full min-w-0 h-8 px-3 rounded-full text-[12.5px] font-semibold border-2 ${activeCat === t.key ? "bg-indigo text-white border-indigo" : "border-ink/15 text-ink-2"}`}
                >
                  <span className="block truncate">{labelOf.get(t.key) ?? t.label} <span className="opacity-70 tabular-nums">{t.count}</span></span>
                </button>
              ))}
            </div>
          </div>
        )}

        {data && (hidden.byType > 0 || hidden.bySong > 0) && (
          <div className="mb-4 grid gap-1 text-[12.5px] text-ink-3">
            {hidden.byType > 0 && (
              <p>
                {hiddenLead(hidden.byType)} take {campaign.campaignType === "entertainment" ? "entertainment" : "brand"} campaigns — change the campaign type in {jump("info", "Details")} to see {hidden.byType === 1 ? "it" : "them"}.
              </p>
            )}
            {hidden.bySong > 0 && (
              <p>
                {hiddenLead(hidden.bySong)} offer songs — turn the song off in {jump("creative", "Content")} to see {hidden.bySong === 1 ? "it" : "them"}.
              </p>
            )}
          </div>
        )}
        {loadError && (
          <ErrorBanner>
            Couldn&apos;t load the accounts.{" "}
            <button type="button" className="underline font-semibold" onClick={() => reload()}>Try again</button>
          </ErrorBanner>
        )}
        {isLoading && <div className="text-[13px] text-ink-3 py-6 text-center">Loading accounts…</div>}
        {data && visible.length === 0 && <div className="text-[13px] text-ink-3 py-8 text-center">{emptyText}</div>}

        {gone.length > 0 && (
          <ul className="grid gap-2 mb-2" aria-label="No longer available">
            {gone.map((i) => (
              <li key={i.id} className="flex items-center gap-3 border-2 border-ink/10 px-3 py-2.5 opacity-60">
                <PlatformDot platform={i.platform} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-semibold text-ink truncate">{i.accountName}</span>
                  <span className="block text-[12px] text-ink-3">No longer available — it will be removed when you continue</span>
                </span>
              </li>
            ))}
          </ul>
        )}

        <ul className="grid grid-cols-1 gap-2">
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
                        <a href={a.profileUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="p-2 -m-2 text-ink-3 hover:text-ink shrink-0" aria-label={`Open ${a.name}`}>
                          <Icon.External size={12} />
                        </a>
                      )}
                    </div>
                    <div className="text-[12px] text-ink-3 flex flex-wrap gap-x-3 gap-y-0.5">
                      {a.username && <span className="truncate max-w-[160px]">@{a.username}</span>}
                      <span>{PLATFORM_LABEL[a.platform]}</span>
                      {a.category && <span>{a.category}</span>}
                      {a.linkDeliveryMinutes && <span title="About how long after posting the link is ready.">Link in ~{a.linkDeliveryMinutes.min}–{a.linkDeliveryMinutes.max} min after posting</span>}
                    </div>
                    <div className="sm:hidden text-[11px] text-ink-3 tabular-nums">
                      {compact(a.followers)} followers · {a.engagementRatePct != null ? `${a.engagementRatePct}%` : "—"} engagement
                    </div>
                  </div>
                  <div className="hidden sm:grid grid-cols-2 gap-x-5 text-right shrink-0">
                    <span className="text-[13px] font-semibold text-ink tabular-nums">{compact(a.followers)}</span>
                    <span className="text-[13px] font-semibold text-ink tabular-nums" title="Engagements per view over the last 28 days">{a.engagementRatePct != null ? `${a.engagementRatePct}%` : "—"}</span>
                    <span className="text-[10.5px] uppercase tracking-wider text-ink-3">Followers</span>
                    <span className="text-[10.5px] uppercase tracking-wider text-ink-3">Engagement</span>
                  </div>
                  <div className="text-right shrink-0 w-[80px] sm:w-[96px]">
                    <div className="text-[14px] font-bold text-ink tabular-nums">{rupees(a.price.total)}</div>
                    {a.price.addon > 0 && <div className="hidden sm:block text-[10.5px] text-ink-3 tabular-nums" title="Base price + the song">incl. {rupees(a.price.addon)} for the song</div>}
                  </div>
                </label>
              </li>
            );
          })}
        </ul>

      </Card>

      <div className="fixed bottom-0 left-0 right-0 lg:left-auto lg:right-6 lg:bottom-6 z-20 bg-surface border-t-2 lg:border-2 border-ink lg:rounded-2xl shadow-hard-ink px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {error && <div role="alert" className="basis-full order-first text-[12px] text-danger font-medium">{error}</div>}
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-ink-3">{selected.length} account{selected.length === 1 ? "" : "s"} · {compact(reach)} followers</div>
          <div className="text-[17px] font-bold text-ink tabular-nums">{rupees(total)} <span className="text-[12px] font-medium text-ink-3">+ GST</span></div>
        </div>
        <Button variant="ink" onClick={save} disabled={busy || selected.length === 0} aria-live="polite" iconRight={<Icon.ArrowRight size={15} />}>
          {busy ? "Saving…" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
