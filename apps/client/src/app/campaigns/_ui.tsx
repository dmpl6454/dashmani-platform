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
  // A creator's post. awaiting_creator: asked, not yet confirmed. refund_due: paid, will not be posted, the
  // money is owed back and not yet returned (the refunded ledger wording below applies once it is).
  awaiting_creator: { label: "Waiting for the creator to confirm", cls: "bg-indigo/10 text-indigo-light" },
  refund_due: { label: "Being returned", cls: "bg-muted text-ink-2" },
};

/**
 * A creator's post reads differently in two states. After the creator confirms, the item sits as
 * `manual_pending` — "Scheduled" would promise a time nobody set, because the creator posts it by hand.
 * ⚠️ "Live" is shown only for `posted_manual`/`published`, which the API sets after OUR team has checked the
 * creator's link, so no label here may say a creator's post is live before that.
 */
const CREATOR_ITEM: Record<string, { label: string; cls: string }> = {
  manual_pending: { label: "Confirmed by the creator", cls: "bg-indigo/10 text-indigo-light" },
};

/**
 * One post's state. `paidOnline` is the booking's paidAt: a post dropped from a campaign that was
 * never paid online was not charged, so it must never read "refunded". `refundConfirmed` is the
 * refund ledger's word (Razorpay has accepted the refund): an item is marked refunded BEFORE
 * Razorpay answers, and stays so if the refund fails, so a paid post reads "refunded" only on
 * that fact and "being returned" otherwise.
 */
export function ItemStatus({ status, paidOnline, refundConfirmed = false, creator = false }: { status: string; paidOnline: boolean; refundConfirmed?: boolean; creator?: boolean }) {
  const s =
    (status === "refunded" || status === "refund_due") && !paidOnline
      ? { label: "Not posted — not charged", cls: "bg-muted text-ink-2" }
      : status === "refunded" && !refundConfirmed
        ? { label: "Not posted — being returned", cls: "bg-muted text-ink-2" }
        : (creator && CREATOR_ITEM[status]) || ITEM[status] || { label: status, cls: "bg-muted text-ink-2" };
  return <span className={`inline-flex items-center h-6 px-2.5 text-[11px] tracking-[0.02em] font-bold whitespace-nowrap border border-current/30 ${s.cls}`}>{s.label}</span>;
}

/** The "Creator" tag on an account that a creator, not our network, provides. */
export function CreatorBadge({ display = "inline-flex" }: { display?: string }) {
  return (
    <span className={`${display} items-center h-[18px] px-1.5 text-[10px] font-bold uppercase tracking-wider text-indigo-light border border-indigo-light/50 whitespace-nowrap shrink-0`}>
      Creator
    </span>
  );
}

/**
 * What a client should know about one creator post right now, in words. ⚠️ Never claims the post is live
 * before our team has checked the creator's link (that is `posted_manual`, which needs no note), and never
 * promises a time: the creator posts by hand within the go-live window.
 */
export function creatorItemNote(status: string, paidOnline: boolean, window: string | null): string | null {
  // `window` is the two dates joined with "and" ("19 Oct 2026 and 26 Oct 2026"), read after "between".
  switch (status) {
    case "pending":
      return "Once we approve your campaign, the creator is asked to confirm this post.";
    case "awaiting_creator":
      return "The creator has been asked to confirm this post. If they don't confirm in time, the amount for it is returned to you.";
    case "manual_pending":
      return `The creator posts it by hand${window ? ` between ${window}` : " within your go-live window"}. The link appears here once our team has checked it.`;
    case "refund_due":
      return paidOnline ? "This post won't go ahead. The amount for it is being returned to you." : "This post won't go ahead. You weren't charged for it.";
    default:
      return null;
  }
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
