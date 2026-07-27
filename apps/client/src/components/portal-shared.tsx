"use client";
import { forwardRef, useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon } from "./portal-icons";
import { STATUS, STATUS_STYLE, sel, usePortalStore, type StatusKey } from "@/lib/portal-store";

/* ── Button ── */
type ButtonVariant = "primary" | "default" | "ghost" | "danger" | "subtle" | "ink";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  kbd?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", icon, iconRight, kbd, children, className = "", ...rest },
  ref
) {
  const base = "inline-flex items-center justify-center gap-1.5 font-semibold select-none disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap border-2 rounded-xl";
  const sizes: Record<ButtonSize, string> = {
    sm: "h-8 px-3.5 text-[13px]",
    md: "h-10 px-5 text-[14px]",
  };
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-indigo  text-white  border-ink btn-3d",
    default: "bg-surface text-ink    border-ink btn-3d",
    ghost:   "bg-transparent text-ink-2 border-transparent hover:bg-muted/80 transition-colors",
    danger:  "bg-danger-bg text-danger border-danger btn-3d",
    subtle:  "bg-muted text-ink border-transparent hover:bg-muted/80 transition-colors",
    ink:     "bg-ink text-white border-ink btn-3d",
  };
  return (
    <button ref={ref} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...rest}>
      {icon && <span className="shrink-0">{icon}</span>}
      <span>{children}</span>
      {iconRight && <span className="shrink-0">{iconRight}</span>}
      {kbd && <kbd className="ml-0.5">{kbd}</kbd>}
    </button>
  );
});

/* ── IconButton ── */
interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  size?: ButtonSize;
  variant?: "ghost" | "default" | "ink";
}

export function IconButton({ icon, label, size = "md", variant = "ghost", className = "", ...rest }: IconButtonProps) {
  const dims = { sm: "h-8 w-8 rounded-lg", md: "h-10 w-10 rounded-xl" }[size] || "h-10 w-10 rounded-xl";
  const variants = {
    ghost:   "text-ink-2 hover:bg-muted/80 hover:text-ink transition-colors",
    default: "bg-surface border-2 border-ink rounded-xl btn-3d text-ink",
    ink:     "bg-ink text-white border-2 border-ink rounded-xl btn-3d",
  };
  return (
    <button aria-label={label} title={label} className={`${dims} ${variants[variant] || variants.ghost} inline-flex items-center justify-center shrink-0 ${className}`} {...rest}>
      {icon}
    </button>
  );
}

/* ── Pill system ──
   Every rounded control in the portal is built from these, so heights, radii
   and type sizes stay on one scale instead of drifting per page. Phones step
   down a notch; the `sm:` half of each pair is the desktop size.

     Tag          h-5 / h-6    read-only meta (overdue, counts)
     FormatPill   h-5 / h-5    format + aspect
     StatusBadge  h-5 / h-6    status
     SegTabs      h-6 / h-7    view switches, inside a tinted track
     FilterChip   h-8 / h-9    filter rows — matches Button size="sm" */

type TagTone = "neutral" | "attention" | "success";

