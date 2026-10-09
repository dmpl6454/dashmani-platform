"use client";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { Receipt, Check, X } from "lucide-react";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { ModalPortal } from "@/components/modal-portal";

const STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
// Mockup palette.
const STATUS: Record<string, { label: string; color: string }> = {
  PENDING: { label: "Pending", color: "var(--hx-E9BD62)" },
  APPROVED: { label: "Approved", color: "var(--hx-00D7A0)" },
  REJECTED: { label: "Rejected", color: "var(--hx-FB7185)" },
};
const CATS: Record<string, string> = {
  TRAVEL: "var(--hx-6EB2FF)", FOOD: "var(--hx-F59E66)", MEALS: "var(--hx-F59E66)", EQUIPMENT: "var(--hx-9B7EDE)", SOFTWARE: "var(--hx-00D7A0)",
  OFFICE_SUPPLIES: "var(--hx-E9BD62)", INTERNET: "var(--hx-38BDF8)", OTHER: "var(--hx-A7B3C2)",
};
const HUES = ["var(--hx-238BFF)", "var(--hx-E9BD62)", "var(--hx-9B7EDE)", "var(--hx-00D7A0)", "var(--hx-FB7185)", "var(--hx-6EB2FF)"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
};
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const initials = (name: string) =>
  (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const inr = (n: number) => `₹${(n ?? 0).toLocaleString("en-IN")}`;
const catLabel = (c: string) => (c || "OTHER").replace(/_/g, " ").toLowerCase().replace(/^./, (x) => x.toUpperCase());
function ago(v: string) {
  const d = new Date(v);
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const t = new Date(); const b = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const n = Math.round((b - a) / 86_400_000);
  return n <= 0 ? "Today" : n === 1 ? "Yesterday" : `${n} days ago`;
}
const fd = (v: string) => { const d = new Date(v); return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`; };

const GRID =
  "grid gap-x-3.5 items-center [grid-template-columns:minmax(170px,20fr)_minmax(170px,22fr)_minmax(110px,12fr)_minmax(96px,10fr)_minmax(110px,12fr)_minmax(110px,11fr)_96px]";

export default function ExpensesPage() {
  usePageTitle("Expense Claims");
  const [filter, setFilter] = useState<string>("PENDING");
  // One request for every status, filtered here so each tab can show its count.
  const { data, error, isLoading, mutate } = useSWR(`/admin/expenses`, (url) => apiFetch<any>(url), { refreshInterval: 15000 });
  const all: any[] = (data as any)?.data ?? [];
  const expenses = all.filter((e) => e.status === filter);
  const count = (s: string) => all.filter((e) => e.status === s).length;

  const [rejectTarget, setRejectTarget] = useState<any | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    if (!rejectTarget) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) setRejectTarget(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rejectTarget, busy]);

  async function handleApprove(id: string) {
    setBusy(id);
    setActionError("");
    try {
      await apiFetch(`/admin/expenses/${id}/approve`, { method: "POST" });
      mutate();
    } catch (e: any) { setActionError(e.message || "Failed to approve the claim"); }
    setBusy(null);
  }

  async function handleReject(id: string) {
    setBusy(id);
    setActionError("");
    try {
      await apiFetch(`/admin/expenses/${id}/reject`, { method: "POST", body: JSON.stringify({ reason: rejectReason }) });
      setRejectTarget(null);
      setRejectReason("");
      mutate();
    } catch (e: any) { setActionError(e.message || "Failed to reject the claim"); }
    setBusy(null);
  }

  const totalAmount = expenses.reduce((s: number, e: any) => s + (e.amount || 0), 0);
  const loading = isLoading && !data;

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="pt-[30px] pb-[22px]">
        <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Expense Claims</h1>
        <p className="mt-1.5 text-[13.5px] text-ds-t2">Review and manage employee expense reimbursements</p>
      </section>

      {/* Stats */}
      <section className="grid gap-3.5 max-w-[760px] [grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))]">
        <div className="flex items-start justify-between gap-3 px-[22px] py-5 rounded-[16px] bg-ds-card border border-[color:var(--hx-2A4658)]">
          <span className="leading-[1.15] min-w-0">
            <span className="block text-[12.5px] font-semibold text-ds-t2">Claims ({STATUS[filter].label})</span>
            <span className="block mt-3 text-[36px] font-bold tracking-[-.04em] tabular-nums text-ds-text">
              {loading ? "—" : String(expenses.length).padStart(2, "0")}
            </span>
          </span>
          <span className="h-10 w-10 rounded-[12px] bg-[rgba(233,189,98,.12)] text-ds-gold grid place-items-center shrink-0">
            <Receipt className="h-[18px] w-[18px]" />
          </span>
        </div>
        <div className="flex items-start justify-between gap-3 px-[22px] py-5 rounded-[16px] bg-ds-card border border-[color:var(--hx-2A4658)]">
          <span className="leading-[1.15] min-w-0">
            <span className="block text-[12.5px] font-semibold text-ds-t2">Total Amount</span>
            <span className="block mt-3 text-[clamp(1.75rem,3vw,2.25rem)] font-bold tracking-[-.04em] tabular-nums text-ds-text truncate">
              {loading ? "—" : inr(totalAmount)}
            </span>
          </span>
          <span className="h-10 w-10 rounded-[12px] bg-[rgba(0,215,160,.12)] text-ds-teal grid place-items-center text-[18px] font-bold shrink-0">{"₹"}</span>
        </div>
      </section>

      {/* Filter */}
      <section className="flex items-center gap-3 flex-wrap mt-[22px]">
        <div className="flex gap-1 p-[5px] rounded-full bg-ds-inset border border-ds-line2 max-w-full overflow-x-auto" role="tablist" aria-label="Status">
          {STATUSES.map((s) => {
            const on = filter === s;
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setFilter(s)}
                className={`inline-flex items-center gap-2 h-9 px-[18px] rounded-full text-[13px] font-semibold whitespace-nowrap transition-colors ${
                  on ? "bg-ds-gold text-[color:var(--hx-060D14)]" : "text-ds-t2 hover:text-ds-text"
                }`}
              >
                {STATUS[s].label}
                {data && <span className={`text-[11px] font-semibold ${on ? "text-[rgba(6,13,20,.6)]" : "text-ds-t3"}`}>{count(s)}</span>}
              </button>
            );
          })}
        </div>
        <span className="ml-auto text-[12px] text-ds-t3 whitespace-nowrap">Auto-refreshes every 15s</span>
      </section>

      {actionError && (
        <div className="mt-3.5 px-3.5 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12.5px] flex items-center justify-between gap-3">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError("")} aria-label="Dismiss" className="shrink-0 hover:text-ds-text"><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* Table */}
      <section className="mt-[18px] rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)]">
        <div className="overflow-x-auto">
          <div className="min-w-[1000px]">
            <div className={`${GRID} h-[52px] px-5 bg-ds-inset border-b border-ds-line2 text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3 whitespace-nowrap`}>
              <span>Employee</span><span>Title</span><span>Category</span><span>Amount</span><span className="pl-6">Date</span><span>Status</span>
              <span className="text-right">{filter === "PENDING" ? "Actions" : ""}</span>
            </div>
            {loading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`${GRID} h-[76px] px-5 border-b border-[color:var(--hx-132430)]`}>
                  <div className="flex items-center gap-3">
                    <div className="h-[38px] w-[38px] rounded-full bg-ds-hover motion-safe:animate-pulse" />
                    <div className="h-3.5 w-28 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                  </div>
                </div>
              ))
            ) : error ? (
              <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">Expense claims couldn&apos;t be loaded just now. Refresh to try again.</div>
            ) : expenses.length === 0 ? (
              <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">
                <Receipt className="h-[30px] w-[30px] mx-auto mb-2.5 opacity-50" strokeWidth={1.5} />
                No {filter.toLowerCase()} expense claims
              </div>
            ) : (
              expenses.map((exp: any) => {
                const name = exp.employee?.name || "—";
                const hue = HUES[hash(name) % HUES.length];
                const cc = CATS[exp.category] || "var(--hx-A7B3C2)";
                const st = STATUS[exp.status] || { label: exp.status, color: "var(--hx-738395)" };
                const isBusy = busy === exp.id;
                return (
                  <div key={exp.id} className={`${GRID} min-h-[80px] py-3 px-5 border-b border-[color:var(--hx-132430)] last:border-b-0 text-[13px] hover:bg-[color:var(--hx-0A1620)] transition-colors tabular-nums`}>
                    <span className="flex items-center gap-3 min-w-0">
                      <span
                        aria-hidden="true"
                        className="h-[38px] w-[38px] rounded-full border grid place-items-center text-[11.5px] font-bold shrink-0"
                        style={{ background: rgba(hue, 0.12), borderColor: rgba(hue, 0.3), color: hue }}
                      >
                        {initials(name)}
                      </span>
                      <span className="flex flex-col gap-0.5 min-w-0 leading-[1.25]">
                        <span className="text-[14px] font-semibold text-ds-text truncate" title={name}>{name}</span>
                        <span className="text-[12px] text-ds-t3 truncate" title={exp.employee?.email || undefined}>{exp.employee?.email || ""}</span>
                      </span>
                    </span>
                    <span className="flex flex-col gap-0.5 min-w-0 leading-[1.3]">
                      <span className="font-semibold text-[color:var(--hx-E3E8EE)] truncate" title={exp.title}>{exp.title || "—"}</span>
                      <span className="text-[12px] text-ds-t3 truncate" title={exp.description || undefined}>{exp.description || "No description"}</span>
                    </span>
                    <span>
                      <span className="inline-flex items-center h-[26px] px-[11px] rounded-full text-[11.5px] font-semibold whitespace-nowrap" style={{ background: rgba(cc, 0.12), color: cc }}>
                        {catLabel(exp.category)}
                      </span>
                    </span>
                    <span className="text-[14.5px] font-bold text-ds-text whitespace-nowrap">{inr(exp.amount)}</span>
                    <span className="flex flex-col gap-0.5 leading-[1.25] pl-6">
                      <span className="font-medium text-ds-t5 whitespace-nowrap">{fd(exp.createdAt)}</span>
                      <span className="text-[11.5px] text-ds-t3">{ago(exp.createdAt)}</span>
                    </span>
                    <span className="flex flex-col gap-1 min-w-0">
                      <span
                        className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full border text-[12px] font-semibold whitespace-nowrap w-fit"
                        style={{ background: rgba(st.color, 0.1), borderColor: rgba(st.color, 0.3), color: st.color }}
                      >
                        <i className="h-[5px] w-[5px] rounded-full" style={{ background: st.color }} />
                        {st.label}
                      </span>
                      {exp.status === "REJECTED" && exp.reviewNotes && (
                        <span className="text-[11px] text-ds-t3 truncate" title={exp.reviewNotes}>{exp.reviewNotes}</span>
                      )}
                    </span>
                    <span className="flex items-center justify-end gap-2">
                      {exp.status === "PENDING" ? (
                        <>
                          <button
                            type="button"
                            onClick={() => handleApprove(exp.id)}
                            disabled={isBusy}
                            title="Approve"
                            aria-label={`Approve ${exp.title}`}
                            className="h-[38px] w-[38px] rounded-full bg-ds-teal text-[color:var(--hx-04130D)] grid place-items-center hover:bg-[color:var(--hx-33E2B5)] disabled:opacity-50"
                          >
                            <Check className="h-[15px] w-[15px]" strokeWidth={2.6} />
                          </button>
                          <button
                            type="button"
                            onClick={() => { setRejectTarget(exp); setRejectReason(""); }}
                            disabled={isBusy}
                            title="Reject"
                            aria-label={`Reject ${exp.title}`}
                            className="h-[38px] w-[38px] rounded-full border border-[rgba(229,72,77,.45)] text-[color:var(--hx-FB7185)] grid place-items-center hover:bg-[rgba(229,72,77,.1)] disabled:opacity-50"
                          >
                            <X className="h-[15px] w-[15px]" strokeWidth={2.6} />
                          </button>
                        </>
                      ) : (
                        <span className="text-[color:var(--hx-4A6275)]">—</span>
                      )}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>

      {/* Reject Modal */}
      {rejectTarget && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(2,6,10,.7)]" onClick={() => !busy && setRejectTarget(null)}>
              <div
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Reject Expense Claim"
                className="relative w-full max-w-[420px] bg-ds-card border border-ds-line2 rounded-[16px] p-6 shadow-[0_20px_50px_rgba(0,0,0,.6)] overflow-hidden flex flex-col gap-4"
              >
                <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,var(--hx-FB7185)_30%,var(--hx-FB7185)_70%,transparent)]" />
                <div className="flex items-center justify-between">
                  <span className="text-[16px] font-semibold text-ds-text">Reject Expense Claim</span>
                  <button type="button" onClick={() => setRejectTarget(null)} disabled={!!busy} aria-label="Close" className="text-ds-t3 hover:text-ds-text">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex items-center justify-between gap-3 px-3.5 py-3 rounded-[10px] bg-ds-inset border border-ds-line">
                  <span className="min-w-0 leading-[1.35]">
                    <span className="block text-[13px] font-semibold text-ds-text truncate">{rejectTarget.title}</span>
                    <span className="block text-[11.5px] text-ds-t3">{rejectTarget.employee?.name || "—"}</span>
                  </span>
                  <span className="text-[15px] font-bold text-ds-text whitespace-nowrap">{inr(rejectTarget.amount)}</span>
                </div>
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Reason for rejection (optional)"
                  rows={3}
                  className="w-full px-3 py-2.5 rounded-[8px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] outline-none resize-y focus:border-ds-gold placeholder:text-ds-t4"
                />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setRejectTarget(null)} disabled={!!busy} className="h-[38px] px-4 rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold hover:text-ds-text disabled:opacity-50">
                    Cancel
                  </button>
                  <button type="button" onClick={() => handleReject(rejectTarget.id)} disabled={!!busy} className="h-[38px] px-5 rounded-full bg-[color:var(--hx-E5484D)] text-white text-[13px] font-bold disabled:opacity-60">
                    {busy === rejectTarget.id ? "Rejecting..." : "Reject"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
}
