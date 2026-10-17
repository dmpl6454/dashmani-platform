"use client";
import { fmtIst, fmtLocal, fmtUntil, fmtYmd, istDayEndMs, istDayStartMs, localIsIst, localZoneLabel } from "@/lib/format";

// Posting windows and expiry times. A window is two IST calendar days, both included: it opens at the start of the
// first day (00:00 IST) and closes at the end of the last (23:59 IST). Everything is stated in IST first, because
// that is what the booking was made in, and then, for a creator whose own clock is somewhere else, in their local
// time too: the two lines are the same moments.

type Window = { from: string | null; to: string | null };

/** The window in words ("12 Oct 2026 to 14 Oct 2026"), or null when the booking set no dates. */
export function windowText(w: Window): string | null {
  const { from, to } = w;
  if (from && to) return from === to ? fmtYmd(from) : `${fmtYmd(from)} to ${fmtYmd(to)}`;
  if (from) return `From ${fmtYmd(from)}`;
  if (to) return `Until ${fmtYmd(to)}`;
  return null;
}

/** "11 Oct 2026, 7:30 pm to 14 Oct 2026, 7:29 pm (GMT+1)" for the window in the browser's own time zone, or null when it is IST already. */
export function windowLocalText(w: Window): string | null {
  if (localIsIst()) return null;
  const start = istDayStartMs(w.from);
  const end = istDayEndMs(w.to);
  const at = start ?? end;
  if (at == null) return null;
  const zone = localZoneLabel(at);
  if (start != null && end != null) return `${fmtLocal(start)} to ${fmtLocal(end)} (${zone})`;
  if (start != null) return `From ${fmtLocal(start)} (${zone})`;
  return `Until ${fmtLocal(end as number)} (${zone})`;
}

/** The window as the detail page shows it: the days, what that means in IST, and the same moments in local time. */
export function WindowBlock({ window }: { window: Window }) {
  const text = windowText(window);
  if (!text) return <span className="text-ink-3">Not set</span>;
  const start = istDayStartMs(window.from);
  const end = istDayEndMs(window.to);
  const local = windowLocalText(window);
  return (
    <>
      <span className="block text-white break-words">{text}</span>
      <span className="mt-1 block text-xs text-ink-3 leading-relaxed break-words">
        IST, both days included
        {start != null && end != null ? <>: opens {fmtIst(start)}, closes {fmtIst(end)}.</> : "."}
      </span>
      {local && <span className="mt-1 block text-xs text-ink-3 leading-relaxed break-words">Your time: {local}</span>}
    </>
  );
}

/** An instant in IST, with a countdown while it is ahead, and local time for a creator outside IST. */
export function InstantBlock({ iso, now }: { iso: string; now: number | null }) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return <span className="text-ink-3">—</span>;
  const until = now != null ? fmtUntil(iso, now) : null;
  const local = localIsIst() ? null : `${fmtLocal(ms)} (${localZoneLabel(ms)})`;
  return (
    <>
      <span className="block text-white break-words">
        {fmtIst(ms)}
        {until && until !== "expired" && <span className="text-ink-3"> · {until}</span>}
      </span>
      {local && <span className="mt-1 block text-xs text-ink-3 leading-relaxed break-words">Your time: {local}</span>}
    </>
  );
}