export function Tag({ tone = "neutral", children, className = "" }: { tone?: TagTone; children: ReactNode; className?: string }) {
  const tones: Record<TagTone, string> = {
    neutral:   "bg-muted/80     text-ink-3    border-ink/10",
    attention: "bg-attention-bg text-attention border-attention/20",
    success:   "bg-success-bg   text-success  border-success/20",
  };
  return (
    <span className={`inline-flex items-center gap-1 h-5 sm:h-6 px-2 sm:px-2.5 rounded-full text-[10px] sm:text-[11px] font-bold border shrink-0 whitespace-nowrap ${tones[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function FilterChip({ active, count, dot, onClick, children }: {
  active: boolean; count?: number; dot?: boolean; onClick: () => void; children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`h-8 sm:h-9 px-3 sm:px-4 inline-flex items-center gap-1.5 rounded-lg sm:rounded-xl text-[12.5px] sm:text-[13px] font-semibold border-2 transition-all whitespace-nowrap
        ${active
          ? "bg-ink text-white border-ink btn-3d"
          : "bg-surface text-ink-2 border-ink/20 hover:border-ink/50 hover:text-ink"}`}
    >
      {children}
      {typeof count === "number" && (
        <span className={`text-[11px] tabular-nums ${active ? "text-white/60" : "text-ink-4"}`}>{count}</span>
      )}
      {dot && !active && <span className="h-1.5 w-1.5 rounded-full bg-attention" />}
    </button>
  );
}

export function SegTabs<T extends string>({ value, onChange, options, className = "" }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string;
}) {
  return (
    <div
      className={`flex items-center gap-1 p-0.5 bg-muted rounded-lg sm:rounded-xl shrink-0 ${className}`}
      style={{ border: "2px solid rgba(26,26,26,0.1)" }}
      role="tablist"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`h-6 sm:h-7 px-2 sm:px-3 text-[11.5px] sm:text-[12.5px] font-semibold rounded-md sm:rounded-lg transition-all whitespace-nowrap
            ${value === o.value ? "bg-surface text-ink shadow-hard-ink" : "text-ink-3 hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── StatusBadge ── */
export function StatusBadge({ status, withDot = true, className = "" }: { status: StatusKey; withDot?: boolean; className?: string }) {
  const s = STATUS[status] || STATUS.DRAFT;
  const st = STATUS_STYLE[s.kind];
  return (
    <span className={`inline-flex items-center gap-1 sm:gap-1.5 h-5 sm:h-6 px-2 sm:px-2.5 rounded-full text-[10.5px] sm:text-[11.5px] font-semibold whitespace-nowrap ${st.bg} ${st.text} border border-current/15 ${className}`}>
      {withDot && <span className={`h-1.5 w-1.5 rounded-full ${st.dot} shrink-0`} />}
      {s.label}
    </span>
  );
}

/* ── Avatar ── */
type AvatarSize = "xs" | "sm" | "md" | "lg";
export function Avatar({ initial = "?", size = "md", className = "" }: { initial?: string; size?: AvatarSize; className?: string }) {
  const dims: Record<AvatarSize, string> = {
    xs: "h-5 w-5 text-[9px] border",
    sm: "h-7 w-7 text-[11px] border-2",
    md: "h-9 w-9 text-[13px] border-2",
    lg: "h-11 w-11 text-[15px] border-2",
  };
  return (
    <span className={`${dims[size]} inline-flex items-center justify-center rounded-full bg-muted text-ink-2 border-ink/20 font-bold shrink-0 ${className}`}>
      {initial}
    </span>
  );
}

/* ── FormatPill ── */
export function FormatPill({ format, aspect, className = "" }: { format: string; aspect?: string | null; className?: string }) {
  const icons: Record<string, ReactNode> = {
    REEL:     <Icon.Reel     size={9} sw={2} />,
    CAROUSEL: <Icon.Carousel size={9} sw={2} />,
    STORY:    <Icon.Story    size={9} sw={2} />,
    POST:     <Icon.Image    size={9} sw={2} />,
    DOC:      <Icon.File     size={9} sw={2} />,
  };
  return (
    <span className={`inline-flex items-center gap-1 h-5 px-2 rounded-full bg-muted/80 text-ink-3 text-[9.5px] font-bold uppercase tracking-wider border border-ink/8 ${className}`}>
      {icons[format] || null}
      {format}
      {aspect && <span className="text-ink-4 normal-case tracking-normal font-medium">·{aspect}</span>}
    </span>
  );
}

/* ── AspectThumb ── */
export function AspectThumb({ aspect = "1:1", format = "POST", size = "row", className = "" }: { aspect?: string | null; format?: string; size?: "row" | "tile" | "lg"; className?: string }) {
  const heights: Record<string, number> = { row: 36, tile: 64, lg: 96 };
  const box = heights[size] || 36;
  const [aw, ah] = (aspect || "1:1").split(":").map(Number);
  const ratio = (aw || 1) / (ah || 1);
  // Fit inside a box×box square. Scaling only the width made 16:9 thumbs 64px
  // wide, which overflowed the 36px column and sat on top of the post title.
  const w = ratio >= 1 ? box : box * ratio;
  const h = ratio >= 1 ? box / ratio : box;
  return (
    <div className={`ig-hatch rounded-md relative border border-ink/15 shrink-0 ${className}`} style={{ width: w, height: h }}>
      {format === "REEL" && (
        <span className="absolute bottom-0.5 right-0.5 text-[8px] font-bold text-ink-3 bg-bg/90 px-1 rounded-sm leading-tight">9:16</span>
      )}
    </div>
  );
}

/* ── Toast stack ── */
export function ToastStack() {
  const toasts = usePortalStore(sel.toasts);
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[80] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => {
        const tone: Record<string, string> = {
          success:   "bg-success-bg  text-success  border-success/30",
          attention: "bg-attention-bg text-attention border-attention/30",
          danger:    "bg-danger-bg   text-danger   border-danger/30",
          neutral:   "bg-surface     text-ink       border-ink/20",
        };
        return (
          <div key={t.id} className={`toast-pop pointer-events-auto v3-card-sm border px-4 py-2.5 text-[13px] font-semibold min-w-[200px] text-center ${tone[t.kind] || tone.neutral}`}>
            {t.text}
          </div>
        );
      })}
    </div>
  );
}

/* ── Modal ── */
export function Modal({ open, onClose, title, children, footer, size = "md" }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl" }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const widths = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-lg", xl: "max-w-2xl" };
  return (
    <div className="fixed inset-0 z-[70] bg-ink/20 grid place-items-center p-4 pop-in" onClick={onClose}>
      <div className={`v3-card w-full ${widths[size] || widths.md} overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {title && (
          <div className="px-5 py-4 flex items-center justify-between gap-3" style={{ borderBottom: "2px solid rgba(26,26,26,0.08)" }}>
            <h2 className="text-[15px] font-bold text-ink">{title}</h2>
            <IconButton size="sm" icon={<Icon.Close size={16} />} label="Close" onClick={onClose} />
          </div>
        )}
        <div className="p-5">{children}</div>
        {footer && (
          <div className="px-5 py-3 flex items-center justify-end gap-2" style={{ borderTop: "2px solid rgba(26,26,26,0.08)", background: "rgba(243,238,216,0.3)" }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Empty state ── */
export function Empty({ icon, title, hint, cta }: { icon?: ReactNode; title: string; hint?: string; cta?: ReactNode }) {
  return (
    <div className="text-center py-14 px-6">
      {icon && (
        <div className="h-12 w-12 mx-auto rounded-2xl bg-indigo-soft border border-indigo/20 text-indigo grid place-items-center mb-4">
          {icon}
        </div>
      )}
      <div className="font-semibold text-[14px] text-ink">{title}</div>
      {hint && <div className="text-[12.5px] text-ink-3 mt-1 font-medium">{hint}</div>}
      {cta && <div className="mt-4">{cta}</div>}
    </div>
  );
}

/* ── Skeleton ── */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-muted rounded-xl ${className}`} />;
}

/* ── PageError ── */
export function PageError({ message = "Something went wrong" }: { message?: string }) {
  return <Empty icon={<Icon.Close size={20} />} title="Could not load" hint={message} />;
}

/* ── KbdRow ── */
export function KbdRow({ items }: { items: { k: string; label: string }[] }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-ink-3 font-medium">
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <kbd>{it.k}</kbd>
          <span>{it.label}</span>
        </span>
      ))}
    </div>
  );
}
