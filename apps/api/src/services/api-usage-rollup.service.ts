/**
 * api_usage rollup — keeps the Cost Sheet exact while capping the table.
 *
 * recordApiUsage() writes one row per outbound API call (~50k/day). By 2026-10-25 the table
 * held 6.0M rows / 1.7 GB of the 49 GB prod disk — the day that disk filled — and nothing
 * reads an individual row older than the Cost Sheet's longest window. Days older than
 * API_USAGE_ROLLUP_KEEP_DAYS are therefore folded into ONE row per Cost Sheet group —
 * (provider, operation, model, utc_day, tokens_null, neg_input) — carrying the group's summed
 * calls / units / tokens / cost and its EARLIEST created_at. That is exact for every reader:
 *
 *   - queryCostSheetGroups() groups by precisely these keys and SUMs precisely these columns,
 *     so each rolled day yields the same groups with the same sums. count(*) per group only
 *     feeds the steady-state rate, which reads the last 3 days — never a rolled day.
 *   - costSheetGroupCostUsd() re-prices a priced group from Σinput/Σoutput, which is linear
 *     (cached tokens are not used at group level, and neg_input is a group key so a negative
 *     sum never pools with a non-negative one), and keeps the STORED cost for tokens_null,
 *     unknown-model and '-reconstructed' groups — the rolled row stores the summed cost.
 *   - "tracking since" (findFirst orderBy createdAt asc) is unchanged: the rolled row keeps
 *     min(created_at), so the oldest timestamp in the table never moves.
 *   - the DeepSeek spend ceiling reads only today; the ROLLUP_KEEP_DAYS guard keeps every
 *     window the UI offers (7/14/30/90) and the API's 365-day clamp is honoured only within
 *     the kept span — beyond it, totals are still exact, just coarser than one row per call.
 *
 * One UTC day per transaction — a DELETE … RETURNING feeding the aggregate INSERT, so a day
 * is either fully rolled or untouched — oldest first, at most ROLLUP_MAX_DAYS_PER_RUN per run.
 * Scheduled by WALL CLOCK for 04:20 IST like the pipeline maintenance (never at boot, once
 * per IST day via a system_settings marker). Rolled days are recognised by having exactly one
 * row per group, so a re-run is a no-op rather than churn.
 */
import { prisma } from "@dashmani/db";
import { dateToIST, istMinutesOfDay } from "@dashmani/shared";
import { msUntilNextIST } from "./pipeline/jobs";

export const API_USAGE_ROLLUP_KEEP_DAYS = 90;
export const API_USAGE_ROLLUP_MARKER_KEY = "apiUsage.rollupLastRunIST";
export const ROLLUP_MAX_DAYS_PER_RUN = 30;
const TARGET_MIN = 260; // 04:20 IST — after the 04:00 pipeline trim, inside the same quiet window
const RUN_FROM_MIN = 210; // 03:30 IST
const RUN_UNTIL_MIN = 330; // 05:30 IST

export interface RollupDayResult {
  /** UTC calendar day, YYYY-MM-DD */
  day: string;
  /** rows on that day before the rollup */
  before: number;
  /** rows on that day after the rollup (= its Cost Sheet group count) */
  after: number;
}

export interface RollupResult {
  cutoffDay: string;
  days: RollupDayResult[];
  rowsBefore: number;
  rowsAfter: number;
}

/**
 * UTC days strictly before `cutoffDay` that still hold more rows than Cost Sheet groups,
 * oldest first. created_at is timestamp(3) WITHOUT time zone holding UTC, so `::date` is
 * the UTC day with no session TimeZone involved (the same key the Cost Sheet uses).
 */
async function rollableDays(cutoffDay: string, limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ day: string }>>`
    SELECT to_char(d::timestamp, 'YYYY-MM-DD') AS day
      FROM (
        SELECT created_at::date AS d,
               count(*) AS n,
               count(DISTINCT (provider, operation, model,
                               (input_tokens IS NULL AND output_tokens IS NULL),
                               coalesce(input_tokens < 0, false))) AS g
          FROM api_usage
         WHERE created_at < ${cutoffDay}::date
         GROUP BY created_at::date
      ) x
     WHERE n > g
     ORDER BY d
     LIMIT ${limit}::int`;
  return rows.map((r) => r.day);
}

