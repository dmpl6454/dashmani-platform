/**
 * Load-harness entry for the API container (spec §11). Starts the PIPELINE_LOADTEST
 * probe, then boots the real API exactly as prod does (apps/api/src/index.ts).
 *
 * The probe lives HERE, not in apps/api/src, so no load-test code ships to prod:
 *  - monitorEventLoopDelay (10 ms resolution): one `[loadtest]` JSON line every 10 s with
 *    the window's event-loop p50/p99/max, RSS, heap and the pipeline stats window;
 *  - a synthetic cron workload at prod-like cadence on the MAIN pool: a batch-upsert
 *    loop (20 s), a 1.5 MB JSON parse (30 s) and a sequential write loop (60 s).
 */
import { monitorEventLoopDelay } from "perf_hooks";
import { prisma } from "@dashmani/db";
import { snapshotPipelineStats } from "../../apps/api/src/services/pipeline/stats";
import "../../apps/api/src/index";

// monitorEventLoopDelay records each sample as the whole interval, so an idle loop reads
// ≈ the resolution; the DELAY is the excess over it (the number the §11 criterion means).
const RESOLUTION_MS = 10;
const ms = (ns: number) => Math.max(0, Math.round((ns / 1e6 - RESOLUTION_MS) * 100) / 100);
const win = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
const all = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
win.enable();
all.enable();

setInterval(() => {
  const m = process.memoryUsage();
  const pipe = snapshotPipelineStats(true);
  console.log(
    "[loadtest] " +
      JSON.stringify({
        t: Date.now(),
        eld: { p50: ms(win.percentile(50)), p99: ms(win.percentile(99)), max: ms(win.max) },
        eldBoot: { p99: ms(all.percentile(99)), max: ms(all.max) },
        rssMb: Math.round(m.rss / 1048576),
        heapMb: Math.round(m.heapUsed / 1048576),
        pipe,
      }),
  );
  win.reset();
}, 10_000).unref();

const bigJson = JSON.stringify(
  Array.from({ length: 6000 }, (_, i) => ({ id: `post_${i}`, caption: "x".repeat(200), likes: i, comments: [{ a: i, b: "y".repeat(20) }] })),
);

async function ensureTable() {
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS loadtest_scratch (id text PRIMARY KEY, v int NOT NULL, payload text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`,
  );
}

async function batchUpsert() {
  for (let b = 0; b < 5; b++) {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `k${b}_${i}`, v: Math.floor(Math.random() * 1e6), payload: "p".repeat(300) }));
    await prisma.$executeRawUnsafe(
      `INSERT INTO loadtest_scratch (id, v, payload)
       SELECT id, v, payload FROM json_to_recordset($1::json) AS r(id text, v int, payload text)
       ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v, payload = EXCLUDED.payload, updated_at = now()`,
      JSON.stringify(rows),
    );
  }
}

async function sequentialWrites() {
  for (let i = 0; i < 100; i++) {
    await prisma.$executeRawUnsafe(`UPDATE loadtest_scratch SET v = v + 1, updated_at = now() WHERE id = $1`, `k0_${i}`);
  }
}

function guard(name: string, fn: () => Promise<unknown> | unknown) {
  return () => {
    Promise.resolve()
      .then(fn)
      .catch((err) => console.warn(`[loadtest] synthetic ${name} failed:`, String(err)));
  };
}

setTimeout(() => {
  ensureTable()
    .then(() => {
      setInterval(guard("batch-upsert", batchUpsert), 20_000).unref();
      setInterval(guard("json-parse", () => JSON.parse(bigJson).length), 30_000).unref();
      setInterval(guard("sequential-writes", sequentialWrites), 60_000).unref();
      console.log(`[loadtest] synthetic cron workload started (json ${Math.round(bigJson.length / 1024)} KB)`);
    })
    .catch((err) => console.warn("[loadtest] synthetic cron setup failed:", String(err)));
}, 5_000).unref();
