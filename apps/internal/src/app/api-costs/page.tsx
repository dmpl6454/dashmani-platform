"use client";
import { useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, Receipt, DollarSign, TrendingUp, Info, Activity, Server, AlertTriangle,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { useCostSheet, type ProviderCost } from "@/lib/hooks/use-cost-sheet";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const usd = (n: number) =>
  n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : "$0.00";
const num = (n: number) => n.toLocaleString();

// Providers that bill in dollars vs. those free within a quota (call-volume only).
const PAID = new Set(["openai", "gemini", "anthropic"]);
const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI", gemini: "Gemini", anthropic: "Anthropic (Claude)",
  meta: "Meta Graph (IG/FB)", youtube: "YouTube Data",
};

const RANGES = [7, 14, 30, 90] as const;

export default function ApiCostsPage() {
  usePageTitle("API Costs");
  const [days, setDays] = useState<number>(30);
  const { data, isLoading } = useCostSheet(days);
  const d = (data as any)?.data;

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

  const chartData = daily.map((x) => ({
    date: new Date(x.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    cost: Number(x.costUsd.toFixed(4)),
  }));

  return (
    <div className="space-y-6 pop-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/dashboard" className="flex items-center gap-1 text-sm text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors">
          <ArrowLeft className="h-4 w-4" /> Dashboard
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-indigo-soft flex items-center justify-center">
            <Receipt className="h-5 w-5 text-indigo" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-semibold text-ink">API Costs</h1>
            <p className="text-sm text-ink-4 mt-0.5">
              What every AI &amp; data API is costing — so you know how much credit to top up.
            </p>
          </div>
        </div>
        {/* Window pills */}
        <div className="flex items-center gap-1 rounded-xl border-2 border-ink/10 p-1">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setDays(r)}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                days === r ? "bg-ink text-white" : "text-ink-4 hover:text-ink"
              }`}
            >
              {r}d
            </button>
          ))}
        </div>
      </div>

      {isLoading && !d && (
        <div className="v3-card p-8 flex items-center justify-center">
          <p className="text-sm text-ink-4">Loading cost data…</p>
        </div>
      )}

      {d && (
        <>
          {/* Headline cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="v3-card p-5 space-y-1">
              <div className="h-8 w-8 rounded-lg bg-terra-soft flex items-center justify-center">
                <DollarSign className="h-4 w-4 text-terra" />
              </div>
              <p className="font-num text-3xl font-semibold text-ink leading-none pt-1">{usd(total)}</p>
              <p className="text-xs text-ink-4">{coverageLabel}</p>
            </div>
            <div className="v3-card p-5 space-y-1">
              <div className="h-8 w-8 rounded-lg bg-indigo-soft flex items-center justify-center">
                <TrendingUp className="h-4 w-4 text-indigo" />
              </div>
              <p className="font-num text-3xl font-semibold text-ink leading-none pt-1">
                {projectionReliable ? usd(projMonthly) : "—"}
              </p>
              <p className="text-xs text-ink-4">
                {projectionReliable
                  ? "Projected next 30 days (forward run-rate, excl. one-time backfill)"
                  : "Forward projection pending — backfill still draining"}
              </p>
            </div>
            <div className="v3-card p-5 space-y-1">
              <div className="h-8 w-8 rounded-lg bg-sage-soft flex items-center justify-center">
                <Activity className="h-4 w-4 text-sage" />
              </div>
              <p className="font-num text-3xl font-semibold text-ink leading-none pt-1">
                {projectionReliable ? usd(projDaily) : "—"}
              </p>
              <p className="text-xs text-ink-4">
                {projectionReliable ? "Forward daily run-rate (steady state)" : "Available once at steady state"}
              </p>
            </div>
          </div>

          {/* Top-up guidance */}
          <div className="rounded-xl border border-indigo/20 bg-indigo-soft px-4 py-3 flex items-start gap-3">
            <Info className="h-4 w-4 text-indigo shrink-0 mt-0.5" />
            <p className="text-xs text-ink leading-relaxed">
              {projectionReliable ? (
                <>
                  To cover the next month, keep at least{" "}
                  <span className="font-semibold">{usd(projMonthly)}</span> of credit across the paid AI providers
                  (OpenAI is primary; Gemini &amp; Anthropic are fallbacks). This is the <span className="font-medium">forward steady-state</span> rate
                  (the daily new-link inflow) — it excludes the one-time historical backfill, which won&rsquo;t recur, so going-forward cost is well below total spend-to-date.{" "}
                </>
              ) : (
                <>
                  A forward credit estimate isn&rsquo;t shown yet because the system is still <span className="font-medium">working through a one-time enrichment backlog</span>{" "}
                  ({pendingBacklog.toLocaleString()} captions left to tag) — the extraction cron is running at catch-up speed, well above the normal daily rate,
                  so any projection now would overstate. It&rsquo;ll appear once the backlog clears (~a day) and the true forward rate can be measured. In the meantime, keep a comfortable buffer of OpenAI credit.{" "}
                </>
              )}
              Meta Graph and YouTube are <span className="font-medium">free within their quotas</span> — they show call volume, not dollars, so you can spot a quota cliff before it bites.
            </p>
          </div>

          {/* Authoritative-source + shared-key disclosure — the honest framing of what
              this sheet can and cannot tell you. */}
          <div className="rounded-xl border border-attention/30 bg-attention/5 px-4 py-3 flex items-start gap-3">
            <AlertTriangle className="h-4 w-4 text-attention shrink-0 mt-0.5" />
            <div className="text-xs text-ink leading-relaxed space-y-1.5">
              <p>
                <span className="font-semibold">This figure is measured precisely going forward</span> (real per-call tokens, since {fmtDay(trackingSince)}) — it is the trustworthy number for predicting future top-ups. For spend <span className="font-medium">before</span> that, the provider console is authoritative; we don&rsquo;t show a reconstructed dollar guess because it over-counted high-volume days.
              </p>
              <p>
                <span className="font-semibold">⚠️ The OpenAI key is shared</span> with another project (&ldquo;Post Automation&rdquo;), so OpenAI&rsquo;s project total (e.g. <span className="font-medium">~$108 for June</span>) covers <span className="font-medium">both apps combined</span> — neither this sheet nor OpenAI&rsquo;s project view isolates this app&rsquo;s spend alone. To get an exact, isolated figure, give this app its <span className="font-medium">own OpenAI API key / project</span>; then OpenAI&rsquo;s dashboard breaks it out directly.
              </p>
              <p className="text-ink-4">
                Authoritative billed totals: OpenAI <span className="font-mono">platform.openai.com/usage</span> · Anthropic <span className="font-mono">console.anthropic.com</span> · Google AI Studio. {!fullWindow && <>Precise in-app tracking began {fmtDay(trackingSince)}.</>}
              </p>
            </div>
          </div>

          {/* Daily spend chart */}
          {chartData.length > 0 && (
            <div className="v3-card p-5 space-y-3">
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-terra" />
                <p className="font-semibold text-ink">Daily Spend (paid providers)</p>
              </div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#E6DFC9" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#7A7A7A" }} interval={Math.max(0, Math.ceil(chartData.length / 8) - 1)} />
                    <YAxis tick={{ fontSize: 11, fill: "#7A7A7A" }} width={48} tickFormatter={(v) => `$${v}`} />
                    <Tooltip formatter={(v: number) => [usd(v), "Cost"]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                    <Bar dataKey="cost" fill="#4F46E5" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Paid providers breakdown */}
          <div className="v3-card p-5 space-y-3">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-terra" />
              <p className="font-semibold text-ink">Paid AI Providers</p>
            </div>
            {paidProviders.length === 0 ? (
              <p className="text-xs text-ink-4">No paid-provider usage recorded in this window.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] font-medium text-ink-4 uppercase tracking-wide border-b border-ink/8">
                      <th className="text-left py-2 font-medium">Provider</th>
                      <th className="text-right py-2 font-medium">Calls</th>
                      <th className="text-right py-2 font-medium">Input Tokens</th>
                      <th className="text-right py-2 font-medium">Output Tokens</th>
                      <th className="text-right py-2 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/6">
                    {paidProviders.map((p) => (
                      <tr key={p.provider}>
                        <td className="py-2.5 font-medium text-ink">{PROVIDER_LABEL[p.provider] ?? p.provider}</td>
                        <td className="py-2.5 text-right tabular-nums text-ink-3">{num(p.calls)}</td>
                        <td className="py-2.5 text-right tabular-nums text-ink-4">{num(p.inputTokens)}</td>
                        <td className="py-2.5 text-right tabular-nums text-ink-4">{num(p.outputTokens)}</td>
                        <td className="py-2.5 text-right font-num font-semibold text-terra">{usd(p.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Free-within-quota providers (call volume) */}
          {freeProviders.length > 0 && (
            <div className="v3-card p-5 space-y-3">
              <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-sage" />
                <p className="font-semibold text-ink">Free within Quota — Call Volume</p>
                <span className="ml-auto text-[11px] text-ink-4">no dollar cost; watch for quota limits</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] font-medium text-ink-4 uppercase tracking-wide border-b border-ink/8">
                      <th className="text-left py-2 font-medium">Provider</th>
                      <th className="text-right py-2 font-medium">Calls / Units</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/6">
                    {freeProviders.map((p) => (
                      <tr key={p.provider}>
                        <td className="py-2.5 font-medium text-ink">{PROVIDER_LABEL[p.provider] ?? p.provider}</td>
                        <td className="py-2.5 text-right tabular-nums text-ink-3">{num(p.calls)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Per-operation breakdown */}
          {byOperation.length > 0 && (
            <div className="v3-card p-5 space-y-3">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-indigo" />
                <p className="font-semibold text-ink">By Operation</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] font-medium text-ink-4 uppercase tracking-wide border-b border-ink/8">
                      <th className="text-left py-2 font-medium">Operation</th>
                      <th className="text-left py-2 font-medium">Provider</th>
                      <th className="text-right py-2 font-medium">Calls</th>
                      <th className="text-right py-2 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink/6">
                    {byOperation.map((op) => (
                      <tr key={`${op.provider}:${op.operation}`}>
                        <td className="py-2.5 text-ink">{op.operation || "—"}</td>
                        <td className="py-2.5 text-ink-4">{PROVIDER_LABEL[op.provider] ?? op.provider}</td>
                        <td className="py-2.5 text-right tabular-nums text-ink-3">{num(op.calls)}</td>
                        <td className="py-2.5 text-right font-num text-terra">{usd(op.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {total === 0 && (
            <p className="text-xs text-ink-4">
              No spend recorded yet for this window. Costs accrue as the extraction cron and AI generators run —
              check back after the next cycle.
            </p>
          )}
        </>
      )}
    </div>
  );
}
