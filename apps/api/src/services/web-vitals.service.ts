/**
 * Real-user speed: Core Web Vitals measured in staff and client browsers, kept IN MEMORY.
 *
 * Each portal reports LCP, INP, CLS, FCP and TTFB per page view (Next.js's own
 * `useReportWebVitals`). We keep the last SAMPLE_CAP values per (portal, page, metric) and
 * report the 75th percentile, the figure Google uses. Nothing is written to the database:
 * the API is one pm2 process, so memory is exact, and a restart (every deploy) simply starts
 * a fresh window, which the page states. Bounded: at most KEY_CAP keys × SAMPLE_CAP numbers.
 */

export const VITAL_NAMES = ["LCP", "INP", "CLS", "FCP", "TTFB"] as const;
export type VitalName = (typeof VITAL_NAMES)[number];
export const VITAL_APPS = ["internal", "hr", "client", "sales", "billing"] as const;
export type VitalApp = (typeof VITAL_APPS)[number];

/** Google's thresholds: good up to the first number, poor above the second. */
export const VITAL_THRESHOLDS: Record<VitalName, [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};
/** Values above these are measurement noise (a tab left in the background), not page speed. */
const MAX_VALUE: Record<VitalName, number> = { LCP: 120_000, INP: 60_000, CLS: 50, FCP: 120_000, TTFB: 120_000 };

const SAMPLE_CAP = 500;
const KEY_CAP = 600;

interface Bucket { app: VitalApp; route: string; name: VitalName; values: number[]; next: number; total: number }
const buckets = new Map<string, Bucket>();
let since = new Date();

/** "/employees/3f2a…-…" and "/reports/42" → "/employees/:id", "/reports/:id"; query strings dropped. */
export function normalizeRoute(raw: string): string {
  const path = String(raw || "/").split(/[?#]/)[0].slice(0, 200);
  const parts = path.split("/").map((seg) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d+$/.test(seg) || seg.length > 40 ? ":id" : seg,
  );
  const out = parts.join("/").replace(/\/+$/, "");
  return (out || "/").slice(0, 120);
}

export function recordVital(app: string, route: string, name: string, value: number): boolean {
  if (!(VITAL_APPS as readonly string[]).includes(app)) return false;
  if (!(VITAL_NAMES as readonly string[]).includes(name)) return false;
  const n = name as VitalName;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_VALUE[n]) return false;
  const r = normalizeRoute(route);
  const key = `${app}|${r}|${n}`;
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= KEY_CAP) return false; // a flood of odd routes can't grow memory
    b = { app: app as VitalApp, route: r, name: n, values: [], next: 0, total: 0 };
    buckets.set(key, b);
  }
  if (b.values.length < SAMPLE_CAP) b.values.push(value);
  else { b.values[b.next] = value; b.next = (b.next + 1) % SAMPLE_CAP; }
  b.total += 1;
  return true;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

export type VitalRating = "good" | "needs-improvement" | "poor";
export function rate(name: VitalName, value: number): VitalRating {
  const [good, poor] = VITAL_THRESHOLDS[name];
  return value <= good ? "good" : value <= poor ? "needs-improvement" : "poor";
}

export interface VitalRow { app: VitalApp; route: string; name: VitalName; samples: number; p75: number; p95: number; rating: VitalRating }

/** Every (portal, page, metric) with its p75/p95 over the kept samples, most-sampled first. */
export function vitalsSummary(): { since: string; thresholds: typeof VITAL_THRESHOLDS; rows: VitalRow[] } {
  const rows: VitalRow[] = [];
  for (const b of buckets.values()) {
    const sorted = [...b.values].sort((a, c) => a - c);
    const p75 = percentile(sorted, 0.75);
    rows.push({ app: b.app, route: b.route, name: b.name, samples: b.total, p75, p95: percentile(sorted, 0.95), rating: rate(b.name, p75) });
  }
  rows.sort((a, c) => c.samples - a.samples || (a.app < c.app ? -1 : a.app > c.app ? 1 : 0));
  return { since: since.toISOString(), thresholds: VITAL_THRESHOLDS, rows };
}

export function resetVitalsForTests(): void {
  buckets.clear();
  since = new Date();
}
