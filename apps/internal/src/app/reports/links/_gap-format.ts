import { gapSpanDays, type GapRange } from "@dashmani/shared";

/**
 * Formatting for the Submission gaps panel (_submission-gaps.tsx, _gap-days.tsx).
 *
 * Everything works on the strings the API sends — IST calendar days ("YYYY-MM-DD") and IST
 * times ("YYYY-MM-DD HH:MM"). Nothing goes through new Date(...) + the browser's timezone,
 * so a device outside India still shows the IST day.
 */

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const nf = new Intl.NumberFormat("en-IN");

export function fmtDay(iso: string, currentYear: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m}${y !== currentYear ? ` ${y}` : ""}`;
}

export function fmtRange([s, e]: GapRange, currentYear: string): string {
  if (s === e) return fmtDay(s, currentYear);
  const [sy, sm, sd] = s.split("-");
  const [ey, em, ed] = e.split("-");
  if (sy === ey && sm === em) return `${Number(sd)}–${Number(ed)} ${MONTHS[Number(em) - 1]}${ey !== currentYear ? ` ${ey}` : ""}`;
  if (sy === ey) return `${Number(sd)} ${MONTHS[Number(sm) - 1]} – ${fmtDay(e, currentYear)}`;
  return `${fmtDay(s, currentYear)} – ${fmtDay(e, currentYear)}`;
}

/** "September 2026" for "2026-09". */
export function fmtMonth(month: string): string {
  const [y, m] = month.split("-");
  return `${MONTHS_LONG[Number(m) - 1] ?? m} ${y}`;
}

export function rangeDays(r: GapRange): number {
  return gapSpanDays(r[0], r[1]);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${nf.format(n)} ${n === 1 ? one : many}`;
}

export function pct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

/** A time with its own IST day appended when it is not the report day (a late submission). */
export function timeFor(reportDay: string, ist: string | null, year: string): string {
  if (!ist) return "";
  const [date, time] = ist.split(" ");
  return date === reportDay ? time : `${time} (${fmtDay(date, year)})`;
}
