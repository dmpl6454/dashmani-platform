"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import {
  ArrowLeft, Receipt, DollarSign, TrendingUp, Info, Activity, Server, AlertTriangle, Power,
} from "lucide-react";
import { useCostSheet, useOpenAiBilling, type ProviderCost, type OpenAiBilling } from "@/lib/hooks/use-cost-sheet";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { apiFetch } from "@/lib/api";

const usd = (n: number) =>
  n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : "$0.00";
const num = (n: number) => n.toLocaleString();

// Providers that bill in dollars vs. those free within a quota (call-volume only).
const PAID = new Set(["openai", "gemini", "anthropic"]);
const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI", gemini: "Gemini", anthropic: "Anthropic (Claude)",
  meta: "Meta Graph (IG/FB)", youtube: "YouTube Data", deepseek: "DeepSeek",
};
const PROVIDER_DOT: Record<string, string> = { openai: "var(--hx-00D7A0)", gemini: "var(--hx-6EB2FF)", anthropic: "var(--hx-E9BD62)", deepseek: "var(--hx-9B7EDE)" };
// The ONLY active LLM going forward is Gemini (entity-extraction switched to
// Gemini-only on 2026-06-29 — measured cheapest by far). OpenAI + Anthropic rows
// are HISTORICAL: real spend that already happened, kept visible for honesty, but
// no NEW cost accrues from them. We label them "historical" rather than hide them
// (hiding real spend would itself be a data lie + would mismatch the authoritative
// OpenAI billing panel). If a provider is ever re-activated, drop it from this set.
const HISTORICAL_PROVIDERS = new Set(["openai", "anthropic"]);

const RANGES = [7, 14, 30, 90] as const;
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

const CARD = "rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.3)]";
const TH = "text-[10.5px] font-semibold tracking-[.08em] uppercase text-ds-t3 pb-3 border-b border-[color:var(--hx-1A2C38)] whitespace-nowrap";
const TD = "py-[13px] border-b border-[color:var(--hx-132430)] text-[13.5px] tabular-nums whitespace-nowrap";

function CardTitle({ icon, color, children, note }: { icon: React.ReactNode; color: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 flex-wrap mb-4">
      <span className="flex" style={{ color }}>{icon}</span>
      <span className="text-[15px] font-semibold text-ds-text">{children}</span>
      {note && <span className="ml-auto text-[11.5px] text-ds-t3">{note}</span>}
    </div>
  );
}

