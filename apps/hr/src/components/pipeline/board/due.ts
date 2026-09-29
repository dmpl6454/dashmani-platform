/**
 * Due chips compare the card's `YYYY-MM-DD` against the BROWSER-LOCAL today key (the
 * repo's IST rule: browser local time is IST for the users in India; never toISOString).
 */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export type DueState = "overdue" | "tomorrow" | "later" | null;

export function dueState(dueDate: string | null, isTerminal: boolean, now = new Date()): DueState {
  if (!dueDate || isTerminal) return null;
  const today = localDayKey(now);
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  const tomorrow = localDayKey(t);
  if (dueDate < today) return "overdue";
  if (dueDate === tomorrow) return "tomorrow";
  return "later";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Oct" for a YYYY-MM-DD day (no Date parsing, so no timezone shift). */
export function shortDay(day: string): string {
  const [, m, d] = day.split("-");
  const mi = Number(m) - 1;
  return MONTHS[mi] ? `${Number(d)} ${MONTHS[mi]}` : day;
}
