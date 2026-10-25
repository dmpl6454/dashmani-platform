"use client";

/**
 * Follower trend for the Meta board — the gold area chart under the KPI tiles in the
 * Account Growth mockup.
 *
 * ⚠️ REAL DATA ONLY. The line is the Overview endpoint's `audience.series`: total followers
 * per day for the connected Meta channels, summed from API follower snapshots and
 * forward-filled (forwardFillFollowerSeries in overview.service.ts). No new endpoint and
 * no client-side arithmetic beyond drawing it.
 *
 * ⚠️ IT COVERS ONLY CHANNELS WHOSE HISTORY SPANS THE WHOLE PERIOD. A channel that first
 * appears mid-window would make the summed line jump by its whole audience on the day it
 * joined, so the server leaves those out and reports how many it used (`channelsUsed` of
 * `channelsLinked`). The caption says exactly that, so the line is never read as the
 * estate total shown in the Followers tile.
 *
 * Period mapping follows the board's own filter: 7d and 28d map to the same closed days
 * the tiles use, a month or custom range is passed through as-is, and Today / Yesterday
 * show the last 7 days — one day has no trend to draw — with the caption saying so.
 */

import { useState, type KeyboardEvent, type PointerEvent } from "react";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { fmtMetric, type ChannelWindowKey } from "@/lib/hooks/use-meta";
import { dateToIST } from "@dashmani/shared/src/utils/date";

type Audience = {
  days: number;
  series: Array<{ date: string; followers: number }>;
  channelsUsed: number;
  channelsLinked: number;
  delta: number | null;
};
type Envelope = { success: boolean; data: { audience: Audience; period: { start: string; end: string; clampedTo: string | null } } };

const DAY = 86_400_000;
// IST calendar day — never toISOString() (the UTC day is still "yesterday" 00:00–05:30 IST).
// Imported by module path: Account Growth must not pull the @dashmani/shared barrel.
const isoDay = (d: Date) => dateToIST(d);

function query(win: ChannelWindowKey, range: { start: string; end: string; label?: string } | null): { qs: string; label: string; note: string | null } {
  if (range) return { qs: `days=30&start=${range.start}&end=${range.end}`, label: range.label ?? "selected range", note: null };
  if (win === "days_28") {
    const end = isoDay(new Date(Date.now() - DAY));
    const start = isoDay(new Date(Date.now() - 28 * DAY));
    return { qs: `days=30&start=${start}&end=${end}`, label: "28d", note: null };
  }
  if (win === "week") return { qs: "days=7", label: "7d", note: null };
  return { qs: "days=7", label: "last 7 days", note: "A single day has no trend to draw, so the line shows the last 7 days." };
}

const fmtDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });

