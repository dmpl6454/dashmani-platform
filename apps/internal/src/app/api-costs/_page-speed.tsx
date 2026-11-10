"use client";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Gauge } from "lucide-react";
import { apiFetch } from "@/lib/api";

/**
 * Page speed as real people experience it: Core Web Vitals reported by each portal's own
 * browsers (75th percentile per page, Google's yardstick). Kept in the API's memory, so the
 * window restarts at every deploy; the card says since when.
 */
type Row = { app: string; route: string; name: "LCP" | "INP" | "CLS" | "FCP" | "TTFB"; samples: number; p75: number; p95: number; rating: "good" | "needs-improvement" | "poor" };
type Payload = { since: string; rows: Row[] };

const METRICS: Array<{ key: Row["name"]; label: string; hint: string }> = [
  { key: "LCP", label: "Largest paint", hint: "Main content visible. Good ≤ 2.5 s" },
  { key: "INP", label: "Response to clicks", hint: "Delay after a tap or key. Good ≤ 200 ms" },
  { key: "CLS", label: "Layout shift", hint: "Content jumping. Good ≤ 0.1" },
  { key: "FCP", label: "First paint", hint: "Anything visible. Good ≤ 1.8 s" },
  { key: "TTFB", label: "Server response", hint: "First byte from the server. Good ≤ 0.8 s" },
];
const APP_LABEL: Record<string, string> = { internal: "Staff", hr: "HR", client: "Client", sales: "Sales", billing: "Billing" };
const RATING: Record<Row["rating"], { label: string; color: string }> = {
  good: { label: "Good", color: "var(--hx-34D399, #34D399)" },
  "needs-improvement": { label: "Needs work", color: "var(--hx-E9BD62, #E9BD62)" },
  poor: { label: "Poor", color: "var(--hx-FB7185, #FB7185)" },
};

function fmt(name: Row["name"], v: number) {
  if (name === "CLS") return v.toFixed(2);
  return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
}

export function PageSpeedCard() {
  const { data, error } = useSWR("/admin/web-vitals", (url: string) => apiFetch<any>(url).then((r) => r.data as Payload), { refreshInterval: 60_000, revalidateOnFocus: false });
  const [metric, setMetric] = useState<Row["name"]>("LCP");
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => r.name === metric).slice(0, 40), [data, metric]);
  const hint = METRICS.find((m) => m.key === metric)?.hint;

  return (
    <section className="mt-3.5 rounded-[14px] bg-ds-card border border-ds-line px-6 py-[22px] min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold text-ds-text">
          <Gauge className="h-4 w-4 text-ds-gold" /> Page speed (real users)
        </h2>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Metric">
          {METRICS.map((m) => (
            <button key={m.key} type="button" role="tab" aria-selected={metric === m.key} onClick={() => setMetric(m.key)}
              className={`h-7 px-3 rounded-full border text-[11.5px] font-semibold ${metric === m.key ? "bg-ds-gold text-[color:var(--hx-060D14)] border-ds-gold" : "border-ds-line2 text-ds-t2 hover:text-ds-text"}`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-[12px] text-ds-t3">
        {hint}. 75th percentile per page, from signed-in browsers on every portal
        {data?.since ? `, since ${new Date(data.since).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })} (the last deploy)` : ""}.
      </p>
      {error ? (
        <p className="mt-4 text-[12.5px] text-ds-t3">Couldn&apos;t load page speed. It refreshes every minute.</p>
      ) : !data ? (
        <div className="mt-4 h-24 rounded-[8px] bg-ds-inset motion-safe:animate-pulse" aria-hidden="true" />
      ) : rows.length === 0 ? (
        <p className="mt-4 text-[12.5px] text-ds-t3">No measurements yet for this metric. They arrive as people use the portals.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[12.5px]">
            <thead>
              <tr className="text-[10px] tracking-[.1em] uppercase text-ds-t3">
                <th className="text-left font-semibold py-2 pr-3">Portal</th>
                <th className="text-left font-semibold py-2 pr-3">Page</th>
                <th className="text-right font-semibold py-2 pr-3">p75</th>
                <th className="text-right font-semibold py-2 pr-3">p95</th>
                <th className="text-left font-semibold py-2 pr-3">Rating</th>
                <th className="text-right font-semibold py-2">Visits</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.app}|${r.route}`} className="border-t border-ds-line">
                  <td className="py-2 pr-3 text-ds-t2">{APP_LABEL[r.app] ?? r.app}</td>
                  <td className="py-2 pr-3 font-mono text-ds-text break-all">{r.route}</td>
                  <td className="py-2 pr-3 text-right font-semibold text-ds-text">{fmt(r.name, r.p75)}</td>
                  <td className="py-2 pr-3 text-right text-ds-t3">{fmt(r.name, r.p95)}</td>
                  <td className="py-2 pr-3"><span className="font-semibold" style={{ color: RATING[r.rating].color }}>{RATING[r.rating].label}</span></td>
                  <td className="py-2 text-right text-ds-t3">{r.samples}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
