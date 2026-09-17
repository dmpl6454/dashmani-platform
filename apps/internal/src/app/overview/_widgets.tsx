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
          {title && <h2>{title}</h2>}
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

export function ViewAll({ href, label = "View All →" }: { href: string; label?: string }) {
  return <a className="ov-viewall" href={href}>{label}</a>;
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

export function Drawer({ spec, onClose }: { spec: DrawerSpec; onClose: () => void }) {
  return (
    <>
      <div className="ov-drawer-bg" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label={spec.title} className="ov-drawer">
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