export default function ApiCostsPage() {
  usePageTitle("API Costs");
  const [days, setDays] = useState<number>(30);
  const { data, isLoading } = useCostSheet(days);
  const d = (data as any)?.data;

  // Enrichment kill-switch — the ONLY paid-per-token step in the social-insights
  // pipeline (follower sync, engagement-metric polling, and caption harvesting are
  // all free Graph/scraper calls and keep running regardless). While the org is low
  // on API credits, an admin can pause just this spend here, without a deploy.
  const [enrichmentEnabled, setEnrichmentEnabled] = useState<boolean | null>(null);
  const [enrichmentState, setEnrichmentState] = useState<"idle" | "loading" | "error">("idle");
  const [enrichmentError, setEnrichmentError] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ enabled: boolean }>("/admin/enrichment/toggle")
      .then((res) => {
        if (!cancelled) setEnrichmentEnabled((res as any)?.data?.enabled ?? true);
      })
      .catch((err: any) => {
        // Show why the switch is unavailable instead of leaving it silently disabled.
        if (cancelled) return;
        setEnrichmentError(err?.message || "Failed to load enrichment status. Reload the page to try again.");
        setEnrichmentState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleToggleEnrichment() {
    if (enrichmentEnabled === null || enrichmentState === "loading") return;
    const next = !enrichmentEnabled;
    setEnrichmentState("loading");
    setEnrichmentError("");
    try {
      const res = await apiFetch<{ enabled: boolean }>("/admin/enrichment/toggle", {
        method: "PUT",
        body: JSON.stringify({ enabled: next }),
      });
      setEnrichmentEnabled((res as any)?.data?.enabled ?? next);
      setEnrichmentState("idle");
    } catch (err: any) {
      setEnrichmentError(err?.message || "Failed to update enrichment toggle.");
      setEnrichmentState("error");
    }
  }

  // Hard daily spend ceiling (DeepSeek extraction auto-pauses once today's spend
  // hits this) — surfaced next to the kill-switch so an admin can throttle spend
  // without turning enrichment off entirely.
  const [ceiling, setCeiling] = useState<number | null>(null);
  const [todaySpend, setTodaySpend] = useState<number | null>(null);
  const [ceilingInput, setCeilingInput] = useState("");
  const [ceilingState, setCeilingState] = useState<"idle" | "loading" | "error">("idle");
  const [ceilingError, setCeilingError] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ ceilingUsd: number; todaySpendUsd: number }>("/admin/extraction/spend-ceiling")
      .then((res) => {
        if (cancelled) return;
        const data = (res as any)?.data;
        setCeiling(data?.ceilingUsd ?? null);
        setTodaySpend(data?.todaySpendUsd ?? null);
        setCeilingInput(data?.ceilingUsd != null ? String(data.ceilingUsd) : "");
      })
      .catch((err: any) => {
        if (cancelled) return;
        setCeilingError(err?.message || "Failed to load spend ceiling. Reload the page to try again.");
        setCeilingState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveCeiling() {
    const v = Number(ceilingInput);
    if (!Number.isFinite(v) || v < 0) return;
    setCeilingState("loading");
    setCeilingError("");
    try {
      const res = await apiFetch<{ ceilingUsd: number }>("/admin/extraction/spend-ceiling", {
        method: "PUT",
        body: JSON.stringify({ ceilingUsd: v }),
      });
      setCeiling((res as any)?.data?.ceilingUsd ?? v);
      setCeilingState("idle");
    } catch (err: any) {
      setCeilingError(err?.message || "Failed to update spend ceiling.");
      setCeilingState("error");
    }
  }

  // Authoritative OpenAI billed cost (Costs API) — the source of truth when the
  // admin key is configured. Combined across the shared key (both apps).
  const { data: billingResp } = useOpenAiBilling(days);
  const billing: OpenAiBilling | undefined = (billingResp as any)?.data;
  const billingAvailable = !!billing?.available;

  const total: number = d?.totalCostUsd ?? 0;
  const projMonthly: number = d?.projectedMonthlyUsd ?? 0;
  const projDaily: number = d?.projectedDailyUsd ?? 0;
  const byProvider: ProviderCost[] = d?.byProvider ?? [];
  const byOperation: Array<{ provider: string; operation: string; calls: number; costUsd: number }> = d?.byOperation ?? [];
  const daily: Array<{ date: string; costUsd: number; calls: number }> = d?.daily ?? [];

  // Horizon-honesty fields (optional on older API responses).
  const trackingSince: string | null = d?.trackingSince ?? null;
  const fullWindow: boolean = d?.fullWindow ?? true;
  const effectiveDays: number = d?.effectiveDays ?? days;
  // Projection is only trustworthy at steady state. While a backfill backlog drains,
  // the cron runs at catch-up speed → any forward number would overstate. Default
  // true so older API responses (no flag) behave as before.
  const projectionReliable: boolean = d?.projectionReliable ?? true;
  const pendingBacklog: number = d?.pendingExtractionBacklog ?? 0;
  const fmtDay = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
  // If tracking is younger than the selected window, the headline covers only the
  // real span — say so instead of implying the full N days.
  const coverageLabel = fullWindow
    ? `Spent in the last ${days} days`
    : `Spent since tracking started (${fmtDay(trackingSince)}, ~${effectiveDays < 1 ? "<1" : Math.round(effectiveDays)} day${Math.round(effectiveDays) === 1 ? "" : "s"})`;

  const paidProviders = byProvider.filter((p) => PAID.has(p.provider));
  const freeProviders = byProvider.filter((p) => !PAID.has(p.provider));

  // Daily bars (drawn as plain bars like the mockup).
  const bars = daily.map((x) => ({
    label: new Date(x.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    cost: x.costUsd,
  }));
  const maxCost = Math.max(0, ...bars.map((b) => b.cost));
  const top = maxCost > 0 ? (maxCost >= 1 ? Math.ceil(maxCost) : Math.ceil(maxCost * 100) / 100) : 1;
  const yTicks = [1, 0.75, 0.5, 0.25, 0].map((f) => {
    const v = top * f;
    return v === 0 ? "$0" : `$${+v.toFixed(v >= 1 ? 2 : 3)}`;
  });
  // Up to six evenly spaced date labels under the bars.
  const tickCount = Math.min(6, bars.length);
  const xTickIdx: number[] =
    tickCount <= 1 ? [0] : Array.from({ length: tickCount }, (_v, i: number) => Math.round(((bars.length - 1) * i) / (tickCount - 1)));

  const ceilPct = ceiling && ceiling > 0 && todaySpend != null ? Math.min(100, (todaySpend / ceiling) * 100) : 0;

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="pt-[26px]">
        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-[13px] text-ds-t2 hover:text-ds-text">
          <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
        </Link>
      </section>
      <section className="flex items-center justify-between gap-4 flex-wrap pt-3.5 pb-[22px]">
        <div className="flex items-center gap-3.5 min-w-0 flex-[1_1_360px]">
          <span className="h-[46px] w-[46px] rounded-[13px] bg-[rgba(233,189,98,.12)] border border-[rgba(233,189,98,.4)] text-ds-gold grid place-items-center shrink-0">
            <Receipt className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">API Costs</h1>
            <p className="mt-1 text-[13.5px] text-ds-t2 [text-wrap:pretty]">
              What every AI &amp; data API is costing — so you know how much credit to top up.
            </p>
          </div>
        </div>
        {/* Window pills */}
        <div className="flex gap-1 p-[5px] rounded-full bg-ds-inset border border-ds-line2" role="group" aria-label="Window">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={days === r}
              onClick={() => setDays(r)}
              className={`h-[34px] px-4 rounded-full text-[13px] font-semibold transition-colors ${days === r ? "bg-ds-gold text-[color:var(--hx-060D14)]" : "text-ds-t2 hover:text-ds-text"}`}
            >
              {r}d
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3.5">
        {/* Enrichment kill-switch */}
        <div className={`${CARD} px-[22px] py-5 flex items-start gap-3.5`}>
          <span className="h-[38px] w-[38px] rounded-[11px] grid place-items-center shrink-0 bg-[rgba(251,146,60,.12)] text-[color:var(--hx-FB923C)]">
            <Power className="h-4 w-4" />
          </span>
          <div className="flex-1 min-w-0 max-w-[720px]">
            <div className="text-[14px] font-semibold text-ds-text">Caption enrichment (LLM entity tagging)</div>
            <p className="mt-[5px] text-[12.5px] leading-[1.55] text-ds-t2 [text-wrap:pretty]">
              Turn off to stop paid LLM calls immediately. Follower sync, engagement metrics, and
              caption harvesting keep running — only entity tagging pauses.
            </p>
            {enrichmentState === "error" ? (
              <div className="mt-2.5 text-[12px] font-semibold text-[color:var(--hx-FB7185)]">{enrichmentError}</div>
            ) : enrichmentEnabled !== null ? (
              <div className={`mt-2.5 text-[12px] font-semibold ${enrichmentEnabled ? "text-ds-teal" : "text-[color:var(--hx-FB7185)]"}`}>
                ● {enrichmentEnabled ? "Enabled" : "Paused"}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enrichmentEnabled ?? false}
            aria-label="Caption enrichment"
            aria-live="polite"
            disabled={enrichmentEnabled === null || enrichmentState === "loading"}
            onClick={handleToggleEnrichment}
            className={`relative h-7 w-[50px] shrink-0 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${enrichmentEnabled ? "bg-[color:var(--hx-00B386)]" : "bg-[color:var(--hx-2A3B48)]"}`}
          >
            <span
              className={`absolute top-[3px] h-[22px] w-[22px] rounded-full bg-ds-text shadow-[0_2px_6px_rgba(0,0,0,.4)] transition-[left] ${enrichmentEnabled ? "left-[25px]" : "left-[3px]"}`}
            />
          </button>
        </div>

        {/* Daily spend ceiling — hard auto-pause once today's DeepSeek spend hits this. */}
        <div className={`${CARD} px-[22px] py-5 flex items-start gap-3.5 flex-wrap`}>
          <span className="h-[38px] w-[38px] rounded-[11px] grid place-items-center shrink-0 bg-[rgba(110,178,255,.12)] text-[color:var(--hx-6EB2FF)]">
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="flex-[1_1_320px] min-w-0 max-w-[720px]">
            <div className="text-[14px] font-semibold text-ds-text">Daily spend ceiling (DeepSeek extraction)</div>
            <p className="mt-[5px] text-[12.5px] leading-[1.55] text-ds-t2 [text-wrap:pretty]">
              Today: <b className="text-ds-text font-semibold">{todaySpend != null ? usd(todaySpend) : "…"}</b> of{" "}
              <b className="text-ds-text font-semibold">{ceiling != null ? usd(ceiling) : "…"}</b> — extraction
              auto-pauses for the rest of the UTC day once today&rsquo;s spend hits the ceiling.
            </p>
            {ceiling != null && todaySpend != null && (
              <div className="mt-2.5 h-1.5 rounded-[3px] bg-[color:var(--hx-132430)] overflow-hidden">
                <div className="h-full rounded-[3px]" style={{ width: `${ceilPct}%`, background: ceilPct > 85 ? "var(--hx-FB7185)" : "var(--hx-6EB2FF)" }} />
              </div>
            )}
            {ceilingState === "error" && <p className="mt-2 text-[12px] text-[color:var(--hx-FB7185)]">{ceilingError}</p>}
          </div>
          <div className="flex items-center gap-2.5 shrink-0 self-center ml-auto">
            <label htmlFor="spend-ceiling-input" className="text-[12px] text-ds-t3 whitespace-nowrap">Ceiling (USD)</label>
            <input
              id="spend-ceiling-input"
              value={ceilingInput}
              onChange={(e) => setCeilingInput(e.target.value)}
              inputMode="decimal"
              disabled={ceilingState === "loading"}
              className="w-[120px] h-[38px] px-3.5 rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13.5px] outline-none focus:border-[rgba(233,189,98,.6)] disabled:opacity-50"
            />
            <button
              type="button"
              onClick={saveCeiling}
              disabled={ceilingState === "loading"}
              className="h-[38px] px-[18px] rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13px] font-bold hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-50"
            >
              {ceilingState === "loading" ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </section>

      {isLoading && !d && (
        <div className={`${CARD} mt-3.5 p-8 text-center text-[13px] text-ds-t3`}>Loading cost data…</div>
      )}

      {d && (
        <>
          {/* AUTHORITATIVE — OpenAI billed cost (Costs API). The source of truth when
              the admin key is set. Shown ABOVE our estimate so the real number leads. */}
          {billingAvailable && (
            <section className="mt-3.5 rounded-[16px] border border-[rgba(0,215,160,.35)] bg-[linear-gradient(180deg,rgba(0,215,160,.06),rgba(0,215,160,.01))] shadow-[0_12px_32px_rgba(0,0,0,.3)] px-6 py-[22px]">
              <div className="flex items-center gap-2.5 flex-wrap">
                <DollarSign className="h-4 w-4 text-ds-teal" />
                <span className="text-[15px] font-semibold text-ds-text">OpenAI — Billed (authoritative)</span>
                <span className="ml-auto text-[11.5px] text-ds-t3 whitespace-nowrap">official Costs API</span>
              </div>
              <div className="flex items-end gap-6 flex-wrap mt-3.5">
                <span className="text-[40px] font-bold tracking-[-.04em] leading-none tabular-nums text-ds-text">{usd(billing!.totalUsd)}</span>
                <p className="flex-[1_1_320px] text-[12.5px] leading-[1.55] text-ds-t2">
                  Exact billed spend over the last {days} days{billing!.since ? `, since ${fmtDay(billing!.since)}` : ""}.
                  This is the <b className="text-ds-text font-semibold">real invoice figure</b> — caching-aware, not an estimate.
                </p>
              </div>
              <div className="flex gap-2 items-start mt-4 pt-3.5 border-t border-[rgba(0,215,160,.18)] text-[12px] leading-[1.55] text-ds-t2">
                <AlertTriangle className="h-[13px] w-[13px] text-ds-gold shrink-0 mt-0.5" />
                <span>
                  <b className="text-ds-text font-semibold">Combined total</b> — the OpenAI key is shared with the other app
                  (&ldquo;Post Automation&rdquo;), so this covers <b className="text-ds-text font-semibold">both apps</b>. {billing!.lagNote} Our token-based
                  figures below are an internal estimate for this app&rsquo;s share + the forward projection.
                </span>
              </div>
            </section>
          )}

          {/* Headline cards */}
          <section className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 mt-3.5">
            {[
              { v: usd(total), l: coverageLabel, c: "var(--hx-FB923C)", Icon: DollarSign },
              {
                v: projectionReliable ? usd(projMonthly) : "—",
                l: projectionReliable ? "Projected next 30 days (forward run-rate, excl. one-time backfill)" : "Forward projection pending — backfill still draining",
                c: "var(--hx-6EB2FF)",
                Icon: TrendingUp,
              },
              {
                v: projectionReliable ? usd(projDaily) : "—",
                l: projectionReliable ? "Forward daily run-rate (steady state)" : "Available once at steady state",
                c: "var(--hx-00D7A0)",
                Icon: Activity,
              },
            ].map(({ v, l, c, Icon }) => (
              <div key={l} className={`${CARD} px-[22px] py-5 flex flex-col gap-3.5 min-w-0`}>
                <span className="h-9 w-9 rounded-[10px] grid place-items-center" style={{ background: rgba(c, 0.12), color: c }}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="text-[34px] font-bold tracking-[-.04em] leading-none tabular-nums text-ds-text">{v}</span>
                <span className="text-[12.5px] leading-[1.45] text-ds-t2 [text-wrap:pretty]">{l}</span>
              </div>
            ))}
          </section>

          {/* Top-up guidance + authoritative-source / shared-key disclosure */}
          <section className="grid gap-3.5 mt-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))]">
            <div className="flex gap-3 items-start px-[18px] py-4 rounded-[14px] bg-[rgba(110,178,255,.06)] border border-[rgba(110,178,255,.25)] text-[12.5px] leading-[1.6] text-[color:var(--hx-C9D2DC)]">
              <Info className="h-[15px] w-[15px] text-[color:var(--hx-6EB2FF)] shrink-0 mt-0.5" />
              <span>
                {projectionReliable ? (
                  <>
                    To cover the next month, keep at least <b className="text-ds-text">{usd(projMonthly)}</b> of credit across the paid AI providers
                    (OpenAI is primary; Gemini &amp; Anthropic are fallbacks). This is the <b className="text-ds-text font-semibold">forward steady-state</b> rate
                    (the daily new-link inflow) — it excludes the one-time historical backfill, which won&rsquo;t recur, so going-forward cost is well below total spend-to-date.{" "}
                  </>
                ) : (
                  <>
                    A forward credit estimate isn&rsquo;t shown yet because the system is still <b className="text-ds-text font-semibold">working through a one-time enrichment backlog</b>{" "}
                    ({pendingBacklog.toLocaleString()} captions left to tag) — the extraction cron is running at catch-up speed, well above the normal daily rate,
                    so any projection now would overstate. It&rsquo;ll appear once the backlog clears (~a day) and the true forward rate can be measured. In the meantime, keep a comfortable buffer of OpenAI credit.{" "}
                  </>
                )}
                Meta Graph and YouTube are <b className="text-ds-text font-semibold">free within their quotas</b> — they show call volume, not dollars, so you can spot a quota cliff before it bites.
              </span>
            </div>
            <div className="flex gap-3 items-start px-[18px] py-4 rounded-[14px] bg-[rgba(233,189,98,.05)] border border-[rgba(233,189,98,.25)] text-[12.5px] leading-[1.6] text-[color:var(--hx-C9D2DC)]">
              <AlertTriangle className="h-[15px] w-[15px] text-ds-gold shrink-0 mt-0.5" />
              <span className="flex flex-col gap-2">
                <span>
                  <b className="text-ds-text">This figure is measured precisely going forward</b> (real per-call tokens, since {fmtDay(trackingSince)}) — it is the trustworthy number for predicting future top-ups. For spend <b className="text-ds-text font-semibold">before</b> that, the provider console is authoritative; we don&rsquo;t show a reconstructed dollar guess because it over-counted high-volume days.
                </span>
                <span>
                  <b className="text-ds-text">⚠️ The OpenAI key is shared</b> with another project (&ldquo;Post Automation&rdquo;), so OpenAI&rsquo;s project total (e.g. <b className="text-ds-text font-semibold">~$108 for June</b>) covers <b className="text-ds-text font-semibold">both apps combined</b> — neither this sheet nor OpenAI&rsquo;s project view isolates this app&rsquo;s spend alone. To get an exact, isolated figure, give this app its <b className="text-ds-text font-semibold">own OpenAI API key / project</b>; then OpenAI&rsquo;s dashboard breaks it out directly.
                </span>
                <span className="text-ds-t3">
                  Authoritative billed totals: OpenAI <span className="font-mono">platform.openai.com/usage</span> · Anthropic <span className="font-mono">console.anthropic.com</span> · Google AI Studio. {!fullWindow && <>Precise in-app tracking began {fmtDay(trackingSince)}.</>}
                </span>
              </span>
            </div>
          </section>

          {/* Daily spend chart */}
          {bars.length > 0 && (
            <section className={`${CARD} mt-3.5 px-6 py-[22px]`}>
              <CardTitle icon={<DollarSign className="h-4 w-4" />} color="var(--hx-E9BD62)" note={fullWindow ? `${usd(total)} over ${days} days` : `${usd(total)} since ${fmtDay(trackingSince)}`}>
                Daily Spend (paid providers)
              </CardTitle>
              <div className="grid grid-cols-[44px_minmax(0,1fr)] gap-2.5 h-[230px]">
                <div className="flex flex-col justify-between pb-[22px] text-[11px] text-ds-t3 text-right tabular-nums">
                  {yTicks.map((y, i) => <span key={i}>{y}</span>)}
                </div>
                <div className="relative flex flex-col min-w-0">
                  <div className="absolute inset-x-0 top-0 bottom-[22px] flex flex-col justify-between pointer-events-none" aria-hidden="true">
                    {yTicks.map((_, i) => <span key={i} className="h-0 border-t border-dashed border-[color:var(--hx-1A2C38)]" />)}
                  </div>
                  <div
                    className="relative flex-1 flex items-end"
                    style={{ gap: bars.length > 30 ? 2 : bars.length > 14 ? 4 : 8 }}
                    role="img"
                    aria-label={`Daily paid spend over the last ${days} days`}
                  >
                    {bars.map((b, i) => (
                      <div
                        key={i}
                        title={`${b.label} · ${usd(b.cost)}`}
                        className="flex-1 min-h-[2px] rounded-t-[4px] bg-[linear-gradient(180deg,var(--hx-E9BD62),rgba(233,189,98,.45))] hover:bg-[color:var(--hx-F4D58C)]"
                        style={{ height: `${top > 0 ? (b.cost / top) * 100 : 0}%` }}
                      />
                    ))}
                  </div>
                  <div className="h-[22px] flex justify-between items-end text-[11px] text-ds-t3">
                    {xTickIdx.map((i) => <span key={i} className="whitespace-nowrap">{bars[i]?.label}</span>)}
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Paid providers breakdown */}
          <section className={`${CARD} mt-3.5 px-6 py-[22px]`}>
            <CardTitle icon={<DollarSign className="h-4 w-4" />} color="var(--hx-E9BD62)" note="Gemini is the only active LLM — OpenAI/Anthropic are historical">
              Paid AI Providers
            </CardTitle>
            {paidProviders.length === 0 ? (
              <p className="text-[12.5px] text-ds-t3">No paid-provider usage recorded in this window.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse">
                  <thead>
                    <tr>
                      <th className={`${TH} text-left`}>Provider</th>
                      <th className={`${TH} text-right`}>Calls</th>
                      <th className={`${TH} text-right`}>Input Tokens</th>
                      <th className={`${TH} text-right`}>Output Tokens</th>
                      <th className={`${TH} text-right`}>Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paidProviders.map((p) => {
                      const historical = HISTORICAL_PROVIDERS.has(p.provider);
                      return (
                        <tr key={p.provider} className={historical ? "opacity-70" : ""}>
                          <td className={`${TD} font-semibold text-ds-text`}>
                            <span className="inline-flex items-center gap-2.5">
                              <i className="h-2 w-2 rounded-full" style={{ background: PROVIDER_DOT[p.provider] ?? "var(--hx-A7B3C2)" }} />
                              {PROVIDER_LABEL[p.provider] ?? p.provider}
                              {historical && (
                                <span
                                  className="inline-flex items-center h-5 px-2 rounded-full bg-[color:var(--hx-132430)] border border-ds-line2 text-ds-t3 text-[10.5px] font-semibold"
                                  title="No longer used — extraction switched to Gemini-only on 29 Jun 2026. This is past spend, kept for the record; no new cost accrues."
                                >
                                  historical
                                </span>
                              )}
                            </span>
                          </td>
                          <td className={`${TD} text-right text-ds-t5`}>{num(p.calls)}</td>
                          <td className={`${TD} text-right text-ds-t2`}>{num(p.inputTokens)}</td>
                          <td className={`${TD} text-right text-ds-t2`}>{num(p.outputTokens)}</td>
                          <td className={`${TD} text-right font-bold text-ds-gold`}>{usd(p.costUsd)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {(freeProviders.length > 0 || byOperation.length > 0) && (
            <section className="grid gap-3.5 mt-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">
              {/* Free-within-quota providers (call volume) */}
              {freeProviders.length > 0 && (
                <div className={`${CARD} px-6 py-[22px] min-w-0`}>
                  <CardTitle icon={<Server className="h-4 w-4" />} color="var(--hx-00D7A0)">Free within Quota — Call Volume</CardTitle>
                  <div className="text-[11.5px] text-ds-t3 -mt-2 mb-3.5">no dollar cost; watch for quota limits</div>
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className={`${TH} text-left`}>Provider</th>
                        <th className={`${TH} text-right`}>Calls / Units</th>
                      </tr>
                    </thead>
                    <tbody>
                      {freeProviders.map((p) => (
                        <tr key={p.provider}>
                          <td className={`${TD} font-semibold text-ds-text`}>{PROVIDER_LABEL[p.provider] ?? p.provider}</td>
                          <td className={`${TD} text-right text-ds-t5`}>{num(p.calls)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Per-operation breakdown */}
              {byOperation.length > 0 && (
                <div className={`${CARD} px-6 py-[22px] min-w-0`}>
                  <CardTitle icon={<Activity className="h-4 w-4" />} color="var(--hx-6EB2FF)">By Operation</CardTitle>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[400px] border-collapse">
                      <thead>
                        <tr>
                          <th className={`${TH} text-left`}>Operation</th>
                          <th className={`${TH} text-left`}>Provider</th>
                          <th className={`${TH} text-right`}>Calls</th>
                          <th className={`${TH} text-right`}>Cost</th>
                        </tr>
                      </thead>
                      <tbody>
                        {byOperation.map((op) => (
                          <tr key={`${op.provider}:${op.operation}`}>
                            <td className={`${TD} font-mono text-[12.5px] text-ds-text`}>{op.operation || "—"}</td>
                            <td className={`${TD} text-ds-t2`}>{PROVIDER_LABEL[op.provider] ?? op.provider}</td>
                            <td className={`${TD} text-right text-ds-t5`}>{num(op.calls)}</td>
                            <td className={`${TD} text-right font-semibold text-ds-gold`}>{usd(op.costUsd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          )}

          {total === 0 && (
            <p className="mt-3.5 text-[12.5px] text-ds-t3">
              No spend recorded yet for this window. Costs accrue as the extraction cron and AI generators run —
              check back after the next cycle.
            </p>
          )}
        </>
      )}
    </div>
  );
}
