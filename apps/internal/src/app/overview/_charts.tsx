"use client";
import { useMemo, useState } from "react";
import { T, fmtCompact, fmtDay, niceCeil, TIER_COLOR } from "./_theme";
import type { CityTier } from "./_types";
import indiaMap from "./_india-map.json";

// All charts are plain SVG in a 300×100 (or square) viewBox stretched to the
// card, exactly as the design prototype draws them — thin strokes, glowing
// endpoints, recessive grid, and a hover layer that names date + value.

// ───────────────────────────── sparkline ─────────────────────────────

export function Sparkline({ values, color, id }: { values: number[]; color: string; id: string }) {
  const pts = useMemo(() => {
    const v = values.filter((x) => Number.isFinite(x));
    if (v.length < 2) return null;
    const min = Math.min(...v);
    const max = Math.max(...v);
    const span = max - min || 1;
    return v.map((x, i) => [i * (90 / (v.length - 1)), 32 - ((x - min) / span) * 28 + 1] as const);
  }, [values]);
  if (!pts) return null;
  const line = "M" + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L");
  return (
    <svg viewBox="0 0 90 34" preserveAspectRatio="none" className="ov-spark" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".45" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L90 34L0 34Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ───────────────────────────── area line ─────────────────────────────

export interface Point {
  date: string;
  value: number | null;
}

export function AreaLineChart({
  points,
  color,
  id,
  formatValue = (v) => fmtCompact(v),
  unitLabel,
  zeroBased = false,
}: {
  points: Point[];
  color: string;
  id: string;
  formatValue?: (v: number) => string;
  unitLabel: string;
  zeroBased?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState(true);
  const N = points.length;
  const vals = points.map((p) => p.value);
  const finite = vals.filter((v): v is number => v != null);
  const dataMax = finite.length ? Math.max(...finite) : 0;
  const dataMin = finite.length ? Math.min(...finite) : 0;
  // A follower line barely moves against a zero baseline; lines may float.
  const lo = zeroBased ? 0 : Math.max(0, dataMin - (dataMax - dataMin) * 0.6);
  // Headroom above the last point keeps its pinned tooltip inside the plot.
  const hi = niceCeil((dataMax - lo) * 1.15) + lo;
  const yOf = (v: number) => 100 - ((v - lo) / (hi - lo || 1)) * 100;
  const xOf = (i: number) => (N > 1 ? i * (300 / (N - 1)) : 150);
  const segs: string[] = [];
  let open = false;
  vals.forEach((v, i) => {
    if (v == null) { open = false; return; }
    segs.push(`${open ? "L" : "M"}${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`);
    open = true;
  });
  const line = segs.join("");
  const firstIdx = vals.findIndex((v) => v != null);
  const lastIdx = vals.length - 1 - [...vals].reverse().findIndex((v) => v != null);
  const fill = firstIdx >= 0 ? `${line}L${xOf(lastIdx).toFixed(1)} 100L${xOf(firstIdx).toFixed(1)} 100Z` : "";
  const active = hover ?? (pinned && lastIdx >= 0 ? lastIdx : null);
  const ticks = [0, 1, 2, 3].map((k) => lo + ((hi - lo) * (4 - k)) / 4);
  const xTicks = points.filter((_, i) => N <= 8 || i % Math.ceil(N / 7) === 1 || i === N - 1);

  if (!finite.length) return <div className="ov-chart-empty">No data for this period</div>;
  const pct = active != null ? xOf(active) / 3 : 0;
  const tipPos: React.CSSProperties =
    pct > 85 ? { right: 0 } : pct < 15 ? { left: 0 } : { left: `${pct}%`, transform: "translateX(-50%)" };

  return (
    <div className="ov-chart">
      <div className="ov-yaxis">
        {ticks.map((t, i) => <span key={i}>{formatValue(t)}</span>)}
        <span style={{ opacity: zeroBased ? 1 : 0 }}>{formatValue(lo)}</span>
      </div>
      <div className="ov-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-label={`${unitLabel} trend, ${points.length} days`}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity=".35" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d="M0 0.5H300M0 25.5H300M0 50.5H300M0 75.5H300M0 99.5H300" stroke={T.border} strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {fill && <path d={fill} fill={`url(#${id})`} />}
          <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {points.map((_, i) => (
            <rect
              key={i}
              x={xOf(i) - (300 / Math.max(N - 1, 1)) / 2}
              y="0"
              width={300 / Math.max(N - 1, 1)}
              height="100"
              fill="transparent"
              onMouseEnter={() => { setHover(i); setPinned(false); }}
            />
          ))}
        </svg>
        {vals.map((v, i) =>
          v == null ? null : (
            <span
              key={i}
              className="ov-dot"
              style={{
                left: `${xOf(i) / 3}%`,
                top: `${yOf(v)}%`,
                background: color,
                boxShadow: i === lastIdx ? `0 0 0 3px ${color}40, 0 0 12px ${color}` : i === active ? `0 0 0 3px ${color}55` : "none",
              }}
            />
          ),
        )}
        {active != null && vals[active] != null && (
          <div className={`ov-tip ${yOf(vals[active] as number) < 34 ? "is-below" : ""}`} style={{ ...tipPos, top: `${yOf(vals[active] as number)}%` }}>
            <div className="ov-tip-v">{formatValue(vals[active] as number)}</div>
            <div className="ov-tip-d">{fmtDay(points[active].date)} · {unitLabel}</div>
          </div>
        )}
      </div>
      <span />
      <div className="ov-xaxis">{xTicks.map((p) => <span key={p.date}>{fmtDay(p.date)}</span>)}</div>
    </div>
  );
}

// ───────────────────────────── cumulative bars ─────────────────────────────

export function CumulativeBars({
  points,
  formatValue,
  unitLabel,
}: {
  points: Array<{ date: string; cumulative: number; daily: number | null }>;
  formatValue: (v: number) => string;
  unitLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [pinned, setPinned] = useState(true);
  const N = points.length;
  const max = niceCeil(Math.max(0, ...points.map((p) => p.cumulative)) * 1.15);
  const active = hover ?? (pinned && N > 0 ? N - 1 : null);
  const ticks = [4, 3, 2, 1, 0].map((k) => (max * k) / 4);
  const xTicks = points.filter((_, i) => N <= 8 || i % Math.ceil(N / 7) === 1 || i === N - 1);
  if (!N || max <= 0) return <div className="ov-chart-empty">No revenue reported for this period</div>;
  const pct = active != null ? ((active + 0.5) / N) * 100 : 0;
  const tipPos: React.CSSProperties =
    pct > 85 ? { right: 0 } : pct < 15 ? { left: 0 } : { left: `${pct}%`, transform: "translateX(-50%)" };
  return (
    <div className="ov-chart ov-chart-bars">
      <div className="ov-yaxis">{ticks.map((t, i) => <span key={i}>{formatValue(t)}</span>)}</div>
      <div className="ov-plot" onMouseLeave={() => setHover(null)}>
        <svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-label={`Cumulative ${unitLabel}, ${N} days`}>
          <path d="M0 0.5H300M0 25.5H300M0 50.5H300M0 75.5H300M0 99.5H300" stroke={T.border} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="ov-bars">
          {points.map((p, i) => {
            const isLast = i === N - 1;
            const isActive = i === active;
            return (
              <button
                key={p.date}
                type="button"
                className="ov-bar"
                aria-label={`${fmtDay(p.date)}: ${formatValue(p.cumulative)} cumulative`}
                onMouseEnter={() => { setHover(i); setPinned(false); }}
                onFocus={() => { setHover(i); setPinned(false); }}
              >
                <span
                  style={{
                    height: `${(p.cumulative / max) * 100}%`,
                    background: isLast ? `linear-gradient(180deg,${T.goldHi},${T.gold})` : isActive ? "#F0CD7A" : `linear-gradient(180deg,${T.gold},#8C6F2E)`,
                    boxShadow: isLast || isActive ? "0 0 10px rgba(233,189,98,.7)" : "none",
                  }}
                />
              </button>
            );
          })}
        </div>
        {active != null && (
          <div className={`ov-tip ${100 - (points[active].cumulative / max) * 100 < 34 ? "is-below" : ""}`} style={{ ...tipPos, top: `${100 - (points[active].cumulative / max) * 100}%` }}>
            <div className="ov-tip-v">{formatValue(points[active].cumulative)}</div>
            <div className="ov-tip-d">{fmtDay(points[active].date)} · cumulative · {points[active].daily == null ? "day not yet reported" : `+${formatValue(points[active].daily)}`}</div>
          </div>
        )}
      </div>
      <span />
      <div className="ov-xaxis">{xTicks.map((p) => <span key={p.date}>{fmtDay(p.date)}</span>)}</div>
    </div>
  );
}

// ───────────────────────────── donut ─────────────────────────────

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export interface Slice {
  label: string;
  value: number;
  color: string;
}

export function Donut({
  slices,
  size,
  thickness,
  selected,
  onSelect,
  center,
  centerLabel,
  ariaLabel,
}: {
  slices: Slice[];
  size: number;
  thickness: number;
  selected?: number | null;
  onSelect?: (i: number | null) => void;
  center: string;
  centerLabel: string;
  ariaLabel: string;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0);
  const cx = size / 2;
  const r = size / 2 - thickness / 2 - 2;
  const gap = (2.4 * Math.PI) / 180;
  let a = -Math.PI / 2;
  const arcs = slices.map((s, i) => {
    const span = total > 0 ? (s.value / total) * 2 * Math.PI : 0;
    const d = span > gap ? arc(cx, cx, r, a + gap / 2, a + span - gap / 2) : "";
    a += span;
    return { d, color: s.color, i };
  });
  return (
    <div className="ov-donut" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-label={ariaLabel} role="img">
        {arcs.map((x) =>
          x.d ? (
            <path
              key={x.i}
              d={x.d}
              fill="none"
              stroke={x.color}
              strokeWidth={selected === x.i ? thickness + 4 : thickness}
              opacity={selected == null || selected === x.i ? 1 : 0.35}
              style={{ cursor: onSelect ? "pointer" : "default", transition: "opacity .15s" }}
              onClick={onSelect ? () => onSelect(selected === x.i ? null : x.i) : undefined}
            />
          ) : null,
        )}
      </svg>
      <div className="ov-donut-c">
        <span className="ov-donut-v" style={{ fontSize: size > 100 ? 20 : 15 }}>{center}</span>
        <span className="ov-donut-l">{centerLabel}</span>
      </div>
    </div>
  );
}

// ───────────────────────────── indexed lines ─────────────────────────────

export function IndexedLines({
  series,
  dates,
}: {
  series: Array<{ label: string; color: string; values: Array<number | null> }>;
  dates: string[];
}) {
  const N = dates.length;
  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  // ⚠️ The window is whatever the caller passed — Content Traction became detachable
  // (7/14/30/90) but these strings still said "7 days" regardless, so a reader (and a
  // screen-reader user) on a 90-day card was told it was a 7-day trend.
  if (!all.length) return <div className="ov-chart-empty">No traction data for the last {N} days</div>;
  const lo = Math.floor(Math.min(...all, 100) / 10) * 10 - 5;
  const hi = Math.ceil(Math.max(...all, 100) / 10) * 10 + 5;
  const yOf = (v: number) => 100 - ((v - lo) / (hi - lo || 1)) * 100;
  const xOf = (i: number) => (N > 1 ? i * (300 / (N - 1)) : 150);
  const ticks = [3, 2, 1, 0].map((k) => lo + ((hi - lo) * k) / 3);
  return (
    <div className="ov-chart ov-chart-idx">
      <div className="ov-yaxis ov-yaxis-sm">{ticks.map((t, i) => <span key={i}>{Math.round(t)}</span>)}</div>
      <div className="ov-plot">
        <svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-label={`Indexed ${N}-day trend of views, engagements, reactions and shares`}>
          <path d="M0 0.5H300M0 33.5H300M0 66.5H300M0 99.5H300" stroke={T.border} strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {series.map((s) => {
            let d = "";
            let open = false;
            s.values.forEach((v, i) => {
              if (v == null) { open = false; return; }
              d += `${open ? "L" : "M"}${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`;
              open = true;
            });
            return <path key={s.label} d={d} fill="none" stroke={s.color} strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />;
          })}
        </svg>
        {series.map((s) =>
          s.values.map((v, i) =>
            v == null ? null : (
              <span
                key={`${s.label}-${i}`}
                className="ov-dot"
                title={`${s.label} · ${fmtDay(dates[i])} · index ${v.toFixed(0)}`}
                style={{ left: `${xOf(i) / 3}%`, top: `${yOf(v)}%`, background: s.color }}
              />
            ),
          ),
        )}
      </div>
      <div className="ov-legend">
        {series.map((s) => (
          <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>
        ))}
      </div>
      <span className="ov-idx-note">Idx</span>
      {/* ⚠️ THINNED, targeting ~8 labels. This rendered one label PER DAY, so a card
          detached to 90 days needed roughly 1378px of label text in a ~137px axis and the
          dates collapsed into an unreadable smear (the "S3S4S5S6S7…" in the card).
          Same rule AreaLineChart already uses. */}
      <div className="ov-xaxis">
        {dates
          .filter((_, i) => N <= 8 || i % Math.ceil(N / 7) === 1 || i === N - 1)
          .map((d) => <span key={d}>{fmtDay(d).replace(/^(\w{3}) /, (_, m) => `${m[0]}`)}</span>)}
      </div>
      <span className="ov-idx-note">day 1 = 100</span>
    </div>
  );
}

// ───────────────────────────── India map ─────────────────────────────

const MAP = indiaMap as unknown as { viewBox: [number, number]; path: string; cities: Record<string, [number, number]> };

export interface MapCity {
  name: string;
  state: string | null;
  share: number;
  value: number;
  tier: CityTier;
}

export function IndiaMap({ cities }: { cities: MapCity[] }) {
  const [hover, setHover] = useState<{ x: number; y: number; c: MapCity } | null>(null);
  const [W, H] = MAP.viewBox;
  const plotted = cities
    .map((c) => ({ c, xy: MAP.cities[c.name] ?? null }))
    .filter((x): x is { c: MapCity; xy: [number, number] } => x.xy !== null);
  const maxShare = Math.max(...plotted.map((p) => p.c.share), 1);
  return (
    <div className="ov-map">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="India map with Instagram audience hotspots by city">
        <defs>
          <filter id="ov-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <path d={MAP.path} fill="#0D1C29" stroke="#2A4658" strokeWidth="0.8" />
        {plotted.map(({ c, xy }) => {
          const r = 1.6 + Math.sqrt(c.share / maxShare) * 3.2;
          const col = TIER_COLOR[c.tier];
          return (
            <g key={c.name}>
              <circle className="ov-pulse" cx={xy[0]} cy={xy[1]} r={r * 2.2} fill={col} opacity=".18" filter="url(#ov-glow)" />
              <circle
                cx={xy[0]}
                cy={xy[1]}
                r={r}
                fill={col}
                opacity=".95"
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setHover({ x: xy[0], y: xy[1], c })}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>
      {hover && (() => {
        // ⚠️ A fixed translate(-50%,-115%) pushed the tooltip off the card for any city
        // near an edge — western cities lost their first characters ("…abad, Uttar
        // Pradesh") behind the card's left border. Anchor the tooltip's own edge to the
        // dot instead of its centre once the dot is near a side, and drop it below the
        // dot when it is near the top.
        const xPct = (hover.x / W) * 100;
        const yPct = (hover.y / H) * 100;
        const tx = xPct < 24 ? "-8%" : xPct > 76 ? "-92%" : "-50%";
        const below = yPct < 22;
        return (
          <div
            className="ov-map-tip"
            style={{ left: `${xPct}%`, top: `${yPct}%`, transform: `translate(${tx}, ${below ? "18%" : "-115%"})` }}
          >
            <b>{hover.c.name}</b>{hover.c.state ? `, ${hover.c.state}` : ""}<br />
            {hover.c.share.toFixed(1)}% of audience · {fmtCompact(hover.c.value)} followers
          </div>
        );
      })()}
    </div>
  );
}
