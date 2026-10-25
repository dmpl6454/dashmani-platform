"use client";
import type { ReactNode } from "react";
import { X } from "lucide-react";

// Shared bits for the Campaign Bookings pages (dark "ds" shell). `_` keeps Next from routing it.

export const CARD = "rounded-[16px] border border-[#2A4658] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.35)]";
export const INPUT =
  "w-full h-10 px-3 rounded-[10px] bg-ds-inset border border-ds-line2 text-[13.5px] text-ds-text placeholder:text-ds-t4 outline-none focus:border-ds-gold";
export const BTN = "inline-flex items-center justify-center gap-2 h-9 px-4 rounded-[10px] text-[13px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors";
export const BTN_GOLD = `${BTN} bg-ds-gold text-[#1a1406] hover:bg-ds-gold2`;
export const BTN_GHOST = `${BTN} border border-ds-line2 text-ds-t5 hover:bg-ds-hover`;
export const BTN_RED = `${BTN} border border-[rgba(229,45,71,.5)] text-ds-redsoft hover:bg-[rgba(229,45,71,.1)]`;

export function rupees(paise: number | null | undefined) {
  if (paise == null) return "—";
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { maximumFractionDigits: r % 1 === 0 ? 0 : 2 })}`;
}

export function compact(n: number | null | undefined) {
  if (n == null) return "—";
  if (n >= 1e7) return `${(n / 1e7).toFixed(1)} Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(1)} L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export const STATUS: Record<string, { label: string; color: string }> = {
  draft: { label: "Draft", color: "#738395" },
  awaiting_payment: { label: "Awaiting payment", color: "#738395" },
  paid_pending_review: { label: "Needs review", color: "#E9BD62" },
  changes_requested: { label: "Changes requested", color: "#F59E66" },
  approved: { label: "Approved — to post", color: "#238BFF" },
  publishing: { label: "Posting", color: "#238BFF" },
  completed: { label: "Delivered", color: "#00D7A0" },
  partially_published: { label: "Partly delivered", color: "#00D7A0" },
  rejected: { label: "Rejected", color: "#FB7185" },
  refunded: { label: "Refunded", color: "#A7B3C2" },
  cancelled: { label: "Cancelled", color: "#4E5F70" },
  expired: { label: "Expired", color: "#4E5F70" },
};

export const ITEM_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: "Awaiting approval", color: "#738395" },
  manual_pending: { label: "To post", color: "#E9BD62" },
  queued: { label: "Auto-publish", color: "#238BFF" },
  posted_manual: { label: "Posted", color: "#00D7A0" },
  published: { label: "Published", color: "#00D7A0" },
  failed: { label: "Failed", color: "#FB7185" },
  refunded: { label: "Refunded", color: "#A7B3C2" },
};

export function Pill({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap" style={{ color, background: `${color}1F` }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

export function StatusPill({ status, map = STATUS }: { status: string; map?: Record<string, { label: string; color: string }> }) {
  const s = map[status] ?? { label: status, color: "#738395" };
  return <Pill label={s.label} color={s.color} />;
}

export function PlatformDot({ platform }: { platform: string }) {
  const c = platform === "instagram" ? "#DD3FAF" : platform === "facebook" ? "#2F86F0" : "#E52D47";
  return <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ background: c }} />;
}

export function ErrorBar({ message, onClose }: { message: string; onClose?: () => void }) {
  return (
    <div role="alert" className="px-3.5 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[#FB7185] text-[12.5px] flex items-center justify-between gap-3">
      <span>{message}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="shrink-0 hover:text-ds-text"><X className="h-4 w-4" /></button>
      )}
    </div>
  );
}

export function PageHead({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <section className="pt-[30px] pb-[22px] flex flex-wrap items-end gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-[30px] sm:text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight truncate">{title}</h1>
        {sub && <p className="mt-1.5 text-[13.5px] text-ds-t2">{sub}</p>}
      </div>
      {right}
    </section>
  );
}

export const fmtDate = (ymd: string | null) => {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
};
export const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : "—";