/** Roll ONE UTC day (YYYY-MM-DD) into one row per Cost Sheet group, atomically. */
export async function rollupApiUsageDay(day: string): Promise<RollupDayResult> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '60s'`;
      const [counts] = await tx.$queryRaw<Array<{ n: bigint; g: bigint }>>`
        SELECT count(*)::bigint AS n,
               count(DISTINCT (provider, operation, model,
                               (input_tokens IS NULL AND output_tokens IS NULL),
                               coalesce(input_tokens < 0, false)))::bigint AS g
          FROM api_usage
         WHERE created_at >= ${day}::date AND created_at < ${day}::date + 1`;
      const before = Number(counts?.n ?? 0);
      const groups = Number(counts?.g ?? 0);
      if (before === 0 || before === groups) return { day, before, after: before };
      const after = await tx.$executeRaw`
        WITH del AS (
          DELETE FROM api_usage
           WHERE created_at >= ${day}::date AND created_at < ${day}::date + 1
           RETURNING provider, operation, model, calls, units, input_tokens, output_tokens, cost_usd, created_at
        )
        INSERT INTO api_usage (id, provider, model, operation, calls, units, input_tokens, output_tokens, cost_usd, created_at)
        SELECT gen_random_uuid()::text,
               provider,
               model,
               operation,
               sum(calls)::int,
               CASE WHEN bool_and(units IS NULL)         THEN NULL ELSE sum(coalesce(units, 0))::int         END,
               CASE WHEN bool_and(input_tokens IS NULL)  THEN NULL ELSE sum(coalesce(input_tokens, 0))::int  END,
               CASE WHEN bool_and(output_tokens IS NULL) THEN NULL ELSE sum(coalesce(output_tokens, 0))::int END,
               sum(cost_usd)::float8,
               min(created_at)
          FROM del
         GROUP BY provider, operation, model,
                  (input_tokens IS NULL AND output_tokens IS NULL),
                  coalesce(input_tokens < 0, false)`;
      return { day, before, after };
    },
    { maxWait: 5_000, timeout: 90_000 },
  );
}

/** Roll every rollable day older than keepDays (oldest first, at most maxDays). */
export async function rollupApiUsage(
  opts: { now?: Date; keepDays?: number; maxDays?: number } = {},
): Promise<RollupResult> {
  const now = opts.now ?? new Date();
  const keepDays = opts.keepDays ?? API_USAGE_ROLLUP_KEEP_DAYS;
  const maxDays = opts.maxDays ?? ROLLUP_MAX_DAYS_PER_RUN;
  // A day is rollable only when ALL of it is older than keepDays: strictly before the
  // cutoff's UTC date, so the partially-kept cutoff day itself is left alone.
  const cutoffDay = new Date(now.getTime() - keepDays * 86_400_000).toISOString().slice(0, 10);
  const days: RollupDayResult[] = [];
  let rowsBefore = 0;
  let rowsAfter = 0;
  for (const day of await rollableDays(cutoffDay, maxDays)) {
    const r = await rollupApiUsageDay(day);
    days.push(r);
    rowsBefore += r.before;
    rowsAfter += r.after;
  }
  return { cutoffDay, days, rowsBefore, rowsAfter };
}

export type RollupRunResult =
  | { status: "skipped"; reason: "hours" | "done" | "running" }
  | ({ status: "ran" } & RollupResult);

let running = false;

/** One rollup run, if it is due (quiet IST window, not yet done today). `now` is injectable. */
export function runApiUsageRollupIfDue(opts: { now?: Date; keepDays?: number; maxDays?: number } = {}): Promise<RollupRunResult> {
  if (running) return Promise.resolve({ status: "skipped", reason: "running" });
  running = true; // claimed before the first await
  return (async (): Promise<RollupRunResult> => {
    try {
      const now = opts.now ?? new Date();
      const minutes = istMinutesOfDay(now);
      if (minutes < RUN_FROM_MIN || minutes >= RUN_UNTIL_MIN) return { status: "skipped", reason: "hours" };
      const today = dateToIST(now);
      const marker = await prisma.systemSetting.findUnique({ where: { key: API_USAGE_ROLLUP_MARKER_KEY } });
      if (marker?.value === today) return { status: "skipped", reason: "done" };
      const result = await rollupApiUsage({ now, keepDays: opts.keepDays, maxDays: opts.maxDays });
      await prisma.systemSetting.upsert({
        where: { key: API_USAGE_ROLLUP_MARKER_KEY },
        create: { key: API_USAGE_ROLLUP_MARKER_KEY, value: today },
        update: { value: today },
      });
      return { status: "ran", ...result };
    } finally {
      running = false;
    }
  })();
}

/**
 * index.ts: arm a timer for the next 04:20 IST (never a run at boot); after each run — done,
 * skipped or failed — re-arm for the following 04:20. Returns a handle for tests.
 */
export function scheduleApiUsageRollup(run: () => Promise<RollupRunResult> = () => runApiUsageRollupIfDue()): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      run()
        .then((r) => {
          if (r.status === "ran") console.log(`[api-usage-rollup] days=${r.days.length} rows ${r.rowsBefore} -> ${r.rowsAfter} (older than ${r.cutoffDay})`);
        })
        .catch((err) => console.warn("[api-usage-rollup] failed:", String(err)))
        .finally(arm);
    }, msUntilNextIST(TARGET_MIN));
    timer.unref?.();
  };
  arm();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
