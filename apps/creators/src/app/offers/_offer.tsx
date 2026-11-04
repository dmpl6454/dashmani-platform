"use client";
import type { CreatorOffer } from "@/lib/types";
import { fmtDate } from "@/lib/format";

// Shared bits for the Bookings pages (`_` keeps Next from routing it).

const LABELS: Record<string, { label: string; cls: string }> = {
  awaiting_creator: { label: "Waiting for you", cls: "border-attention/60 text-attention" },
  queued: { label: "Accepted — scheduled", cls: "border-indigo/60 text-indigo-light" },
  manual_pending: { label: "Accepted — post it yourself", cls: "border-attention/60 text-attention" },
  published: { label: "Live", cls: "border-success/60 text-success" },
  posted_manual: { label: "Live", cls: "border-success/60 text-success" },
  creator_declined: { label: "Declined", cls: "border-white/30 text-ink-3" },
  failed: { label: "Not posted", cls: "border-danger/60 text-danger" },
  refunded: { label: "Cancelled", cls: "border-white/30 text-ink-3" },
};

export function OfferStatus({ o }: { o: Pick<CreatorOffer, "status" | "canAccept"> }) {
  // An open offer whose answer time has passed reads as closed until the server moves it.
  const s = o.status === "awaiting_creator" && !o.canAccept
    ? { label: "Closed", cls: "border-white/30 text-ink-3" }
    : LABELS[o.status] ?? { label: o.status, cls: "border-white/30 text-ink-3" };
  return <span className={`inline-flex items-center h-6 px-2 border-2 text-[11px] font-bold uppercase tracking-[0.08em] whitespace-nowrap ${s.cls}`}>{s.label}</span>;
}

export function rupees(paise: number | null | undefined): string {
  if (paise == null) return "—";
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { maximumFractionDigits: r % 1 === 0 ? 0 : 2 })}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A moment in IST, fixed English (the static render and the browser agree). */
export function fmtIst(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const d = new Date(t + 5.5 * 3600_000);
  const h = d.getUTCHours();
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"} IST`;
}

/** "1 Mar – 5 Mar 2026" from two IST days (YYYY-MM-DD). */
export function fmtWindow(from: string | null, to: string | null): string {
  if (!from) return "Dates to be confirmed";
  const a = fmtDate(`${from}T00:00:00`);
  return to && to !== from ? `${a} – ${fmtDate(`${to}T00:00:00`)}` : a;
}

export const PLATFORM: Record<string, string> = { instagram: "Instagram", facebook: "Facebook" };
