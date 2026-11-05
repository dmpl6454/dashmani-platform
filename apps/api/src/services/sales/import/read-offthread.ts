import path from "path";
import { createRequire } from "module";
import { Worker } from "worker_threads";
import { sniffFormat } from "../tabular";
import { ImportReadError, readSource, type SourceTable } from "./read";

// Swipe import (spec-import §4.1, PR 0 tabular.ts's guard note): SheetJS inflates and parses a whole
// workbook synchronously. On the request path that stalls the one shared API event loop for every
// portal, and a ZIP that understates its sizes slips past the 64 MB declared-size guard. So a workbook
// of any real size is read in a worker thread with its own heap cap and a time limit; a worker that
// runs out of memory or time is a 422 FILE_UNREADABLE, never a stalled or crashed API. CSV stays inline:
// it is read by a linear state machine bounded by the row limit.

const envInt = (name: string, dflt: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};
/** Workbooks below this many bytes are cheap to read inline. */
const inlineMaxBytes = () => envInt("SALES_IMPORT_INLINE_XLSX_BYTES", 256 * 1024);
const workerHeapMb = () => envInt("SALES_IMPORT_WORKER_HEAP_MB", 384);
const workerTimeoutMs = () => envInt("SALES_IMPORT_WORKER_TIMEOUT_MS", 60_000);

const TOO_BIG = "This spreadsheet is too large or too complex to read — export fewer rows (one financial year at a time) and upload again";

// The worker loads read.ts through tsx's CommonJS hook, the way the API itself runs (no compile step).
const localRequire = createRequire(__filename);
const WORKER_SOURCE = `
const { parentPort, workerData } = require("worker_threads");
require(workerData.tsx).register();
try {
  const { readSource } = require(workerData.module);
  const t = readSource(Buffer.from(workerData.buf), workerData.fileName, workerData.sheet, workerData.maxRows);
  parentPort.postMessage({ ok: true, table: t });
} catch (e) {
  parentPort.postMessage({ ok: false, name: e && e.name, code: e && e.code, message: e && e.message });
}`;

// One workbook at a time: two large uploads must not each claim a full heap.
let queue: Promise<unknown> = Promise.resolve();

/** readSource, with any non-trivial workbook read off the request thread. */
export async function readSourceOffThread(buf: Buffer, fileName: string, sheet: string | null | undefined, maxRows: number): Promise<SourceTable> {
  const fmt = sniffFormat(buf);
  if ((fmt !== "xlsx" && fmt !== "xls") || buf.length < inlineMaxBytes()) return readSource(buf, fileName, sheet, maxRows);
  const run = queue.then(() => inWorker(buf, fileName, sheet ?? null, maxRows));
  queue = run.catch(() => undefined);
  return run;
}

function inWorker(buf: Buffer, fileName: string, sheet: string | null, maxRows: number): Promise<SourceTable> {
  return new Promise<SourceTable>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); void worker.terminate(); } };
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { tsx: localRequire.resolve("tsx/cjs/api"), module: path.join(__dirname, "read.ts"), buf, fileName, sheet, maxRows },
      resourceLimits: { maxOldGenerationSizeMb: workerHeapMb(), maxYoungGenerationSizeMb: 64 },
    });
    const timer = setTimeout(() => finish(() => reject(new ImportReadError("FILE_UNREADABLE", TOO_BIG))), workerTimeoutMs());
    worker.once("message", (m: { ok: true; table: SourceTable } | { ok: false; name?: string; code?: string; message?: string }) => {
      finish(() => {
        if (m.ok) return resolve(m.table);
        if (m.name === "ImportReadError" && (m.code === "FILE_UNREADABLE" || m.code === "EMPTY_FILE")) return reject(new ImportReadError(m.code, m.message ?? TOO_BIG));
        console.error(`[sales-import] workbook reader failed (${m.name ?? "unknown"})`);
        reject(new ImportReadError("FILE_UNREADABLE", "This file could not be read as CSV or Excel — export it again from Swipe"));
      });
    });
    // ERR_WORKER_OUT_OF_MEMORY and anything else that kills the thread.
    worker.once("error", (err: Error) => finish(() => {
      console.error(`[sales-import] workbook reader stopped (${(err as NodeJS.ErrnoException).code ?? err.name})`);
      reject(new ImportReadError("FILE_UNREADABLE", TOO_BIG));
    }));
    worker.once("exit", () => finish(() => reject(new ImportReadError("FILE_UNREADABLE", TOO_BIG))));
  });
}
