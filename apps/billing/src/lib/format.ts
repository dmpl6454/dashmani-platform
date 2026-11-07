// Money, numbers and dates. Fixed en-IN so the static render and the browser agree, and so
// rupees group the Indian way (₹12,34,567). Amounts travel as integer PAISE on the API.

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 2 });
const inrWhole = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

export function fmtInr(paise: number | null | undefined, opts: { whole?: boolean } = {}): string {
  if (paise == null || !Number.isFinite(paise)) return "—";
  const rupees = paise / 100;
  return opts.whole ? inrWhole.format(rupees) : inr.format(rupees);
}

/** Rupee input (a decimal string) → integer paise; null when not a number. */
export function toPaise(rupees: string | number): number | null {
  const n = typeof rupees === "number" ? rupees : Number(String(rupees).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const trim = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, ""));
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}K`;
  return String(n);
}

export function fmtInt(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? "—" : new Intl.NumberFormat("en-IN").format(n);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "26 Oct 2026" in IST, from an ISO instant or a YYYY-MM-DD day. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-").map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const ist = new Date(d.getTime() + 330 * 60_000);
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

/** Today's date as YYYY-MM-DD in IST (the convention for every date key in this platform). */
export function todayIST(): string {
  const ist = new Date(Date.now() + 330 * 60_000);
  return ist.toISOString().slice(0, 10);
}

export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((Date.parse(toDay) - Date.parse(fromDay)) / 86_400_000);
}
