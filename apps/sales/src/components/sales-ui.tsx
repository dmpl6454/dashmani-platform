"use client";
import { type ReactNode, useEffect, useState } from "react";
import { fmtInr, toPaise } from "@/lib/format";

// Small building blocks shared by every page, in the site's .card / .btn / .input vocabulary.

export function Money({ paise, whole = false, className = "" }: { paise: number | null | undefined; whole?: boolean; className?: string }) {
  return <span className={`font-mono tabular-nums ${className}`}>{fmtInr(paise, { whole })}</span>;
}

const STATUS_TONE: Record<string, string> = {
  draft: "border-border text-ink-3",
  sent: "border-indigo-light text-indigo-light",
  accepted: "border-success text-success",
  declined: "border-danger text-danger",
  expired: "border-attention text-attention",
  converted: "border-success text-success",
  recorded: "border-success text-success",
  voided: "border-danger text-danger",
  confirmed: "border-indigo-light text-indigo-light",
  in_progress: "border-attention text-attention",
  delivered: "border-success text-success",
  closed: "border-border text-ink-3",
  cancelled: "border-danger text-danger",
  issued: "border-indigo-light text-indigo-light",
  partially_paid: "border-attention text-attention",
  paid: "border-success text-success",
  overdue: "border-danger text-danger",
  pending: "border-border text-ink-3",
  scheduled: "border-indigo-light text-indigo-light",
  // campaign bookings / their posts
  awaiting_payment: "border-border text-ink-3",
  paid_pending_review: "border-attention text-attention",
  changes_requested: "border-attention text-attention",
  approved: "border-indigo-light text-indigo-light",
  publishing: "border-indigo-light text-indigo-light",
  completed: "border-success text-success",
  partially_published: "border-attention text-attention",
  rejected: "border-danger text-danger",
  refunded: "border-danger text-danger",
  failed: "border-danger text-danger",
  published: "border-success text-success",
  posted_manual: "border-success text-success",
  manual_pending: "border-indigo-light text-indigo-light",
  queued: "border-indigo-light text-indigo-light",
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`inline-block px-2 py-0.5 border text-[11px] uppercase tracking-[0.08em] whitespace-nowrap ${STATUS_TONE[status] ?? "border-border text-ink-3"}`}>
      {label ?? status.replace(/_/g, " ")}
    </span>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "danger" | "success" | "attention" }) {
  const color = tone === "danger" ? "text-danger" : tone === "success" ? "text-success" : tone === "attention" ? "text-attention" : "";
  return (
    <div className="card p-4 min-w-0">
      <p className="text-[11px] uppercase tracking-[0.12em] text-ink-3 mb-1">{label}</p>
      <p className={`text-2xl font-extrabold truncate ${color}`}>{value}</p>
      {sub && <p className="text-xs text-ink-3 mt-1 truncate">{sub}</p>}
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card p-8 text-center">
      <p className="font-bold">{title}</p>
      {body && <p className="text-ink-3 text-sm mt-1">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function LoadError({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Couldn't load this.";
  return (
    <div className="card p-4 border-danger text-sm" role="alert">
      <span className="text-danger font-bold">Couldn&apos;t load.</span> <span className="text-ink-3">{msg}</span>
      {retry && <button type="button" className="btn btn-ghost btn-sm ml-3" onClick={retry}>Retry</button>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div className="flex items-center gap-3 text-ink-3 text-sm py-8" role="status"><span className="spinner" aria-hidden /> {label}</div>;
}

export function Field({ label, children, hint, className = "" }: { label: string; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="block text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-4 mt-1">{hint}</span>}
    </label>
  );
}

/** Rupee input that stores integer paise. Shows two decimals on blur. */
export function MoneyInput({ paise, onChange, className = "", placeholder = "0.00", disabled }: { paise: number; onChange: (paise: number) => void; className?: string; placeholder?: string; disabled?: boolean }) {
  const [text, setText] = useState(paise ? (paise / 100).toFixed(2) : "");
  // Re-sync from the prop ONLY when it differs from what the text already says. Rewriting on every
  // change turned "5" into "5.00" mid-typing, so the next digits landed after the decimals and
  // 5000 saved as ₹5.00. A value set from outside (auto-allocate, a preset balance) still shows.
  useEffect(() => {
    setText((t) => ((toPaise(t) ?? 0) === paise ? t : paise ? (paise / 100).toFixed(2) : ""));
  }, [paise]);
  return (
    <input
      type="text" inputMode="decimal" className={`input text-right font-mono ${className}`} placeholder={placeholder} value={text} disabled={disabled}
      onChange={(e) => { setText(e.target.value); const p = toPaise(e.target.value); if (p != null) onChange(p); else if (e.target.value.trim() === "") onChange(0); }}
      onBlur={() => setText(paise ? (paise / 100).toFixed(2) : "")}
    />
  );
}

export function Toast({ message, tone = "ok", onDone }: { message: string; tone?: "ok" | "err"; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 4000); return () => clearTimeout(t); }, [onDone]);
  return (
    <div role="status" className={`fixed bottom-4 right-4 z-50 card px-4 py-3 text-sm shadow-pop ${tone === "err" ? "border-danger" : "border-success"}`}>{message}</div>
  );
}

export function PageHead({ kicker, title, children }: { kicker: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
      <div className="min-w-0">
        <p className="text-[11px] uppercase tracking-[0.12em] text-ink-3 mb-1">{kicker}</p>
        <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">{title}</h1>
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

export function Confirm({ title, body, confirmLabel = "Confirm", onConfirm, onClose, danger }: { title: string; body?: ReactNode; confirmLabel?: string; onConfirm: () => void | Promise<void>; onClose: () => void; danger?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" onClick={onClose}>
      <div className="card p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 className="font-extrabold text-lg mb-2">{title}</h3>
        {body && <div className="text-sm text-ink-3 mb-5">{body}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className={`btn ${danger ? "btn-danger" : "btn"}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube", snapchat: "Snapchat", x: "X", linkedin: "LinkedIn", pinterest: "Pinterest", telegram: "Telegram" };
export const platformLabel = (p: string | null | undefined) => (p ? PLATFORM_LABEL[p] ?? p : "—");
export const titleCase = (s: string | null | undefined) => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ") : "—");
