"use client";
/**
 * "Today" / "Yesterday" / "Wed, 30 Sep" between a thread's rows (R8), wherever the local day
 * changes — the label comes from the shared daySeparatorBefore(), against the list's
 * useLocalDayKey() value, so it relabels itself at midnight. A plain list item (its text is
 * what a screen reader reads), styled like the "New messages" divider but neutral — in ink-3
 * (≈ 5.6:1 on the page background; ink-4 is ≈ 2.9:1, too faint for a label people read).
 */
export function DaySeparator({ label }: { label: string }) {
  return (
    <li data-day-separator className="list-none flex items-center gap-2 px-3 pt-3 pb-1">
      <span className="h-px flex-1 bg-rule" aria-hidden />
      <span className="text-[11.5px] font-semibold text-ink-3">{label}</span>
      <span className="h-px flex-1 bg-rule" aria-hidden />
    </li>
  );
}
