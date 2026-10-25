"use client";
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

// Small building blocks shared by the campaign pages (module-scoped: `_` keeps Next from routing it).

// The site's .input: surface fill, a 2px 25%-white border, accent caret and focus.
export const inputCls =
  "w-full h-11 px-3 text-[14px] bg-surface text-ink caret-indigo border-2 border-[rgba(255,255,255,0.25)] hover:border-[rgba(255,255,255,0.45)] outline-none focus:border-indigo transition-colors placeholder:text-ink-4";
export const textareaCls =
  "w-full px-3 py-2.5 text-[14px] bg-surface text-ink caret-indigo border-2 border-[rgba(255,255,255,0.25)] hover:border-[rgba(255,255,255,0.45)] outline-none focus:border-indigo transition-colors resize-y placeholder:text-ink-4";

/**
 * A labelled form control. With `htmlFor`, the hint and the error get ids and a single child
 * control is given `aria-describedby` (the error when there is one, else the hint) and
 * `aria-invalid`, so a screen reader announces the problem on the field itself. A child that
 * already sets its own `aria-describedby` keeps it.
 */
export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  const hintId = htmlFor && hint && !error ? `${htmlFor}-hint` : undefined;
  const errId = htmlFor && error ? `${htmlFor}-err` : undefined;
  let control = children;
  if (htmlFor && Children.count(children) === 1 && isValidElement(children)) {
    const el = children as ReactElement<Record<string, unknown>>;
    control = cloneElement(el, {
      "aria-describedby": el.props["aria-describedby"] ?? errId ?? hintId,
      "aria-invalid": error ? true : el.props["aria-invalid"],
    });
  }
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-1.5">{label}</label>
      {control}
      {error ? (
        <div id={errId} className="mt-1 text-[12px] text-danger font-medium" role="alert">{error}</div>
      ) : hint ? (
        <div id={hintId} className="mt-1 text-[12px] text-ink-3">{hint}</div>
      ) : null}
    </div>
  );
}

export function Card({ title, sub, right, children, className = "" }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`v3-card p-4 sm:p-5 ${className}`}>
      {(title || right) && (
        <div className="flex items-start gap-3 mb-4">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-[15px] font-bold text-ink">{title}</h2>}
            {sub && <p className="text-[12.5px] text-ink-3 mt-0.5">{sub}</p>}
          </div>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-ink-2",
  awaiting_payment: "bg-attention-bg text-attention",
  paid_pending_review: "bg-indigo/10 text-indigo",
  changes_requested: "bg-attention-bg text-attention",
  approved: "bg-indigo/10 text-indigo",
  publishing: "bg-indigo/10 text-indigo",
  completed: "bg-success-bg text-success",
  partially_published: "bg-success-bg text-success",
  rejected: "bg-danger-bg text-danger",
  refunded: "bg-muted text-ink-2",
  cancelled: "bg-muted text-ink-3",
  expired: "bg-muted text-ink-3",
};

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  awaiting_payment: "Awaiting payment",
  paid_pending_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved — scheduling",
  publishing: "Going live",
  completed: "Live",
  partially_published: "Partly live",
  rejected: "Not approved",
  refunded: "Refunded",
  cancelled: "Cancelled",
  expired: "Expired",
};

export function CampaignStatus({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center h-6 px-2.5 text-[11px] tracking-[0.02em] font-bold whitespace-nowrap border border-current/30 ${STATUS_TONE[status] ?? "bg-muted text-ink-2"}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

const ITEM: Record<string, { label: string; cls: string }> = {
  pending: { label: "Booked", cls: "bg-muted text-ink-2" },
  manual_pending: { label: "Scheduled", cls: "bg-indigo/10 text-indigo" },
  queued: { label: "Scheduled", cls: "bg-indigo/10 text-indigo" },
  posted_manual: { label: "Live", cls: "bg-success-bg text-success" },
  published: { label: "Live", cls: "bg-success-bg text-success" },
  failed: { label: "Not posted", cls: "bg-danger-bg text-danger" },
  refunded: { label: "Not posted — refunded", cls: "bg-muted text-ink-2" },
};

/**
 * One post's state. `paidOnline` is the booking's paidAt: a post dropped from a campaign that was
 * never paid online was not charged, so it must never read "refunded".
 */
export function ItemStatus({ status, paidOnline }: { status: string; paidOnline: boolean }) {
  const s =
    status === "refunded" && !paidOnline
      ? { label: "Not posted — not charged", cls: "bg-muted text-ink-2" }
      : ITEM[status] ?? { label: status, cls: "bg-muted text-ink-2" };
  return <span className={`inline-flex items-center h-6 px-2.5 text-[11px] tracking-[0.02em] font-bold whitespace-nowrap border border-current/30 ${s.cls}`}>{s.label}</span>;
}

export function PlatformDot({ platform }: { platform: string }) {
  const color = platform === "instagram" ? "#d6249f" : platform === "facebook" ? "#1877f2" : platform === "youtube" ? "#ff0000" : "#888";
  return <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: color }} />;
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="bg-danger-bg border-2 border-danger/40 text-danger text-[13px] font-medium px-4 py-3" role="alert">
      {children}
    </div>
  );
}

export function fmtDate(ymd: string | null): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
}
