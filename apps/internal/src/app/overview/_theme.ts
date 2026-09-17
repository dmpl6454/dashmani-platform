// Design tokens for the Overview command centre — lifted from the supplied
// Claude Design prototype (dark navy canvas, gold navigation, glowing accents).
export const T = {
  bg: "#060D14",
  side: "#050A10",
  card: "#08131C",
  border: "#182C39",
  chip: "#0B1720",
  input: "#182630",
  inputBorder: "#223543",
  pop: "#0B1A26",
  popBorder: "#244358",
  rowHover: "#0F1E2A",
  text: "#F4F6F8",
  soft: "#D4DBE4",
  sub: "#A7B3C2",
  muted: "#738395",
  faint: "#4E5F70",
  gold: "#E9BD62",
  goldHi: "#F4D58C",
  teal: "#00D7A0",
  blue: "#238BFF",
  purple: "#A849F5",
  green: "#20C46E",
  pink: "#EC42B7",
  orange: "#F0803C",
  red: "#E52D47",
} as const;

// Chart series palettes, validated with the dataviz palette checker against the
// #08131C card surface (CVD separation, normal-vision floor, contrast). The
// design's exact accent hues stay on icons/KPIs; these slightly re-stepped
// variants are what adjacent slices and lines use so they stay tellable apart.
export const CATEGORICAL = ["#238BFF", "#B4872A", "#A849F5", "#0F926F", "#EC42B7", "#D9632A", "#8F7BFF", "#22A5B3"];
export const SERIES4 = ["#2F86F0", "#16AD85", "#DD3FAF", "#D9632A"];

export const TIER_COLOR: Record<"high" | "growing" | "emerging", string> = {
  high: T.gold,
  growing: T.teal,
  emerging: T.blue,
};

export function fmtCompact(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const unit: [number, string] | null = abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : null;
  if (!unit) return Math.round(n).toLocaleString("en-IN");
  const m = n / unit[0];
  // Three significant digits are plenty in a leaderboard: 417.9M reads as 418M.
  return `${trimZero(m.toFixed(Math.abs(m) >= 100 ? 0 : digits))}${unit[1]}`;
}

function trimZero(s: string): string {
  return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** Meta pays in USD; cents in, a compact dollar string out. */
export function fmtUsd(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "—";
  const d = cents / 100;
  const abs = Math.abs(d);
  if (abs >= 1e6) return `$${trimZero((d / 1e6).toFixed(2))}M`;
  if (abs >= 1e3) return `$${trimZero((d / 1e3).toFixed(abs >= 1e5 ? 0 : 1))}k`;
  return `$${d.toFixed(abs < 10 ? 2 : 0)}`;
}

export function fmtSignedPct(p: number | null | undefined, digits = 0): string {
  if (p == null || !Number.isFinite(p)) return "—";
  const sign = p > 0 ? "↑ " : p < 0 ? "↓ " : "";
  return `${sign}${Math.abs(p).toFixed(digits)}%`;
}

export function fmtSigned(n: number | null | undefined): string {
  if (n == null) return "—";
  const s = fmtCompact(Math.abs(n));
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

export function fmtDay(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function fmtDayYear(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function fmtRelative(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function initials(name: string | null | undefined): string {
  return (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "DS";
}

/** A "nice" axis ceiling: 1, 2, 2.5, 5 × 10^k at or above max. */
export function niceCeil(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 2.5, 5, 10]) if (m * base >= max) return m * base;
  return 10 * base;
}

export function countryName(code: string): string {
  try {
    if (typeof Intl !== "undefined" && "DisplayNames" in Intl) {
      const dn = new (Intl as unknown as { DisplayNames: new (l: string[], o: { type: string }) => { of: (c: string) => string | undefined } }).DisplayNames(["en"], { type: "region" });
      return dn.of(code) ?? code;
    }
  } catch {
    /* fall through */
  }
  return code;
}

export function greetingFor(hour: number): string {
  if (hour < 12) return "Good Morning";
  if (hour < 17) return "Good Afternoon";
  return "Good Evening";
}
