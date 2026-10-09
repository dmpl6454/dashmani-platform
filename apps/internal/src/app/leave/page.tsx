"use client";
import { useState } from "react";
import useSWR from "swr";
import { CalendarOff, Check, X, Clock, Paperclip } from "lucide-react";
import { apiFetch, API_BASE } from "@/lib/api";
import { formatStatus } from "@dashmani/shared";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const STATUS_TABS = ["ALL", "PENDING", "APPROVED", "REJECTED"] as const;
type StatusTab = typeof STATUS_TABS[number];

// Mockup palette.
const STATUS_COLOR: Record<string, string> = { PENDING: "var(--hx-E9BD62)", APPROVED: "var(--hx-00D7A0)", REJECTED: "var(--hx-FB7185)" };
const TYPE_COLOR: Record<string, string> = { CASUAL: "var(--hx-6EB2FF)", SICK: "var(--hx-F59E66)", EARNED: "var(--hx-9B7EDE)", WFH: "var(--hx-00D7A0)" };
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

// Leave dates are calendar days — read the YYYY-MM-DD part so no timezone shifts a day.
const dayOf = (v?: string) => (v ? new Date(`${v.slice(0, 10)}T00:00:00`) : null);
const fd = (d: Date, withYear: boolean) => `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ""}`;
function dateRange(start: string, end?: string) {
  const s = dayOf(start);
  const e = dayOf(end) ?? s;
  if (!s || !e) return { range: "—", days: "" };
  const n = Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
  // Working days only: the working week is Monday–Saturday, Sunday is the one weekend day.
  let work = 0;
  for (let i = 0; i < n; i++) if (new Date(s.getFullYear(), s.getMonth(), s.getDate() + i).getDay() !== 0) work++;
  const thisYear = new Date().getFullYear();
  const showYear = s.getFullYear() !== thisYear || e.getFullYear() !== thisYear;
  const range = n <= 1 ? fd(s, showYear) : `${fd(s, showYear && s.getFullYear() !== e.getFullYear())} – ${fd(e, showYear)}`;
  return { range, days: `${work} working ${work === 1 ? "day" : "days"}` };
}

const GRID =
  "grid gap-x-3.5 items-center [grid-template-columns:minmax(160px,22fr)_minmax(76px,10fr)_minmax(110px,15fr)_minmax(100px,18fr)_minmax(84px,13fr)_minmax(104px,10fr)_minmax(196px,12fr)]";