export function FollowerTrend({ win, range }: { win: ChannelWindowKey; range: { start: string; end: string; label?: string } | null }) {
  const q = query(win, range);
  const { data, error, isLoading } = useSWR(
    `/admin/overview?${q.qs}&aud=0&rev=0&vbc=0&trac=0`,
    (url: string) => apiFetch<Envelope>(url).then((r) => r.data),
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );

  const a = data?.audience;
  const pts = (a?.series ?? []).filter((p) => p.followers > 0);
  const usable = a && a.channelsUsed > 0 && pts.length >= 2;

  // Geometry in a 800x150 box (stretched to the card width, like the mockup).
  const W = 800, H = 150;
  let line = "", area = "", endY = 50;
  let yPct: number[] = [];
  if (usable) {
    const vals = pts.map((p) => p.followers);
    const mx = Math.max(...vals), mn = Math.min(...vals);
    const pad = (mx - mn) * 0.12 || Math.max(1, mx * 0.002);
    const y = (v: number) => H - ((v - mn + pad) / (mx - mn + pad * 2)) * (H - 8) - 4;
    line = pts.map((p, i) => `${i ? "L" : "M"}${((i / (pts.length - 1)) * W).toFixed(1)},${y(p.followers).toFixed(1)}`).join(" ");
    area = `${line} L${W},${H} L0,${H} Z`;
    endY = (y(vals[vals.length - 1]) / H) * 100;
    yPct = vals.map((v) => (y(v) / H) * 100);
  }
  const xLabels = usable
    ? [0, 0.25, 0.5, 0.75, 1].map((t) => fmtDay(pts[Math.round((pts.length - 1) * t)].date))
    : [];

  const delta = a?.delta ?? null;

  // ── Hover / touch / keyboard readout ──
  // The index of the day under the pointer (null = not hovering). Points are evenly spaced
  // across the width, so the nearest day is just the rounded fraction of the x position.
  const [hover, setHover] = useState<number | null>(null);
  const last = pts.length - 1;
  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(t * last));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = e.key === "ArrowLeft" ? -1 : 1;
      setHover((h) => Math.min(last, Math.max(0, (h ?? last) + step)));
    } else if (e.key === "Home") { e.preventDefault(); setHover(0); }
    else if (e.key === "End") { e.preventDefault(); setHover(last); }
    else if (e.key === "Escape") setHover(null);
  };
  const hp = hover !== null && usable ? pts[hover] : null;
  const hx = hover !== null && last > 0 ? (hover / last) * 100 : 0;
  const prevDay = hp && hover! > 0 ? hp.followers - pts[hover! - 1].followers : null;
  const sinceStart = hp && hover! > 0 ? hp.followers - pts[0].followers : null;
  const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toLocaleString("en-IN")}`;
  const tone = (n: number) => (n > 0 ? "text-ds-teal" : n < 0 ? "text-ds-redsoft" : "text-ds-t3");

  return (
    <div className="px-6 pt-[18px] pb-1.5 border-t border-ds-line">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <span className="text-[10px] tracking-[.18em] uppercase text-ds-gold font-semibold">Followers · {q.label}</span>
        {usable && (
          <span className="text-[11px] text-ds-t3">
            {delta !== null && (
              <span className={delta > 0 ? "text-ds-teal" : delta < 0 ? "text-ds-redsoft" : ""}>
                {delta > 0 ? "+" : ""}{fmtMetric(delta)} net
              </span>
            )}
            {delta !== null && " · "}
            {a!.channelsUsed} of {a!.channelsLinked} linked channels with history for the whole period
          </span>
        )}
      </div>

      {usable ? (
        <>
          <div className="relative h-[150px] mt-3">
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height="100%" className="block" role="img"
              aria-label={`Followers over the ${q.label}, from ${fmtMetric(pts[0].followers)} to ${fmtMetric(pts[pts.length - 1].followers)}`}>
              <defs>
                <linearGradient id="ds-follower-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="var(--hx-E9BD62)" stopOpacity=".3" />
                  <stop offset="1" stopColor="var(--hx-E9BD62)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path d={`M0 ${H / 3}H${W}M0 ${(H * 2) / 3}H${W}`} stroke="var(--hx-14273A)" strokeWidth="1" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
              <path d={area} fill="url(#ds-follower-fill)" />
              <path d={line} fill="none" stroke="var(--hx-E9BD62)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            </svg>
            {/* End-of-line marker; hidden while a day is being inspected. */}
            {hp === null && (
              <span
                aria-hidden="true"
                className="absolute h-2.5 w-2.5 -ml-[5px] -mt-[5px] rounded-full bg-ds-gold shadow-[0_0_0_4px_rgba(233,189,98,.18),0_0_14px_rgba(233,189,98,.6)]"
                style={{ left: "calc(100% - 7px)", top: `${endY}%` }}
              />
            )}
            {hp && (
              <>
                <span aria-hidden="true" className="absolute top-0 bottom-0 w-px bg-ds-gold/45 pointer-events-none" style={{ left: `${hx}%` }} />
                <span
                  aria-hidden="true"
                  className="absolute h-3 w-3 -ml-1.5 -mt-1.5 rounded-full bg-ds-gold border-2 border-ds-bg shadow-[0_0_0_4px_rgba(233,189,98,.22)] pointer-events-none"
                  style={{ left: `${hx}%`, top: `${yPct[hover!]}%` }}
                />
                <div
                  role="status"
                  className="absolute z-10 top-1 min-w-[170px] rounded-[8px] border border-ds-line3 bg-ds-inset/95 px-3 py-2 shadow-[0_10px_28px_rgba(0,0,0,.45)] pointer-events-none whitespace-nowrap"
                  // Kept inside the card: flips to the left of the guide on the right half.
                  style={hx > 55 ? { right: `calc(${100 - hx}% + 10px)` } : { left: `calc(${hx}% + 10px)` }}
                >
                  <div className="text-[10.5px] text-ds-t3">{fmtDay(hp.date)}</div>
                  <div className="mt-0.5 text-[15px] font-semibold text-ds-text tabular-nums">
                    {hp.followers.toLocaleString("en-IN")} <span className="text-[11px] font-medium text-ds-t3">followers</span>
                  </div>
                  {prevDay !== null && (
                    <div className="mt-1 text-[11px] text-ds-t3 tabular-nums">
                      <span className={tone(prevDay)}>{signed(prevDay)}</span> vs previous day
                    </div>
                  )}
                  {sinceStart !== null && (
                    <div className="text-[11px] text-ds-t3 tabular-nums">
                      <span className={tone(sinceStart)}>{signed(sinceStart)}</span> since {fmtDay(pts[0].date)}
                    </div>
                  )}
                </div>
              </>
            )}
            {/* Transparent hit area over the whole plot — mouse, pen and touch all land here. */}
            <div
              tabIndex={0}
              role="slider"
              aria-label="Inspect followers by day — use left and right arrow keys"
              aria-valuemin={0}
              aria-valuemax={last}
              aria-valuenow={hover ?? last}
              aria-valuetext={hp ? `${fmtDay(hp.date)}: ${hp.followers.toLocaleString("en-IN")} followers` : undefined}
              className="absolute inset-0 cursor-crosshair touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-ds-gold/50 rounded-[4px]"
              onPointerMove={pick}
              onPointerDown={pick}
              // A finger lifting also fires pointerleave; keep the tapped day showing until
              // the user taps elsewhere (blur) instead of flashing it away.
              onPointerLeave={(e) => { if (e.pointerType !== "touch") setHover(null); }}
              onFocus={() => setHover((h) => h ?? last)}
              onBlur={() => setHover(null)}
              onKeyDown={onKey}
            />
          </div>
          <div className="flex justify-between pt-2 pb-2.5 text-[10.5px] text-ds-t3">
            {xLabels.map((x, i) => <span key={i} className="whitespace-nowrap">{x}</span>)}
          </div>
          {q.note && <p className="pb-2.5 text-[10.5px] text-ds-t3">{q.note}</p>}
        </>
      ) : (
        <p className="py-6 text-[11.5px] text-ds-t3 leading-[1.6]">
          {isLoading
            ? "Loading follower history…"
            : error
              ? "The follower trend couldn't be loaded just now — the figures above are unaffected."
              : "Not enough follower history for this period yet. The line appears once at least one linked channel has API follower snapshots covering every day of it."}
        </p>
      )}
    </div>
  );
}
