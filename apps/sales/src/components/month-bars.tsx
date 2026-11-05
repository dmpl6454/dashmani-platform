"use client";
import { useEffect, useRef, useState } from "react";
import { inrShort, MONTH_LONG, MONTH_SHORT } from "@dashmani/shared/src/sales/accounts";
import { fmtInr } from "@/lib/format";

// "Invoiced vs collected, by month" on /accounts (spec-accounts §5.4). One hand-drawn SVG: grouped
// columns, 12 months × 2 series on ONE ₹ axis. Series colours are the validated chart-1 / chart-2
// tokens (dark surface); text always wears ink tokens. Each month is a focusable hit band with a
// tooltip; future months carry no bars. No chart library.

export interface MonthPoint { month: string; invoicedPaise: number; collectedPaise: number; tdsPaise: number; future: boolean }

const C1 = "#3987e5"; // chart.1 — invoiced
const C2 = "#d95926"; // chart.2 — collected
const PLOT_H = 180;
const AXIS_H = 24;
const LEFT = 52;
const TOP = 8;

function niceStep(span: number): number {
  if (span <= 0) return 1;
  const raw = span / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

/** A column with a 4px rounded DATA end and a square end at the baseline. */
function barPath(x: number, w: number, yBase: number, yEnd: number): string {
  const h = Math.abs(yBase - yEnd);
  if (h < 0.5) return "";
  const r = Math.min(4, w / 2, h);
  if (yEnd < yBase) {
    return `M${x},${yBase}V${yEnd + r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd + r}V${yBase}Z`;
  }
  return `M${x},${yBase}V${yEnd - r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd - r}V${yBase}Z`;
}

const monthName = (m: string) => `${MONTH_LONG[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

export function MonthBars({ months, currentMonth }: { months: MonthPoint[]; currentMonth?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.max(280, Math.floor(entries[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const values = months.filter((m) => !m.future).flatMap((m) => [m.invoicedPaise, m.collectedPaise]);
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const step = niceStep(hi - lo || 1);
  const top = hi > 0 ? Math.ceil(hi / step) * step : lo < 0 ? 0 : step;
  const bottom = lo < 0 ? Math.floor(lo / step) * step : 0;
  const ticks: number[] = [];
  for (let v = bottom; v <= top + step / 2; v += step) ticks.push(Math.round(v));
  const allZero = values.every((v) => v === 0);

  const plotW = width - LEFT - 4;
  const band = plotW / 12;
  const barW = Math.max(2, Math.min(24, (band - 6) / 2));
  const y = (v: number) => TOP + PLOT_H - ((v - bottom) / (top - bottom || 1)) * PLOT_H;
  const y0 = y(0);
  const narrow = width < 520;
  const totals = months.reduce((s, m) => ({ inv: s.inv + m.invoicedPaise, col: s.col + m.collectedPaise }), { inv: 0, col: 0 });

  const h = hover == null ? null : months[hover];
  const tipLeft = hover == null ? 0 : Math.min(Math.max(LEFT + band * hover + band / 2 - 100, 0), Math.max(0, width - 200));

  return (
    <div ref={box} className="relative min-w-0" onMouseLeave={() => setHover(null)} onKeyDown={(e) => { if (e.key === "Escape") setHover(null); }}>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-2 mb-2" aria-hidden>
        <span className="inline-flex items-center gap-2"><span className="w-3 h-3 inline-block" style={{ background: C1 }} />Invoiced {inrShort(totals.inv)}</span>
        <span className="inline-flex items-center gap-2"><span className="w-3 h-3 inline-block" style={{ background: C2 }} />Collected {inrShort(totals.col)}</span>
      </div>
      <svg width="100%" height={TOP + PLOT_H + AXIS_H} viewBox={`0 0 ${width} ${TOP + PLOT_H + AXIS_H}`} role="img" aria-label="Invoiced and collected by month">
        {(allZero ? [0] : ticks).map((t) => (
          <g key={t}>
            <line x1={LEFT} x2={width - 4} y1={y(t)} y2={y(t)} stroke={t === 0 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.10)"} strokeWidth={1} />
            <text x={LEFT - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="#A7A7B0" style={{ fontVariantNumeric: "tabular-nums" }}>{inrShort(t)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const cx = LEFT + band * i + band / 2;
          const label = MONTH_SHORT[Number(m.month.slice(5, 7)) - 1];
          return (
            <g key={m.month}>
              {!m.future && (
                <>
                  <path d={barPath(cx - barW - 1, barW, y0, y(m.invoicedPaise))} fill={C1} />
                  <path d={barPath(cx + 1, barW, y0, y(m.collectedPaise))} fill={C2} />
                </>
              )}
              {(!narrow || i % 2 === 0) && (
                <text x={cx} y={TOP + PLOT_H + 16} textAnchor="middle" fontSize={10} fill={m.future ? "#5C5C66" : "#A7A7B0"}>{label}</text>
              )}
              {hover === i && <rect x={LEFT + band * i} y={TOP} width={band} height={PLOT_H} fill="rgba(255,255,255,0.04)" pointerEvents="none" />}
              <rect
                x={LEFT + band * i} y={TOP} width={band} height={PLOT_H + AXIS_H} fill="transparent" tabIndex={0}
                aria-label={`${monthName(m.month)}: invoiced ${fmtInr(m.invoicedPaise, { whole: true })}, collected ${fmtInr(m.collectedPaise, { whole: true })}, TDS ${fmtInr(m.tdsPaise, { whole: true })}`}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} style={{ outline: "none" }}
              />
            </g>
          );
        })}
      </svg>
      {h && (
        <div className="absolute z-10 card px-3 py-2 text-xs pointer-events-none w-[200px]" style={{ left: tipLeft, top: 28 }} role="status">
          <p className="font-bold mb-1">{monthName(h.month)}{h.month === currentMonth ? " (so far)" : ""}{h.future ? " · not yet" : ""}</p>
          <p className="flex justify-between gap-2"><span className="text-ink-3"><span className="inline-block w-2 h-2 mr-1" style={{ background: C1 }} />Invoiced</span><span className="font-mono font-bold">{fmtInr(h.invoicedPaise)}</span></p>
          <p className="flex justify-between gap-2"><span className="text-ink-3"><span className="inline-block w-2 h-2 mr-1" style={{ background: C2 }} />Collected</span><span className="font-mono font-bold">{fmtInr(h.collectedPaise)}</span></p>
          <p className="flex justify-between gap-2"><span className="text-ink-3">TDS</span><span className="font-mono">{fmtInr(h.tdsPaise)}</span></p>
        </div>
      )}
    </div>
  );
}