export default function LeavePage() {
  usePageTitle("Leave");
  const [tab, setTab] = useState<StatusTab>("PENDING");
  const [actioning, setActioning] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  // One request for every status; the tabs filter it here so each tab can show its count.
  const { data, error, isLoading, mutate } = useSWR(`/admin/leave-requests`, (url: string) => apiFetch<any>(url), {
    revalidateOnFocus: true,
  });
  const all: any[] = data?.data || [];
  const leaves = tab === "ALL" ? all : all.filter((l) => l.status === tab);
  const count = (s: StatusTab) => (s === "ALL" ? all.length : all.filter((l) => l.status === s).length);
  const pendingCount = count("PENDING");

  async function act(id: string, kind: "approve" | "reject") {
    setActioning(id);
    setActionError("");
    try {
      await apiFetch(`/admin/leave-requests/${id}/${kind}`, { method: "POST" });
      mutate();
    } catch (e: any) {
      setActionError(e.message || `Failed to ${kind} the request`);
    }
    setActioning(null);
  }

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_320px] min-w-0">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Leave Requests</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">Approve or reject employee leave applications</p>
        </div>
        {pendingCount > 0 && (
          <span className="inline-flex items-center gap-2.5 h-10 px-5 rounded-full bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.35)] text-ds-text text-[13px] font-semibold whitespace-nowrap">
            <Clock className="h-[15px] w-[15px] text-ds-gold" />
            {pendingCount} Pending
          </span>
        )}
      </section>

      {/* Status tabs */}
      <section className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 p-[5px] rounded-full bg-ds-inset border border-ds-line2 max-w-full overflow-x-auto" role="tablist" aria-label="Status">
          {STATUS_TABS.map((t) => {
            const on = tab === t;
            return (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setTab(t)}
                className={`inline-flex items-center gap-2 h-9 px-[18px] rounded-full text-[13px] font-semibold whitespace-nowrap transition-colors ${
                  on ? "bg-ds-gold text-[color:var(--hx-060D14)]" : "text-ds-t2 hover:text-ds-text"
                }`}
              >
                {t === "ALL" ? "All" : formatStatus(t)}
                {data && <span className={`text-[11px] font-semibold ${on ? "text-[rgba(6,13,20,.6)]" : "text-ds-t3"}`}>{count(t)}</span>}
              </button>
            );
          })}
        </div>
        {data && (
          <span className="ml-auto text-[12px] text-ds-t3 whitespace-nowrap">
            {leaves.length} {leaves.length === 1 ? "request" : "requests"}
          </span>
        )}
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
          <div className="min-w-[960px]">
            <div className={`${GRID} h-[50px] px-5 bg-ds-inset border-b border-ds-line2 text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3 whitespace-nowrap`}>
              <span>Employee</span><span>Type</span><span>Dates</span><span>Reason</span><span>Attachment</span><span className="pl-4">Status</span><span>Actions</span>
            </div>
            {isLoading && !data ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`${GRID} h-[80px] px-5 border-b border-[color:var(--hx-132430)]`}>
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-ds-hover motion-safe:animate-pulse" />
                    <div className="h-3.5 w-28 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                  </div>
                </div>
              ))
            ) : error ? (
              <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">Leave requests couldn&apos;t be loaded just now. Refresh to try again.</div>
            ) : leaves.length === 0 ? (
              <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">
                <CalendarOff className="h-[30px] w-[30px] mx-auto mb-2.5 opacity-50" strokeWidth={1.5} />
                No leave requests found
              </div>
            ) : (
              leaves.map((leave: any) => {
                const name = leave.employee?.name || "—";
                const hue = HUES[hash(name) % HUES.length];
                const tc = TYPE_COLOR[leave.type] || "var(--hx-738395)";
                const sc = STATUS_COLOR[leave.status] || "var(--hx-738395)";
                const { range, days } = dateRange(leave.startDate, leave.endDate);
                const busy = actioning === leave.id;
                return (
                  <div key={leave.id} className={`${GRID} min-h-[80px] py-3 px-5 border-b border-[color:var(--hx-132430)] last:border-b-0 text-[13px] hover:bg-[color:var(--hx-0A1620)] transition-colors tabular-nums`}>
                    <span className="flex items-center gap-3 min-w-0">
                      <span
                        aria-hidden="true"
                        className="h-10 w-10 rounded-full border grid place-items-center text-[12px] font-bold shrink-0"
                        style={{ background: rgba(hue, 0.12), borderColor: rgba(hue, 0.3), color: hue }}
                      >
                        {initials(name)}
                      </span>
                      <span className="flex flex-col gap-0.5 min-w-0 leading-[1.25]">
                        <span className="text-[14.5px] font-semibold text-ds-text truncate" title={name}>{name}</span>
                        <span className="text-[12px] text-ds-t3 truncate" title={leave.employee?.email || undefined}>{leave.employee?.email || ""}</span>
                      </span>
                    </span>
                    <span>
                      <span
                        className="inline-flex items-center h-7 px-3 rounded-full text-[11.5px] font-semibold tracking-[.04em] whitespace-nowrap"
                        style={{ background: rgba(tc, 0.12), color: tc }}
                      >
                        {!leave.type ? "—" : leave.type.length <= 3 ? leave.type : formatStatus(leave.type)}
                      </span>
                    </span>
                    <span className="flex flex-col gap-0.5 min-w-0 leading-[1.25]">
                      <span className="font-semibold text-[color:var(--hx-E3E8EE)] truncate">{range}</span>
                      <span className="text-[11.5px] text-ds-t3">{days}</span>
                    </span>
                    <span className="text-[13px] text-ds-t2 truncate" title={leave.reason || undefined}>{leave.reason || "—"}</span>
                    <span className="min-w-0">
                      {leave.attachmentUrl ? (
                        <a
                          href={`${API_BASE}${leave.attachmentUrl}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={leave.attachmentName || "View attachment"}
                          className="inline-flex items-center gap-1.5 min-w-0 max-w-full text-[12.5px] font-semibold text-[color:var(--hx-6EB2FF)] hover:text-[color:var(--hx-9FCBFF)]"
                        >
                          <Paperclip className="h-[13px] w-[13px] shrink-0" />
                          <span className="truncate">{leave.attachmentName || "View"}</span>
                        </a>
                      ) : (
                        <span className="text-[color:var(--hx-4A6275)]">—</span>
                      )}
                    </span>
                    <span className="pl-4">
                      <span
                        className="inline-flex items-center gap-1.5 h-[30px] px-3 rounded-full border text-[12px] font-semibold whitespace-nowrap"
                        style={{ background: rgba(sc, 0.1), borderColor: rgba(sc, 0.3), color: sc }}
                      >
                        <i className="h-[5px] w-[5px] rounded-full" style={{ background: sc }} />
                        {formatStatus(leave.status)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      {leave.status === "PENDING" ? (
                        <>
                          <button
                            type="button"
                            onClick={() => act(leave.id, "approve")}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full bg-ds-teal text-[color:var(--hx-04130D)] text-[12px] font-bold whitespace-nowrap shrink-0 hover:bg-[color:var(--hx-33E2B5)] disabled:opacity-50"
                          >
                            <Check className="h-3 w-3" strokeWidth={2.6} /> Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => act(leave.id, "reject")}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full border border-[rgba(229,72,77,.4)] text-[color:var(--hx-FB7185)] text-[12px] font-bold whitespace-nowrap shrink-0 hover:bg-[rgba(229,72,77,.1)] disabled:opacity-50"
                          >
                            <X className="h-3 w-3" strokeWidth={2.6} /> Reject
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
    </div>
  );
}
