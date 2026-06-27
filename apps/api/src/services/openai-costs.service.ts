// Authoritative OpenAI billed-cost reader (Costs API).
//
// Our token-based api_usage tracking is an ESTIMATE (caching, pricing drift, and —
// because the OpenAI key is shared with another app — it can't isolate this app's
// spend). OpenAI's official Costs API is the AUTHORITATIVE source: exact billed
// dollars, caching-aware, self-correcting. We surface it as the truth and keep the
// token estimate only for per-operation breakdown + the forward projection.
//
// Requires an ADMIN key (sk-admin-… / org key with api.usage.read) in OPENAI_ADMIN_KEY
// — distinct from the regular OPENAI_API_KEY. DARK SWITCH: absent key → available:false,
// no network call, the UI hides the authoritative panel and shows only the estimate.
// FAIL-OPEN: any error → available:false; never throws, never blocks the cost sheet.
//
// ⚠️ The key is SHARED with the other app ("Post Automation"), and both run under one
// api_key/project, so the billed total is COMBINED — OpenAI itself cannot split them.
// The breakdown by project/key is returned anyway (future-proof: if a dedicated key
// is ever added, it auto-isolates), and the UI labels the figure "combined".

const COSTS_URL = "https://api.openai.com/v1/organization/costs";
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 6; // pagination safety bound (180 buckets/page × 6 ≫ any window)

interface CostBucketResult {
  amount?: { value?: string | number; currency?: string };
  project_id?: string | null;
  api_key_id?: string | null;
  line_item?: string | null;
}
interface CostBucket {
  start_time?: number;
  end_time?: number;
  results?: CostBucketResult[];
}
interface CostsResponse {
  data?: CostBucket[];
  has_more?: boolean;
  next_page?: string | null;
}

export interface OpenAiBilling {
  available: boolean;          // false → no admin key / fetch failed (UI hides panel)
  reason?: string;             // why unavailable (for logs / a subtle UI note)
  totalUsd: number;
  currency: string;
  daily: Array<{ date: string; costUsd: number }>;
  byProject: Array<{ projectId: string | null; apiKeyId: string | null; costUsd: number }>;
  windowDays: number;
  since: string | null;        // ISO of earliest bucket returned
  lagNote: string;             // billed data can lag ~24h
}

const unavailable = (reason: string, days: number): OpenAiBilling => ({
  available: false,
  reason,
  totalUsd: 0,
  currency: "usd",
  daily: [],
  byProject: [],
  windowDays: days,
  since: null,
  lagNote: "OpenAI billed data can lag up to ~24h.",
});

/**
 * PURE parser — turns Costs API buckets (same shape as the manual export) into a
 * daily series + per-project breakdown + total. Exported for unit tests (fed the
 * real export JSON as a fixture) so the math is verified without the network.
 */
export function parseOpenAiCosts(buckets: CostBucket[], windowDays: number): OpenAiBilling {
  let totalUsd = 0;
  const daily: Array<{ date: string; costUsd: number }> = [];
  const byProjectMap = new Map<string, { projectId: string | null; apiKeyId: string | null; costUsd: number }>();
  let since: string | null = null;

  for (const b of buckets) {
    const iso = b.start_time ? new Date(b.start_time * 1000).toISOString().slice(0, 10) : "";
    if (iso && (!since || iso < since)) since = iso;
    let dayTotal = 0;
    for (const r of b.results ?? []) {
      const v = Number(r.amount?.value ?? 0);
      if (!Number.isFinite(v)) continue;
      dayTotal += v;
      totalUsd += v;
      const key = `${r.project_id ?? ""}|${r.api_key_id ?? ""}`;
      const pv = byProjectMap.get(key) ?? { projectId: r.project_id ?? null, apiKeyId: r.api_key_id ?? null, costUsd: 0 };
      pv.costUsd += v;
      byProjectMap.set(key, pv);
    }
    if (iso) daily.push({ date: iso, costUsd: dayTotal });
  }

  daily.sort((a, b) => (a.date < b.date ? -1 : 1));
  return {
    available: true,
    totalUsd,
    currency: "usd",
    daily,
    byProject: [...byProjectMap.values()].sort((a, b) => b.costUsd - a.costUsd),
    windowDays,
    since,
    lagNote: "OpenAI billed data can lag up to ~24h.",
  };
}

let fetchImpl: typeof fetch = fetch;
/** Test seam — swap the fetch used by fetchOpenAiBilling. */
export function __setOpenAiFetchForTesting(fn: typeof fetch | null): void {
  fetchImpl = fn ?? fetch;
}

/**
 * Fetch the organization's authoritative billed cost for the last `days`. Paginates
 * via next_page. DARK + FAIL-OPEN: missing key or any error → available:false.
 */
export async function fetchOpenAiBilling(days = 30): Promise<OpenAiBilling> {
  const adminKey = process.env.OPENAI_ADMIN_KEY;
  if (!adminKey) return unavailable("OPENAI_ADMIN_KEY not configured", days);

  const startTime = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const allBuckets: CostBucket[] = [];
  let page: string | null = null;

  try {
    for (let i = 0; i < MAX_PAGES; i++) {
      const params = new URLSearchParams({
        start_time: String(startTime),
        bucket_width: "1d",
        limit: String(Math.min(Math.max(days + 1, 1), 180)),
        "group_by[]": "project_id",
      });
      params.append("group_by[]", "api_key_id");
      if (page) params.set("page", page);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchImpl(`${COSTS_URL}?${params.toString()}`, {
          headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        // 401 = wrong/expired admin key; 403 = key lacks api.usage.read scope. Fail-open.
        return unavailable(`OpenAI Costs API HTTP ${res.status}`, days);
      }
      const body = (await res.json()) as CostsResponse;
      for (const b of body.data ?? []) allBuckets.push(b);
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
    return parseOpenAiCosts(allBuckets, days);
  } catch (e) {
    return unavailable(e instanceof Error ? e.message : "fetch failed", days);
  }
}
