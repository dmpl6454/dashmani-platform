import fsp from "fs/promises";
import { prisma } from "@dashmani/db";
import { notifyAdminByEmail } from "./email.service";

// Server-wide low-disk alert. The 2026-10-25 outage (6.5 h of "unexpected error" on every
// portal) began when the 49 GB disk reached 0 bytes and Postgres could not finish crash
// recovery; nobody was warned. This checks free space every hour and emails the admin inbox
// — at most once a day — when it drops below DISK_ALERT_FREE_GB (default 8) or
// DISK_ALERT_FREE_PCT (default 15) percent, naming the largest tables so the next step is
// obvious. It never writes to the database and fails silently (a failed check must not crash
// the API). Kill switch: DISK_WATCH_ENABLED=0.

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface DiskReading {
  freeBytes: number;
  totalBytes: number;
}

export interface DiskVerdict {
  low: boolean;
  freeGb: number;
  freePct: number;
}

/** Pure: is this reading below either threshold? */
export function judgeDisk(r: DiskReading, minFreeGb = envNum("DISK_ALERT_FREE_GB", 8), minFreePct = envNum("DISK_ALERT_FREE_PCT", 15)): DiskVerdict {
  const freeGb = r.freeBytes / 1024 ** 3;
  const freePct = r.totalBytes > 0 ? (r.freeBytes / r.totalBytes) * 100 : 100;
  return { low: freeGb < minFreeGb || freePct < minFreePct, freeGb, freePct };
}

export const diskTools = {
  /** Free/total bytes of the filesystem holding `path` (the root disk on the server). */
  async read(path = process.env.DISK_WATCH_PATH || "/"): Promise<DiskReading> {
    const s = await fsp.statfs(path);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  },
  now: () => Date.now(),
};

const DAY_MS = 24 * 3600_000;
let lastAlertAt = Number.NEGATIVE_INFINITY;

/** For tests: forget the once-a-day throttle. */
export function resetDiskWatch() {
  lastAlertAt = Number.NEGATIVE_INFINITY;
}

/** One check. Returns the verdict and whether an email was sent. Never throws. */
export async function checkDisk(): Promise<{ verdict: DiskVerdict | null; alerted: boolean }> {
  try {
    const verdict = judgeDisk(await diskTools.read());
    if (!verdict.low) return { verdict, alerted: false };
    const now = diskTools.now();
    console.warn(`[disk-watch] low disk: ${verdict.freeGb.toFixed(1)} GB free (${verdict.freePct.toFixed(0)}%)`);
    if (now - lastAlertAt < DAY_MS) return { verdict, alerted: false };
    lastAlertAt = now;

    const tables = await prisma
      .$queryRaw<Array<{ name: string; bytes: bigint }>>`
        SELECT relname AS name, pg_total_relation_size(relid) AS bytes
        FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 5`
      .catch(() => [] as Array<{ name: string; bytes: bigint }>);
    await notifyAdminByEmail("Server disk is getting full", [
      { label: "Free space", value: `${verdict.freeGb.toFixed(1)} GB (${verdict.freePct.toFixed(0)}%)` },
      { label: "Largest tables", value: tables.map((t) => `${t.name} ${(Number(t.bytes) / 1024 ** 3).toFixed(1)} GB`).join(", ") || "—" },
      { label: "Why it matters", value: "At 0 bytes Postgres stops and every portal fails (2026-10-25). Free space or enlarge the disk." },
    ]).catch(() => undefined);
    return { verdict, alerted: true };
  } catch (err) {
    console.error("[disk-watch] check failed:", err);
    return { verdict: null, alerted: false };
  }
}

/** Hourly, first check 5 minutes after boot. */
export function startDiskWatch() {
  if (process.env.DISK_WATCH_ENABLED === "0") return;
  setTimeout(() => {
    void checkDisk();
    setInterval(() => void checkDisk(), 3600_000);
  }, 5 * 60_000);
}
