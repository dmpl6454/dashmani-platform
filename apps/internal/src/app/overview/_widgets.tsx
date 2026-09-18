"use client";
import type { ReactNode } from "react";
import { T } from "./_theme";

export function Card({
  title,
  right,
  children,
  className = "",
  ariaLabel,
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <section className={`ov-card ${className}`} aria-label={ariaLabel}>
      {(title || right) && (
        <div className="ov-card-h">
          {/* `title` attr only when the heading is a plain string — the ones that carry a
              pill are ReactNodes and would stringify to "[object Object]". */}
          {title && <h2 title={typeof title === "string" ? title : undefined}>{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Chip({ children, onClick, active, ariaHasPopup }: { children: ReactNode; onClick?: () => void; active?: boolean; ariaHasPopup?: boolean }) {
  if (!onClick) return <span className="ov-chip">{children}</span>;
  return (
    <button type="button" className={`ov-chip ${active ? "is-active" : ""}`} onClick={onClick} aria-haspopup={ariaHasPopup ? "menu" : undefined}>
      {children}
      <Caret />
    </button>
  );
}

export function Caret() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function ViewAll({ href, label = "View All" }: { href: string; label?: string }) {
  // The words collapse under 1366px (see .ov-viewall-t) so a card header never has to
  // buy them with the title's letters; the arrow always stays.
  return <a className="ov-viewall" href={href} title={label}><span className="ov-viewall-t">{label} </span>→</a>;
}

/**
 * ⚠️ Card header actions MUST be wrapped in this single element.
 *
 * `.ov-card-h` is `display:flex; justify-content:space-between` and its `h2` is the only
 * shrinkable item, so every extra header child is paid for out of the title's width.
 *
 * ⚠️ CORRECTION TO THE OLD COMMENT HERE (and to CLAUDE.md, which still repeats it): the
 * h2 is NO LONGER a flex container — overview.css:120 is a plain block with
 * `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`, so its ellipsis is LIVE
 * and a third child now TRUNCATES the title with a visible "…" rather than hard-clipping
 * it mid-glyph. That makes an extra child degrade gracefully instead of silently, but it
 * does not make it free: 1366px is the binding width case, where one more icon button
 * costs a title roughly 14px. Group actions here, and keep `Card`'s `title` attribute so
 * a truncated title is still recoverable on hover.
 */
export function CardActions({ children }: { children: ReactNode }) {
  return <span className="ov-card-actions">{children}</span>;
}

/** Icon-only so a header can carry it without costing the title its letters. */
export function ExpandBtn({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="ov-expand-btn" onClick={onClick} title={label} aria-label={label}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
      </svg>
    </button>
  );
}

export interface ExpandSpec {
  title: string;
  /** States the exact window and coverage the rows were computed over. */
  subtitle?: string;
  /**
   * ⚠️ OPTIONAL, because a picture-only expand exists. When `columns` is omitted no
   * table is rendered at all — without this a chart-only expand printed the empty-state
   * line "Nothing to show for this period." underneath a perfectly good chart.
   */
  columns?: string[];
  /** Per-column alignment; defaults to left. */
  align?: Array<"left" | "right">;
  /**
   * `onRowClick` makes the row interactive. It stays OPTIONAL per row so a table whose
   * rows have no sensible target (cities, demographic buckets) renders exactly as before.
   */
  rows?: Array<{ key: string; cells: ReactNode[]; onClick?: () => void; label?: string }>;
  /** Rendered above the table — a larger map or chart. */
  lead?: ReactNode;
  note?: string;
}

export function ExpandModal({ spec, onClose }: { spec: ExpandSpec; onClose: () => void }) {
  const align = spec.align ?? [];
  const rows = spec.rows ?? [];
  const columns = spec.columns ?? [];
  const hasTable = columns.length > 0;
  return (
    <>
      {/* ⚠️ `ov-modal-bg`, NOT the bare `ov-drawer-bg` this used to emit. That class is
          shared with Drawer, so raising it to stack a drawer above the modal would have
          raised the MODAL'S OWN dimmer above the modal and covered it completely. The two
          scrims now have their own z-indexes. */}
      <div className="ov-drawer-bg ov-modal-bg" onClick={onClose} />
      <section role="dialog" aria-modal="true" aria-label={spec.title} className="ov-modal">
        <div className="ov-modal-h">
          <div style={{ minWidth: 0 }}>
            <h2>{spec.title}</h2>
            {spec.subtitle && <div className="ov-modal-s">{spec.subtitle}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ov-x">×</button>
        </div>
        {spec.lead && <div className="ov-modal-lead">{spec.lead}</div>}
        {hasTable && (
          <div className="ov-modal-body">
            <table className="ov-modal-table">
              <thead>
                <tr>{columns.map((c, i) => <th key={c} style={{ textAlign: align[i] ?? "left" }}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  /* ⚠️ NO `role="button"` HERE, deliberately. It would replace the row's
                     own semantics, leaving a <tbody> whose children are not rows — every
                     cell in a 419-row table would lose its column/header association for
                     assistive tech. A <tr> stays a row; tabIndex makes it focusable and
                     the key handler gives it Enter/Space, which is what it actually needs. */
                  <tr
                    key={r.key}
                    className={r.onClick ? "is-clickable" : undefined}
                    onClick={r.onClick}
                    tabIndex={r.onClick ? 0 : undefined}
                    aria-label={r.onClick ? r.label : undefined}
                    onKeyDown={r.onClick ? (e) => {
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); r.onClick!(); }
                    } : undefined}
                  >
                    {r.cells.map((c, i) => <td key={i} style={{ textAlign: align[i] ?? "left" }}>{c}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <div className="ov-empty">Nothing to show for this period.</div>}
          </div>
        )}
        <div className="ov-modal-foot">{spec.note ?? `${rows.length} rows · live platform data`}</div>
      </section>
    </>
  );
}

export function Menu({ children, width = 150, align = "right" }: { children: ReactNode; width?: number; align?: "left" | "right" }) {
  return (
    <div role="menu" className="ov-menu" style={{ width, [align]: 0 }}>
      {children}
    </div>
  );
}

export function MenuItem({ children, onClick, active, meta, danger }: { children: ReactNode; onClick: () => void; active?: boolean; meta?: ReactNode; danger?: boolean }) {
  return (
    <button type="button" role="menuitem" className={`ov-menu-item ${active ? "is-active" : ""}`} onClick={onClick} style={danger ? { color: T.red } : undefined}>
      <span>{children}</span>
      {meta && <span className="ov-menu-meta">{meta}</span>}
    </button>
  );
}

export function Trend({ pct, reliable = true, muted }: { pct: number | null | undefined; reliable?: boolean; muted?: boolean }) {
  if (pct == null || !Number.isFinite(pct)) return <span className="ov-trend is-none">—</span>;
  const up = pct >= 0;
  return (
    <span
      className={`ov-trend ${up ? "is-up" : "is-down"} ${muted ? "is-muted" : ""}`}
      title={reliable ? undefined : "Baseline period is only partially covered — treat as indicative"}
    >
      {up ? "↑" : "↓"} {Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%{reliable ? "" : "*"}
    </span>
  );
}

export function Avatar({ url, name, size = 20, tile }: { url: string | null | undefined; name: string; size?: number; tile: string }) {
  const ini = name.replace(/^@/, "").slice(0, 2).toUpperCase();
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" width={size} height={size} className="ov-avatar" style={{ width: size, height: size }} referrerPolicy="no-referrer" />
  ) : (
    <span className="ov-avatar ov-avatar-ini" style={{ width: size, height: size, background: tile, fontSize: size * 0.4 }}>{ini}</span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="ov-empty">{children}</div>;
}

export function Skeleton() {
  const rows = [
    { cols: "repeat(5,1fr)", n: 5 },
    { cols: "35fr 34fr 31fr", n: 3 },
    { cols: "28fr 25fr 24fr 23fr", n: 4 },
    { cols: "23fr 30fr 24fr 23fr", n: 4 },
  ];
  return (
    <div className="ov-grid" role="status" aria-live="polite" aria-label="Loading dashboard">
      {rows.map((r, i) => (
        <div key={i} className="ov-row" style={{ gridTemplateColumns: r.cols }}>
          {Array.from({ length: r.n }).map((_, j) => (
            <div key={j} className="ov-shimmer" style={{ animationDelay: `${(i * 4 + j) * 0.07}s` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function StateMessage({
  tone,
  title,
  body,
  cta,
  onCta,
}: {
  tone: "error" | "empty";
  title: string;
  body: string;
  cta: string;
  onCta: () => void;
}) {
  const accent = tone === "error" ? T.red : T.sub;
  const tile = tone === "error" ? "rgba(229,45,71,.15)" : T.input;
  return (
    <div className="ov-state" role="status" aria-live="polite">
      <div className="ov-state-box">
        <div className="ov-state-icon" style={{ background: tile, color: accent }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d={tone === "error" ? "M12 8v5M12 16.5v.5M12 3l9.5 17H2.5z" : "M4 6h16M4 12h10M4 18h6"} />
          </svg>
        </div>
        <div className="ov-state-t">{title}</div>
        <div className="ov-state-b">{body}</div>
        <button type="button" className="ov-cta" onClick={onCta}>{cta}</button>
      </div>
    </div>
  );
}

export interface DrawerRow {
  label: string;
  value: ReactNode;
}

export interface DrawerSpec {
  kind: string;
  accent: string;
  title: string;
  sub?: string;
  hero?: { label: string; value: string; trend?: ReactNode; note?: string };
  rows: DrawerRow[];
  href?: { label: string; url: string; external?: boolean };
  note?: string;
}

export function Drawer({ spec, onClose, stacked = false }: { spec: DrawerSpec; onClose: () => void; stacked?: boolean }) {
  return (
    <>
      {/* ⚠️ When opened FROM an expanded table the drawer must out-rank the modal, and it
          cannot do that by DOM order alone — both were z-index 41, so the drawer painted
          above only by accident of render order while the modal stayed UNDIMMED and fully
          hit-testable, swallowing this scrim's dismiss-on-click across its 880px footprint.
          The stacked variant lifts the scrim above the modal and the panel above that. */}
      <div className={`ov-drawer-bg ${stacked ? "ov-drawer-bg-top" : ""}`} onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={spec.title} className={`ov-drawer ${stacked ? "ov-drawer-top" : ""}`}>
        <div className="ov-drawer-h">
          <div style={{ minWidth: 0 }}>
            <div className="ov-drawer-k" style={{ color: spec.accent }}>{spec.kind}</div>
            <h2>{spec.title}</h2>
            {spec.sub && <div className="ov-drawer-s">{spec.sub}</div>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ov-x">×</button>
        </div>
        {spec.hero && (
          <div className="ov-drawer-hero">
            <div className="ov-drawer-hl">{spec.hero.label}</div>
            <div className="ov-drawer-hv">{spec.hero.value}</div>
            <div className="ov-drawer-ht">{spec.hero.trend} {spec.hero.note && <span>{spec.hero.note}</span>}</div>
          </div>
        )}
        <dl className="ov-drawer-rows">
          {spec.rows.map((r) => (
            <div key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>
          ))}
        </dl>
        {spec.href && (
          <a className="ov-cta ov-cta-block" href={spec.href.url} target={spec.href.external ? "_blank" : undefined} rel={spec.href.external ? "noopener noreferrer" : undefined}>
            {spec.href.label}
          </a>
        )}
        <div className="ov-drawer-foot">{spec.note ?? "Live platform data · refreshed every minute"}</div>
      </aside>
    </>
  );
}
