"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Bug, ChevronRight, Clock, Check, X } from "lucide-react";
import { formatStatus } from "@dashmani/shared";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const STATUSES = ["", "OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];
// Mockup palette.
const STATUS_COLOR: Record<string, string> = { OPEN: "var(--hx-FB7185)", IN_PROGRESS: "var(--hx-E9BD62)", RESOLVED: "var(--hx-00D7A0)", CLOSED: "var(--hx-738395)", WONT_FIX: "var(--hx-738395)" };
const SEVERITY_COLOR: Record<string, string> = { LOW: "var(--hx-6EB2FF)", MEDIUM: "var(--hx-E9BD62)", HIGH: "var(--hx-FB923C)", CRITICAL: "var(--hx-FB7185)" };
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const fdY = (v: string) => { const d = new Date(v); return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`; };
const statusLabel = (s: string) => (s === "WONT_FIX" ? "Won't Fix" : formatStatus(s));
const Dot = () => <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-[color:var(--hx-4A6275)] shrink-0" />;

function Pill({ color, dot, children }: { color: string; dot?: boolean; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-[5px] h-[22px] px-[9px] rounded-full border text-[11px] font-semibold whitespace-nowrap"
      style={{ background: rgba(color, 0.1), borderColor: rgba(color, 0.3), color }}
    >
      {dot && <i className="h-1 w-1 rounded-full" style={{ background: color }} />}
      {children}
    </span>
  );
}

function ActionBtn({ color, onClick, icon, children, disabled }: { color: string; onClick: () => void; icon: React.ReactNode; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-[7px] h-[38px] px-[15px] rounded-full border text-[12.5px] font-semibold whitespace-nowrap transition-colors disabled:opacity-50"
      style={{ borderColor: rgba(color, 0.33), background: rgba(color, 0.08), color }}
    >
      {icon}
      {children}
    </button>
  );
}

export default function BugReportsPage() {
  usePageTitle("Bug Reports");
  const [statusFilter, setStatusFilter] = useState("");
  // One request for every status, filtered here so each tab can show its count.
  const { data, error, isLoading, mutate } = useSWR(`/admin/bug-reports`, (url: string) => apiFetch<any>(url));
  const all: any[] = data?.data || [];
  const bugs = statusFilter ? all.filter((b) => b.status === statusFilter) : all;
  const count = (s: string) => (s ? all.filter((b) => b.status === s).length : all.length);
  const openCount = count("OPEN");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  async function updateStatus(id: string, status: string) {
    setBusy(true);
    setActionError("");
    try {
      await apiFetch(`/admin/bug-reports/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status, resolution: resolution || undefined }),
      });
      setResolution("");
      mutate();
    } catch (e: any) { setActionError(e.message || "Failed to update the bug report"); }
    setBusy(false);
  }

  return (
    <div className="pb-8">
      {/* Header + status tabs */}
      <section className="flex items-center justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex items-center gap-3.5 flex-wrap min-w-0">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Bug Reports</h1>
          {openCount > 0 && (
            <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-[rgba(251,113,133,.1)] border border-[rgba(251,113,133,.35)] text-[color:var(--hx-FB7185)] text-[12px] font-semibold whitespace-nowrap">
              <i className="h-[5px] w-[5px] rounded-full bg-[color:var(--hx-FB7185)]" />
              {openCount} Open
            </span>
          )}
        </div>
        <div className="flex gap-1 p-[5px] rounded-full bg-ds-inset border border-ds-line2 max-w-full overflow-x-auto" role="tablist" aria-label="Status">
          {STATUSES.map((s) => {
            const on = statusFilter === s;
            return (
              <button
                key={s || "all"}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setStatusFilter(s)}
                className={`inline-flex items-center gap-2 h-9 px-4 rounded-full text-[13px] font-semibold whitespace-nowrap shrink-0 transition-colors ${on ? "bg-ds-gold text-[color:var(--hx-060D14)]" : "text-ds-t2 hover:text-ds-text"}`}
              >
                {s ? statusLabel(s) : "All"}
                {data && <span className={`text-[11px] font-semibold ${on ? "text-[rgba(6,13,20,.6)]" : "text-ds-t3"}`}>{count(s)}</span>}
              </button>
            );
          })}
        </div>
      </section>

      {actionError && (
        <div className="mb-3.5 px-3.5 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12.5px] flex items-center justify-between gap-3">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError("")} aria-label="Dismiss" className="shrink-0 hover:text-ds-text"><X className="h-4 w-4" /></button>
        </div>
      )}

      <section className="flex flex-col gap-3">
        {isLoading && !data ? (
          Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-[86px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />)
        ) : error ? (
          <div className="rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card py-14 px-5 text-center text-[13px] text-ds-t3">
            Bug reports couldn&apos;t be loaded just now. Refresh to try again.
          </div>
        ) : bugs.length === 0 ? (
          <div className="rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card py-14 px-5 flex flex-col items-center gap-3 text-[13px] text-ds-t3">
            <Bug className="h-8 w-8" strokeWidth={1.5} />
            No bug reports
          </div>
        ) : (
          bugs.map((bug: any) => {
            const open = expandedId === bug.id;
            const sevColor = SEVERITY_COLOR[bug.severity] ?? "var(--hx-A7B3C2)";
            const stColor = STATUS_COLOR[bug.status] ?? "var(--hx-738395)";
            const live = bug.status === "OPEN" || bug.status === "IN_PROGRESS";
            return (
              <div
                key={bug.id}
                className={`rounded-[16px] border bg-ds-card overflow-hidden shadow-[0_8px_24px_rgba(0,0,0,.25)] transition-colors ${open ? "border-[rgba(233,189,98,.4)]" : "border-[color:var(--hx-2A4658)]"}`}
              >
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => { setExpandedId(open ? null : bug.id); setResolution(""); }}
                  className={`w-full flex items-center gap-3.5 px-6 py-5 text-left hover:bg-[color:var(--hx-0A1620)] transition-colors ${open ? "bg-[color:var(--hx-0A1620)]" : ""}`}
                >
                  <span className="flex-1 min-w-0 flex flex-col gap-[5px]">
                    <span className="flex items-center gap-2 flex-wrap min-w-0">
                      <span className="text-[16px] font-semibold text-ds-text min-w-0 break-words">{bug.title}</span>
                      {bug.severity && <Pill color={sevColor}>{formatStatus(bug.severity)}</Pill>}
                      <Pill color={stColor} dot>{statusLabel(bug.status)}</Pill>
                    </span>
                    <span className="flex items-center gap-2 flex-wrap text-[12px] text-ds-t3">
                      <span className="whitespace-nowrap">by <span className="text-ds-t5 font-medium">{bug.reporter?.name ?? "—"}</span></span>
                      <Dot />
                      <span className="whitespace-nowrap">{fdY(bug.createdAt)}</span>
                      {bug.page && (
                        <>
                          <Dot />
                          <span className="min-w-0 break-all">Page: <span className="font-mono text-[11.5px] text-ds-t2">{bug.page}</span></span>
                        </>
                      )}
                    </span>
                  </span>
                  <ChevronRight className={`h-[15px] w-[15px] text-ds-t3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
                </button>
                {open && (
                  <div className="px-6 pt-1 pb-[22px] flex flex-col gap-3.5">
                    <p className="text-[13.5px] leading-[1.6] text-ds-t2 whitespace-pre-line break-words [text-wrap:pretty]">{bug.description}</p>
                    {bug.resolution && (
                      <div className="px-3.5 py-3 rounded-[12px] bg-[rgba(0,215,160,.06)] border border-[rgba(0,215,160,.25)]">
                        <div className="text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-teal">Resolution</div>
                        <p className="mt-1.5 text-[13px] leading-[1.55] text-[color:var(--hx-E3E8EE)] whitespace-pre-line break-words">{bug.resolution}</p>
                      </div>
                    )}
                    <div className="flex items-center gap-2 flex-wrap pt-3.5 border-t border-[color:var(--hx-132430)]">
                      <input
                        type="text"
                        placeholder="Resolution note (optional)"
                        aria-label="Resolution note"
                        value={resolution}
                        onChange={(e) => setResolution(e.target.value)}
                        className="h-10 px-3 rounded-[10px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] outline-none focus:border-ds-gold placeholder:text-ds-t4 flex-[1_1_220px] min-w-[180px]"
                      />
                      {bug.status === "OPEN" && (
                        <ActionBtn color="var(--hx-E9BD62)" disabled={busy} onClick={() => updateStatus(bug.id, "IN_PROGRESS")} icon={<Clock className="h-[13px] w-[13px]" strokeWidth={2.2} />}>
                          In Progress
                        </ActionBtn>
                      )}
                      {live && (
                        <>
                          <ActionBtn color="var(--hx-00D7A0)" disabled={busy} onClick={() => updateStatus(bug.id, "RESOLVED")} icon={<Check className="h-[13px] w-[13px]" strokeWidth={2.2} />}>
                            Resolve
                          </ActionBtn>
                          <ActionBtn color="var(--hx-A7B3C2)" disabled={busy} onClick={() => updateStatus(bug.id, "WONT_FIX")} icon={<X className="h-[13px] w-[13px]" strokeWidth={2.2} />}>
                            Won&apos;t Fix
                          </ActionBtn>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
