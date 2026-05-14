"use client";
import { forwardRef, useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Icon } from "./portal-icons";
import { STATUS, STATUS_STYLE, sel, usePortalStore, type StatusKey } from "@/lib/portal-store";

/* — Button — primary uses brand yellow ONLY for action.
   Variants: primary, default, ghost, danger, subtle, ink.
   Sizes: sm, md. */
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
  const base = "inline-flex items-center justify-center gap-1.5 font-medium select-none transition-colors focus-visible:shadow-focus focus-visible:border-ink disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";
  const sizes: Record<ButtonSize, string> = {
    sm: "h-8 px-2.5 text-[13px] rounded",
    md: "h-9 px-3.5 text-sm rounded-md",
  };
  const variants: Record<ButtonVariant, string> = {
    primary: "bg-action text-ink border border-ink/10 hover:bg-action-deep",
    default: "bg-surface text-ink border border-border hover:bg-muted/60",
    ghost:   "bg-transparent text-ink-2 hover:bg-muted/60 border border-transparent",
    danger:  "bg-surface text-danger border border-border hover:bg-danger-bg",
    subtle:  "bg-muted text-ink border border-transparent hover:bg-muted/80",
    ink:     "bg-ink text-bg border border-ink hover:bg-ink-2",
  };
  return (
    <button ref={ref} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...rest}>
      {icon}
      <span>{children}</span>
      {iconRight}
      {kbd && <kbd className="ml-1">{kbd}</kbd>}
    </button>
  );
});

/* — IconButton — */
interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  size?: ButtonSize;
  variant?: "ghost" | "default" | "ink";
}

export function IconButton({ icon, label, size = "md", variant = "ghost", className = "", children, ...rest }: IconButtonProps) {
  const dims = size === "sm" ? "h-7 w-7" : "h-9 w-9";
  const variants = {
    ghost: "text-ink-2 hover:bg-muted/60 hover:text-ink",
    default: "bg-surface text-ink border border-border hover:bg-muted/60",
    ink: "bg-ink text-bg",
  };
  return (
    <button aria-label={label} className={`${dims} ${variants[variant]} relative inline-flex items-center justify-center rounded transition-colors ${className}`} {...rest}>
      {icon}
      {children}
    </button>
  );
}

/* — StatusBadge — pill on opaque surfaces. */
export function StatusBadge({ status, withDot = true, className = "" }: { status: StatusKey; withDot?: boolean; className?: string }) {
  const s = STATUS[status] || STATUS.DRAFT;
  const style = STATUS_STYLE[s.kind];
  return (
    <span className={`inline-flex items-center gap-1.5 h-6 px-2 rounded text-xs font-medium ${style.bg} ${style.text} ${className}`}>
      {withDot && <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />}
      {s.label}
    </span>
  );
}

/* — Avatar — monogram on cream, ink border. Never gradient. */
type AvatarSize = "xs" | "sm" | "md" | "lg";
export function Avatar({ initial = "?", size = "md", className = "" }: { initial?: string; size?: AvatarSize; className?: string }) {
  const dims: Record<AvatarSize, string> = {
    xs: "h-5 w-5 text-[10px]",
    sm: "h-6 w-6 text-[11px]",
    md: "h-8 w-8 text-[13px]",
    lg: "h-10 w-10 text-base",
  };
  return (
    <span className={`${dims[size]} inline-flex items-center justify-center rounded-full bg-muted text-ink-2 border border-border font-medium shrink-0 ${className}`}>
      {initial}
    </span>
  );
}

/* — Format pill — */
export function FormatPill({ format, aspect, className = "" }: { format: string; aspect?: string | null; className?: string }) {
  const icons: Record<string, ReactNode> = {
    REEL: <Icon.Reel size={11} sw={2}/>,
    CAROUSEL: <Icon.Carousel size={11} sw={2}/>,
    STORY: <Icon.Story size={11} sw={2}/>,
    POST: <Icon.Image size={11} sw={2}/>,
    DOC: <Icon.File size={11} sw={2}/>,
  };
  return (
    <span className={`inline-flex items-center gap-1 h-5 px-1.5 rounded bg-muted text-ink-3 text-[10.5px] font-medium uppercase tracking-wider ${className}`}>
      {icons[format] || null} {format}{aspect ? <span className="text-ink-4 normal-case tracking-normal">·{aspect}</span> : null}
    </span>
  );
}

/* — Platform-aspect thumbnail — */
export function AspectThumb({ aspect = "1:1", format = "POST", size = "row", className = "" }: { aspect?: string | null; format?: string; size?: "row" | "tile" | "lg"; className?: string }) {
  const heights: Record<string, number> = { row: 36, tile: 64, lg: 96 };
  const h = heights[size] || 36;
  const [aw, ah] = (aspect || "1:1").split(":").map(Number);
  const w = h * (aw / (ah || 1));
  return (
    <div className={`ig-hatch rounded-sm relative border border-border/60 shrink-0 ${className}`} style={{ width: w, height: h }}>
      {format === "REEL" && <span className="absolute bottom-0.5 right-0.5 text-[9px] font-medium text-ink-3 bg-bg/80 px-1 rounded-sm">9:16</span>}
    </div>
  );
}

/* — Toast stack — */
export function ToastStack() {
  const toasts = usePortalStore(sel.toasts);
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none">
      {toasts.map((t) => {
        const tone: Record<string, string> = {
          success: "bg-success-bg text-success border-success/30",
          attention: "bg-attention-bg text-attention border-attention/30",
          danger: "bg-danger-bg text-danger border-danger/30",
          neutral: "bg-surface text-ink border-border",
        };
        return (
          <div key={t.id} className={`toast-in pointer-events-auto shadow-pop rounded-md border px-3.5 py-2 text-sm font-medium ${tone[t.kind] || tone.neutral}`}>
            {t.text}
          </div>
        );
      })}
    </div>
  );
}

/* — Modal — */
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
    <div className="fixed inset-0 z-[70] bg-ink/30 grid place-items-center p-4" onClick={onClose}>
      <div className={`bg-surface w-full ${widths[size]} rounded-lg shadow-pop border border-border overflow-hidden`} onClick={(e) => e.stopPropagation()}>
        {title && (
          <div className="px-4 py-3 border-b border-rule flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            <IconButton size="sm" icon={<Icon.Close size={16}/>} label="Close" onClick={onClose} />
          </div>
        )}
        <div className="p-4">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-rule bg-muted/30 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/* — Empty state — */
export function Empty({ icon, title, hint, cta }: { icon?: ReactNode; title: string; hint?: string; cta?: ReactNode }) {
  return (
    <div className="text-center py-10 px-6">
      {icon && <div className="h-10 w-10 mx-auto rounded-md bg-muted text-ink-3 grid place-items-center mb-3">{icon}</div>}
      <div className="text-sm font-medium text-ink">{title}</div>
      {hint && <div className="text-xs text-ink-3 mt-0.5">{hint}</div>}
      {cta && <div className="mt-3">{cta}</div>}
    </div>
  );
}

/* — Skeleton — */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-muted rounded ${className}`} />;
}

/* — PageError — */
export function PageError({ message = "Something went wrong" }: { message?: string }) {
  return (
    <Empty
      icon={<Icon.Close size={20} />}
      title="Could not load"
      hint={message}
    />
  );
}

/* — Keyboard-hint row — */
export function KbdRow({ items }: { items: { k: string; label: string }[] }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-ink-3">
      {items.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          <kbd>{it.k}</kbd>
          <span>{it.label}</span>
        </span>
      ))}
    </div>
  );
}
