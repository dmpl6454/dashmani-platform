const fmt = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric" });

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  try {
    return fmt.format(new Date(value));
  } catch {
    return String(value);
  }
}

// IST is always UTC+5:30 — fixed offset, no DST.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Returns today's date as YYYY-MM-DD in IST (UTC+5:30).
 * Safe to use in both Node.js (server) and browser.
 * Never use new Date().toISOString().split("T")[0] — that returns UTC date
 * which is wrong between 12:00 AM and 5:30 AM IST.
 */
export function todayIST(): string {
  return dateToIST(new Date());
}

/**
 * Converts any Date to YYYY-MM-DD in IST.
 */
export function dateToIST(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ist.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Returns a Date object set to midnight IST for the given YYYY-MM-DD string.
 * Use this when constructing Date values to pass into Prisma @db.Date fields.
 */
export function istMidnight(yyyymmdd: string): Date {
  // Parsing "YYYY-MM-DD" as UTC midnight then subtracting IST offset gives
  // the correct DB timestamp that Prisma stores as midnight UTC for that IST day.
  // But for @db.Date fields Prisma strips time anyway — passing UTC midnight of
  // the same calendar date is sufficient and consistent.
  return new Date(`${yyyymmdd}T00:00:00.000Z`);
}

/**
 * Returns the time-of-day of a Date as "HH:MM" (24h) in IST.
 * Used for "submit time" columns in exports. Returns "" for null/invalid.
 */
export function istTimeOfDay(d: Date | null | undefined): string {
  if (!d) return "";
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const h = String(ist.getUTCHours()).padStart(2, "0");
  const m = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Returns "YYYY-MM-DD HH:MM" in IST for a Date. Returns "" for null/invalid.
 */
export function istDateTime(d: Date | null | undefined): string {
  if (!d) return "";
  return `${dateToIST(d)} ${istTimeOfDay(d)}`;
}

/**
 * Averages an array of Dates by their IST minutes-since-midnight and returns
 * the mean as "HH:MM" in IST. Returns "" for an empty array. Each Date counts
 * once — callers decide whether to pass one entry per link or per report.
 */
export function avgIstTimeOfDay(dates: Date[]): string {
  if (!dates.length) return "";
  let totalMinutes = 0;
  for (const d of dates) {
    const ist = new Date(d.getTime() + IST_OFFSET_MS);
    totalMinutes += ist.getUTCHours() * 60 + ist.getUTCMinutes();
  }
  const mean = Math.round(totalMinutes / dates.length);
  const h = String(Math.floor(mean / 60)).padStart(2, "0");
  const m = String(mean % 60).padStart(2, "0");
  return `${h}:${m}`;
}

// ── IST calendar helpers for the pipeline due alerts (spec §7.8) ─────────────────────
// Keys are IST calendar days as `YYYY-MM-DD` (todayIST() / dateToIST()). The working week
// is Monday–Saturday: Sunday is the ONLY weekend day.

/** 0 = Sunday … 6 = Saturday, for an IST day key. */
export function dayOfWeekIST(key: string): number {
  return new Date(`${key}T00:00:00.000Z`).getUTCDay();
}

/** Every day except Sunday. */
export function isWorkingDayIST(key: string): boolean {
  return dayOfWeekIST(key) !== 0;
}

/** The IST day key `n` calendar days after `key`. */
export function addDaysIST(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10); // calendar arithmetic on a key — not "today"
}

/** The first working day strictly after `key` (Saturday → Monday). */
export function nextWorkingDayIST(key: string): string {
  let next = addDaysIST(key, 1);
  while (!isWorkingDayIST(next)) next = addDaysIST(next, 1);
  return next;
}

/** Minutes since IST midnight, 0–1439. */
export function istMinutesOfDay(d: Date = new Date()): number {
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;
}
