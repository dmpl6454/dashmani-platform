"use client";
import { type ReactNode, useEffect, useState } from "react";
import { fmtInr, toPaise } from "@/lib/format";
import { formatFiledAmount, parseFiledAmount, type EntryUnit } from "@dashmani/shared/src/sales/accounts";

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
  // creators
  in_review: "border-attention text-attention",
  suspended: "border-danger text-danger",
  failed: "border-danger text-danger",
  published: "border-success text-success",
  posted_manual: "border-success text-success",
  manual_pending: "border-indigo-light text-indigo-light",
  queued: "border-indigo-light text-indigo-light",
  // ── Smart invoicing (spec-00 §2.11) — every feature's keys, added once; never redefined. ──
  // Tally
  open: "border-attention text-attention",
  pushing: "border-attention text-attention",
  partial: "border-attention text-attention",
  unknown: "border-attention text-attention",
  changed: "border-attention text-attention",
  pushed: "border-success text-success",
  synced: "border-success text-success",
  adopted: "border-success text-success",
  sending: "border-indigo-light text-indigo-light",
  blocked: "border-danger text-danger",
  discarded: "border-border text-ink-3",
  superseded: "border-border text-ink-3",
  unchanged: "border-border text-ink-3",
  // Import (labels "left out" / "already in" go through StatusPill's label prop)
  applying: "border-indigo-light text-indigo-light",
  applied: "border-success text-success",
  ready: "border-success text-success",
  imported: "border-success text-success",
  warning: "border-attention text-attention",
  error: "border-danger text-danger",
  undone: "border-border text-ink-3",
  excluded: "border-border text-ink-3",
  duplicate: "border-border text-ink-3",
  // Bank
  unmatched: "border-attention text-attention",
  partly_matched: "border-attention text-attention",
  suggested: "border-indigo-light text-indigo-light",
  matched: "border-success text-success",
  ignored: "border-border text-ink-3",
  // Accounts
  not_filed: "border-attention text-attention",
  filed: "border-success text-success",
  running: "border-indigo-light text-indigo-light",
  // reconcile (PR 5 — new keys only; PR 6's "reconciled" included so PR 6 edits no shared list)
  chase: "border-danger text-danger",
  short: "border-danger text-danger",
  not_in_26as: "border-danger text-danger",
  value_mismatch: "border-danger text-danger",
  wrong_recipient: "border-danger text-danger",
  cancelled_but_filed: "border-danger text-danger",
  disputed: "border-danger text-danger",
  over_matched: "border-danger text-danger",
  extra: "border-attention text-attention",
  link_first: "border-attention text-attention",
  not_in_books: "border-attention text-attention",
  wrong_period: "border-attention text-attention",
  not_credited: "border-attention text-attention",
  stale: "border-attention text-attention",
  matched_note: "border-indigo-light text-indigo-light",
  not_due: "border-border text-ink-3",
  next_year: "border-border text-ink-3",
  non_sales: "border-border text-ink-3",
  status_p: "border-border text-ink-3",
  not_sent: "border-border text-ink-3",
  credited_other_month: "border-border text-ink-3",
  rounding: "border-border text-ink-3",
  reconciled: "border-success text-success",
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

// ─── smart-invoicing: accounts (PR 1) ───
/**
 * An amount typed in the unit printed on the signed statements (rupees / thousands / lakhs /
 * crores), held as integer paise or null ("Not stated"). Signed figures get a two-button toggle
 * on the same row, because phone keypads have no minus key. String arithmetic only
 * (parseFiledAmount) — never Math.round(n * 100).
 *
 * Text that doesn't parse (or a negative in a figure that can't be negative) is NOT sent to
 * onChange — and `onInvalid(true)` tells the parent, which must refuse to save while any box is
 * red: otherwise the last value that did parse would be saved behind the red text.
 */
export function SignedAmountInput({ paise, onChange, onInvalid, unit, signLabels, disabled, id, label }: {
  paise: number | null; onChange: (p: number | null) => void; onInvalid?: (invalid: boolean) => void; unit: EntryUnit; signLabels?: [string, string]; disabled?: boolean; id?: string; label?: string;
}) {
  const signed = !!signLabels;
  const [text, setText] = useState(() => formatFiledAmount(paise == null ? null : signed ? Math.abs(paise) : paise, unit));
  // Only a signed figure keeps its sign apart from the text (in the toggle).
  const [negative, setNegative] = useState(() => signed && (paise ?? 0) < 0);
  const [invalid, setInvalid] = useState<string | null>(null);
  useEffect(() => { onInvalid?.(invalid !== null); }, [invalid]); // eslint-disable-line react-hooks/exhaustive-deps
  // Re-sync from the prop (or a unit change) only when the text no longer says the same thing —
  // the MoneyInput rule, so typing is never rewritten mid-number.
  useEffect(() => {
    const parsed = parseFiledAmount(text, unit);
    const current = parsed === "invalid" || parsed == null ? parsed : signed && negative ? -parsed : parsed;
    if (current === paise && invalid === null) return;
    setText(formatFiledAmount(paise == null ? null : signed ? Math.abs(paise) : paise, unit));
    setNegative(signed && (paise ?? 0) < 0);
    setInvalid(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paise, unit]);
  const emit = (t: string, neg: boolean) => {
    const p = parseFiledAmount(t, unit);
    if (p === "invalid") { setInvalid("Use digits, commas and one decimal point"); return; }
    if (p != null && p < 0 && !signed) { setInvalid("This figure can't be negative"); return; }
    setInvalid(null);
    if (p == null) { onChange(null); return; }
    // A typed minus or brackets flips the toggle too, so the two never disagree.
    if (p < 0) { setNegative(true); setText(t.replace(/^\s*[-−(]\s*/, "").replace(/\)\s*$/, "")); onChange(p); return; }
    onChange(signed && neg && p !== 0 ? -p : p);
  };
  return (
    <div className="min-w-0">
      <div className="flex gap-2 items-stretch min-w-0">
        <input
          id={id} aria-label={label} type="text" inputMode="decimal" placeholder="Not stated" disabled={disabled} value={text}
          aria-invalid={invalid !== null || undefined}
          className={`input text-right font-mono flex-1 min-w-0 ${invalid !== null ? "border-danger" : ""}`}
          onChange={(e) => { setText(e.target.value); emit(e.target.value, negative); }}
        />
        {signLabels && (
          <div className="flex shrink-0" role="group" aria-label={`${label ?? "Figure"}: ${signLabels[0]} or ${signLabels[1]}`}>
            {signLabels.map((l, i) => {
              const on = (i === 1) === negative;
              return (
                <button key={l} type="button" disabled={disabled} aria-pressed={on}
                  className={`px-2 text-xs border-2 ${i === 1 ? "border-l-0" : ""} ${on ? (i === 1 ? "bg-danger-bg border-danger text-danger" : "bg-indigo text-white border-indigo") : "border-border text-ink-3 hover:text-white"}`}
                  onClick={() => { const neg = i === 1; setNegative(neg); emit(text, neg); }}>
                  {l}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {invalid !== null && <span className="block text-xs text-danger mt-1">{invalid}</span>}
    </div>
  );
}
