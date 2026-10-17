// Number and date formatting. Fixed English, so the static render and the browser agree.

export function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const trim = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, ""));
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}K`;
  return String(n);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "in 54 days", "in 5 hours", "expired" — for token expiry. */
export function fmtUntil(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const ms = t - now;
  if (ms <= 0) return "expired";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `in ${Math.max(1, Math.floor(ms / 60_000))} min`;
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `in ${days} days`;
}

export function daysUntil(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : (t - now) / 86_400_000;
}

// ── Booking offers ──────────────────────────────────────────────────────────────────────────────
// Money is integer paise and is only ever shown from the amount the API sends. Dates are drawn by hand
// (fixed English, 12-hour am/pm), never through toLocale*, so the same instant reads the same in every
// browser. IST is UTC+5:30 with no daylight saving, so it is plain arithmetic.

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** ₹ with Indian grouping (12,34,567); paise shown only when there are some. */
export function fmtInr(paise: number | null | undefined): string {
  if (paise == null || !Number.isFinite(paise)) return "—";
  const abs = Math.abs(Math.round(paise));
  const rupees = String(Math.floor(abs / 100));
  const p = abs % 100;
  // Last three digits, then pairs: 12,34,567.
  let grouped = rupees.slice(-3);
  let rest = rupees.slice(0, -3);
  while (rest.length > 0) {
    grouped = `${rest.slice(-2)},${grouped}`;
    rest = rest.slice(0, -2);
  }
  return `${paise < 0 ? "-" : ""}₹${grouped}${p ? `.${String(p).padStart(2, "0")}` : ""}`;
}

/** An IST calendar day "2026-10-12" as "12 Oct 2026". Anything else reads "—". */
export function fmtYmd(ymd: string | null | undefined): string {
  const m = typeof ymd === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd) : null;
  if (!m) return "—";
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : "—";
}

/** The instant an IST calendar day begins (00:00 IST), or null when the day is not a date. */
export function istDayStartMs(ymd: string | null | undefined): number | null {
  const m = typeof ymd === "string" ? /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd) : null;
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : t - IST_OFFSET_MS;
}

/** The last minute of an IST calendar day (23:59 IST). A posting window includes its whole last day. */
export function istDayEndMs(ymd: string | null | undefined): number | null {
  const s = istDayStartMs(ymd);
  return s == null ? null : s + DAY_MS - 60_000;
}

function clock12(h24: number, min: number): string {
  return `${h24 % 12 || 12}:${String(min).padStart(2, "0")} ${h24 < 12 ? "am" : "pm"}`;
}

/** "17 Oct 2026, 6:30 pm IST" for an instant. */
export function fmtIst(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${clock12(d.getUTCHours(), d.getUTCMinutes())} IST`;
}

/** The browser's own offset is IST: a separate "your local time" line would only repeat the IST one. */
export function localIsIst(): boolean {
  return new Date().getTimezoneOffset() === -330;
}

/** "GMT+1", "PDT" or, where the browser cannot name it, "GMT+5:30" — the label for the browser's own time zone. */
export function localZoneLabel(at: number): string {
  try {
    const part = new Intl.DateTimeFormat("en", { timeZoneName: "short" }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName");
    if (part?.value) return part.value;
  } catch { /* fall through to the offset */ }
  const off = -new Date(at).getTimezoneOffset();
  const abs = Math.abs(off);
  return `GMT${off < 0 ? "-" : "+"}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
}

/** "11 Oct 2026, 7:30 pm" in the browser's own time zone (the zone label is named separately, once). */
export function fmtLocal(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clock12(d.getHours(), d.getMinutes())}`;
}
