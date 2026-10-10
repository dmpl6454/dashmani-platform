"use client";
import type { ReactNode } from "react";

// Small building blocks shared by the campaign pages (module-scoped: `_` keeps Next from routing it).

export const inputCls =
  "w-full h-10 px-3 text-[13.5px] bg-surface border-2 border-ink/15 rounded-xl outline-none focus:border-ink transition-colors";
export const textareaCls =
  "w-full px-3 py-2.5 text-[13.5px] bg-surface border-2 border-ink/15 rounded-xl outline-none focus:border-ink transition-colors resize-y";

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-1.5">{label}</label>
      {children}
      {error ? (
        <div className="mt-1 text-[12px] text-danger font-medium" role="alert">{error}</div>
      ) : hint ? (
        <div className="mt-1 text-[12px] text-ink-3">{hint}</div>
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
    <span className={`inline-flex items-center h-6 px-2.5 rounded-full text-[11.5px] font-bold whitespace-nowrap ${STATUS_TONE[status] ?? "bg-muted text-ink-2"}`}>
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

export function ItemStatus({ status }: { status: string }) {
  const s = ITEM[status] ?? { label: status, cls: "bg-muted text-ink-2" };
  return <span className={`inline-flex items-center h-6 px-2.5 rounded-full text-[11.5px] font-bold whitespace-nowrap ${s.cls}`}>{s.label}</span>;
}

export function PlatformDot({ platform }: { platform: string }) {
  const color = platform === "instagram" ? "#d6249f" : platform === "facebook" ? "#1877f2" : platform === "youtube" ? "#ff0000" : "#888";
  return <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: color }} />;
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl bg-danger-bg text-danger text-[13px] font-medium px-4 py-3" role="alert">
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
