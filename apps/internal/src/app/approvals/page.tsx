"use client";

import { useState } from "react";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import { FileCheck, Image, CalendarOff, Check, X, FileText } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { formatStatus } from "@dashmani/shared";

type Tab = "documents" | "pictures" | "leave";
type LeaveFilter = "PENDING" | "APPROVED" | "REJECTED";

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
const fileUrl = (p?: string) => (!p ? null : p.startsWith("http") ? p : `${API_BASE}${p}`);
const fdy = (v: string) => { const d = new Date(v); return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`; };
function ago(v: string) {
  const d = new Date(v);
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const t = new Date(); const b = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const n = Math.round((b - a) / 86_400_000);
  return n <= 0 ? "Today" : n === 1 ? "Yesterday" : `${n} days ago`;
}
// Leave dates are calendar days — read the YYYY-MM-DD part so no timezone shifts a day.
const dayOf = (v?: string) => (v ? new Date(`${v.slice(0, 10)}T00:00:00`) : null);
function leaveRange(start?: string, end?: string) {
  const s = dayOf(start); const e = dayOf(end) ?? s;
  if (!s || !e) return { range: "—", days: "" };
  const n = Math.round((e.getTime() - s.getTime()) / 86_400_000) + 1;
  const f = (d: Date) => `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  return { range: n <= 1 ? f(s) : `${f(s)} – ${f(e)}`, days: `${n} ${n === 1 ? "day" : "days"}` };
}
const typeLabel = (t?: string) => (!t ? "—" : t.length <= 3 ? t : formatStatus(t));

// A picture that falls back to its placeholder when the file can't be loaded.
function Pic({ src, alt, fallback }: { src: string | null; alt: string; fallback: React.ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <>{fallback}</>;
  return <img src={src} alt={alt} onError={() => setFailed(src)} className="h-full w-full object-cover" />;
}

function Box({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={`h-5 w-5 rounded-[6px] border-[1.5px] grid place-items-center p-0 transition-colors ${on ? "bg-ds-gold border-ds-gold text-[color:var(--hx-060D14)]" : "border-[color:var(--hx-3A5568)] hover:border-ds-gold"}`}
    >
      {on && <Check className="h-3 w-3" strokeWidth={3.2} />}
    </button>
  );
}

function Who({ name, email, size = 40 }: { name: string; email?: string; size?: number }) {
  const hue = HUES[hash(name) % HUES.length];
  return (
    <span className="flex items-center gap-3 min-w-0">
      <span
        aria-hidden="true"
        className="rounded-full border grid place-items-center text-[12px] font-bold shrink-0"
        style={{ width: size, height: size, background: rgba(hue, 0.12), borderColor: rgba(hue, 0.3), color: hue }}
      >
        {initials(name)}
      </span>
      <span className="flex flex-col gap-0.5 min-w-0 leading-[1.25]">
        <span className="text-[14.5px] font-semibold text-ds-text truncate" title={name}>{name}</span>
        {email && <span className="text-[12px] text-ds-t3 truncate" title={email}>{email}</span>}
      </span>
    </span>
  );
}

const BTN_OK = "inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-full bg-ds-teal text-[color:var(--hx-04130D)] text-[12px] font-bold whitespace-nowrap shrink-0 hover:bg-[color:var(--hx-33E2B5)] disabled:opacity-50";
const BTN_NO = "inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-full border border-[rgba(229,72,77,.4)] text-[color:var(--hx-FB7185)] text-[12px] font-bold whitespace-nowrap shrink-0 hover:bg-[rgba(229,72,77,.1)] disabled:opacity-50";
const TABLE = "rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)]";
const HEAD = "h-[50px] px-5 bg-ds-inset border-b border-ds-line2 text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3 whitespace-nowrap";
const DOC_GRID = "grid gap-x-3.5 items-center [grid-template-columns:36px_minmax(160px,24fr)_minmax(110px,15fr)_minmax(130px,22fr)_minmax(96px,13fr)_minmax(196px,12fr)]";
const LEAVE_GRID = "grid gap-x-3.5 items-center [grid-template-columns:36px_minmax(160px,24fr)_minmax(120px,16fr)_minmax(76px,10fr)_minmax(110px,20fr)_minmax(196px,12fr)]";

export default function ApprovalsPage() {
  usePageTitle("Approvals");
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("documents");
  const [leaveFilter, setLeaveFilter] = useState<LeaveFilter>("PENDING");

  // Bulk selection state per tab
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [selectedPics, setSelectedPics] = useState<Set<string>>(new Set());
  const [selectedLeaves, setSelectedLeaves] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");

  const { data: docsData, error: docsError, mutate: mutateDocs } = useSWR("/admin/documents/pending", (url: string) => apiFetch<any>(url));
  const { data: picsData, error: picsError, mutate: mutatePics } = useSWR("/admin/profile-pictures/pending", (url: string) => apiFetch<any>(url));
  // One request for every leave status (shared with the Leave page); filtered here so each pill has a count.
  const { data: leaveData, error: leaveError, mutate: mutateLeave } = useSWR("/admin/leave-requests", (url: string) => apiFetch<any>(url));

  const docs: any[] = docsData?.data || [];
  const pics: any[] = picsData?.data || [];
  const allLeaves: any[] = leaveData?.data || [];
  const pendingLeaves = allLeaves.filter((l) => l.status === "PENDING");
  const leaves = allLeaves.filter((l) => l.status === leaveFilter);
  // Self-approval is refused by the API, so the user's own requests are never selectable.
  const selectableLeaves = leaveFilter === "PENDING" ? leaves.filter((l) => l.employeeId !== user?.id) : [];

  async function run(id: string, fn: () => Promise<unknown>, fallback: string) {
    setBusy(id);
    setActionError("");
    try { await fn(); } catch (e: any) { setActionError(e.message || fallback); }
    setBusy(null);
  }

  const reviewDocument = (id: string, status: "APPROVED" | "REJECTED") =>
    run(id, async () => {
      await apiFetch(`/admin/documents/${id}/review`, { method: "POST", body: JSON.stringify({ status }) });
      setSelectedDocs((s) => { const n = new Set(s); n.delete(id); return n; });
      mutateDocs();
    }, "Failed to review document");

  const reviewPicture = (id: string, action: "approve" | "reject") =>
    run(id, async () => {
      await apiFetch(`/admin/profile-pictures/${id}/${action}`, { method: "POST" });
      setSelectedPics((s) => { const n = new Set(s); n.delete(id); return n; });
      mutatePics();
    }, "Failed to review picture");

  const reviewLeave = (id: string, action: "approve" | "reject") =>
    run(id, async () => {
      await apiFetch(`/admin/leave-requests/${id}/${action}`, { method: "POST" });
      setSelectedLeaves((s) => { const n = new Set(s); n.delete(id); return n; });
      mutateLeave();
    }, "Failed to review leave request");

  async function bulkAction(tab: Tab, action: "APPROVE" | "REJECT") {
    setBulkLoading(true);
    setActionError("");
    try {
      if (tab === "documents") {
        await apiFetch("/admin/documents/bulk-review", { method: "POST", body: JSON.stringify({ ids: Array.from(selectedDocs), action }) });
        setSelectedDocs(new Set());
        mutateDocs();
      } else if (tab === "pictures") {
        await apiFetch("/admin/profile-pictures/bulk-review", { method: "POST", body: JSON.stringify({ ids: Array.from(selectedPics), action }) });
        setSelectedPics(new Set());
        mutatePics();
      } else {
        await apiFetch("/admin/leave-requests/bulk", { method: "POST", body: JSON.stringify({ ids: Array.from(selectedLeaves), action }) });
        setSelectedLeaves(new Set());
        mutateLeave();
      }
    } catch (e: any) {
      setActionError(e.message || "Bulk action failed");
    } finally {
      setBulkLoading(false);
    }
  }

  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    setter((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const allDocsOn = docs.length > 0 && selectedDocs.size === docs.length;
  const allLeavesOn = selectableLeaves.length > 0 && selectedLeaves.size === selectableLeaves.length;

  const tabs: { key: Tab; label: string; icon: typeof FileCheck; count: number }[] = [
    { key: "documents", label: "Documents", icon: FileCheck, count: docs.length },
    { key: "pictures", label: "Profile Pictures", icon: Image, count: pics.length },
    { key: "leave", label: "Leave Requests", icon: CalendarOff, count: pendingLeaves.length },
  ];
  const loaded = !!docsData && !!picsData && !!leaveData;
  const waiting = docs.length + pics.length + pendingLeaves.length;

  const selectedCount = activeTab === "documents" ? selectedDocs.size : activeTab === "pictures" ? selectedPics.size : leaveFilter === "PENDING" ? selectedLeaves.size : 0;
  const clearSelection = () => {
    if (activeTab === "documents") setSelectedDocs(new Set());
    else if (activeTab === "pictures") setSelectedPics(new Set());
    else setSelectedLeaves(new Set());
  };

  const empty = (text: string, dashed = false) => (
    <div className={`py-14 px-5 text-center text-ds-t3 text-[13px] ${dashed ? "rounded-[16px] border border-dashed border-ds-line2" : ""}`}>{text}</div>
  );
  const loadingRows = (grid: string) =>
    Array.from({ length: 3 }).map((_, i) => (
      <div key={i} className={`${grid} h-[80px] px-5 border-b border-[color:var(--hx-132430)]`}>
        <span />
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-ds-hover motion-safe:animate-pulse" />
          <div className="h-3.5 w-28 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
        </div>
      </div>
    ));

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="pt-[30px] pb-[22px]">
        <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Approvals</h1>
        <p className="mt-1.5 text-[13.5px] text-ds-t2">
          {!loaded ? "Loading…" : waiting ? `${waiting} ${waiting === 1 ? "item" : "items"} waiting for review` : "Everything is reviewed"}
        </p>
      </section>

      {/* Tabs */}
      <section className="flex gap-1 border-b border-ds-line overflow-x-auto overflow-y-hidden" role="tablist" aria-label="Approval type">
        {tabs.map((t) => {
          const Icon = t.icon;
          const on = activeTab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setActiveTab(t.key)}
              className={`inline-flex items-center gap-2.5 h-12 px-[18px] border-b-2 -mb-px text-[13.5px] font-semibold whitespace-nowrap shrink-0 transition-colors ${
                on ? "border-ds-gold text-ds-text" : "border-transparent text-ds-t2 hover:text-ds-text"
              }`}
            >
              <Icon className={`h-4 w-4 ${on ? "text-ds-gold" : ""}`} strokeWidth={1.8} />
              {t.label}
              {t.count > 0 && (
                <span className="h-[22px] min-w-[22px] px-[7px] rounded-full bg-[rgba(233,189,98,.16)] text-ds-gold text-[11px] font-bold grid place-items-center">{t.count}</span>
              )}
            </button>
          );
        })}
      </section>

      {actionError && (
        <div className="mt-4 px-3.5 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12.5px] flex items-center justify-between gap-3">
          <span>{actionError}</span>
          <button type="button" onClick={() => setActionError("")} aria-label="Dismiss" className="shrink-0 hover:text-ds-text"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="flex flex-col gap-4 mt-[22px]">
        {/* Documents */}
        {activeTab === "documents" && (
          <section className={TABLE}>
            <div className="overflow-x-auto">
              <div className="min-w-[940px]">
                <div className={`${DOC_GRID} ${HEAD}`}>
                  <span>{docs.length > 0 && <Box on={allDocsOn} label="Select all documents" onClick={() => setSelectedDocs(allDocsOn ? new Set() : new Set(docs.map((d) => d.id)))} />}</span>
                  <span>Employee</span><span>Document Type</span><span>Filename</span><span>Upload Date</span><span>Actions</span>
                </div>
                {!docsData && !docsError ? loadingRows(DOC_GRID)
                  : docsError ? empty("Documents couldn't be loaded just now. Refresh to try again.")
                  : docs.length === 0 ? empty("No documents pending review")
                  : docs.map((doc) => {
                      const sel = selectedDocs.has(doc.id);
                      const name = doc.employeeName || doc.employee?.name || "—";
                      const file = doc.fileName || doc.filename || doc.originalName;
                      const url = fileUrl(doc.filePath);
                      const when = doc.createdAt || doc.uploadedAt;
                      return (
                        <div key={doc.id} className={`${DOC_GRID} min-h-[80px] py-3 px-5 border-b border-[color:var(--hx-132430)] last:border-b-0 text-[13px] hover:bg-[color:var(--hx-0A1620)] transition-colors ${sel ? "bg-[rgba(233,189,98,.05)]" : ""}`}>
                          <span><Box on={sel} label={`Select ${name}`} onClick={() => toggle(setSelectedDocs, doc.id)} /></span>
                          <Who name={name} email={doc.employee?.email} />
                          <span className="font-medium text-ds-t5 truncate">{typeLabel(doc.documentType || doc.type)}</span>
                          <span className="min-w-0">
                            {file && url ? (
                              <a href={url} target="_blank" rel="noopener noreferrer" title={file} className="inline-flex items-center gap-[7px] min-w-0 max-w-full text-[13px] font-semibold text-[color:var(--hx-6EB2FF)] hover:text-[color:var(--hx-9FCBFF)]">
                                <FileText className="h-3.5 w-3.5 shrink-0" />
                                <span className="truncate">{file}</span>
                              </a>
                            ) : (
                              <span className="text-ds-t5 truncate block" title={file || undefined}>{file || "—"}</span>
                            )}
                          </span>
                          <span className="flex flex-col gap-0.5 leading-[1.25] min-w-0">
                            <span className="font-semibold text-[color:var(--hx-E3E8EE)] whitespace-nowrap">{when ? fdy(when) : "—"}</span>
                            {when && <span className="text-[11.5px] text-ds-t3">{ago(when)}</span>}
                          </span>
                          <span className="flex items-center gap-2">
                            <button type="button" onClick={() => reviewDocument(doc.id, "APPROVED")} disabled={busy === doc.id} className={BTN_OK}><Check className="h-3 w-3" strokeWidth={2.6} />Approve</button>
                            <button type="button" onClick={() => reviewDocument(doc.id, "REJECTED")} disabled={busy === doc.id} className={BTN_NO}><X className="h-3 w-3" strokeWidth={2.6} />Reject</button>
                          </span>
                        </div>
                      );
                    })}
              </div>
            </div>
          </section>
        )}

        {/* Profile pictures */}
        {activeTab === "pictures" && (
          !picsData && !picsError ? (
            <div className="h-[260px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
          ) : picsError ? empty("Profile pictures couldn't be loaded just now. Refresh to try again.", true)
          : pics.length === 0 ? empty("No profile pictures pending review", true)
          : (
            <section className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]">
              {pics.map((pic) => {
                const sel = selectedPics.has(pic.id);
                const name = pic.employeeName || pic.employee?.name || "Unknown";
                const hue = HUES[hash(name) % HUES.length];
                const current = fileUrl(pic.employee?.profileImageUrl);
                const next = fileUrl(pic.filePath);
                return (
                  <div key={pic.id} className={`flex flex-col gap-[18px] p-5 rounded-[16px] bg-ds-card border transition-colors ${sel ? "border-[rgba(233,189,98,.55)]" : "border-ds-line"}`}>
                    <div className="flex items-center gap-3 min-w-0">
                      <Box on={sel} label={`Select ${name}`} onClick={() => toggle(setSelectedPics, pic.id)} />
                      <span className="flex flex-col gap-0.5 min-w-0 leading-[1.25]">
                        <span className="text-[15px] font-semibold text-ds-text truncate">{name}</span>
                        {pic.createdAt && <span className="text-[12px] text-ds-t3">Submitted {ago(pic.createdAt).toLowerCase()}</span>}
                      </span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 py-4 px-2 rounded-[12px] bg-ds-inset border border-ds-line">
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-[10px] font-semibold tracking-[.14em] uppercase text-ds-t3">Current</span>
                        <span className="h-[72px] w-[72px] rounded-full bg-[color:var(--hx-132430)] border-2 border-ds-line2 overflow-hidden grid place-items-center text-ds-t3 text-[11px]">
                          <Pic src={current} alt={`${name} current`} fallback={current ? "Unavailable" : "None"} />
                        </span>
                      </div>
                      <span className="text-[color:var(--hx-4A6275)] text-[16px]" aria-hidden="true">→</span>
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-[10px] font-semibold tracking-[.14em] uppercase text-ds-gold">New</span>
                        <span
                          className="h-[72px] w-[72px] rounded-full border-2 border-ds-gold overflow-hidden grid place-items-center text-[18px] font-bold"
                          style={{ background: rgba(hue, 0.12), color: hue }}
                        >
                          <Pic src={next} alt={`${name} new`} fallback={initials(name)} />
                        </span>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => reviewPicture(pic.id, "approve")} disabled={busy === pic.id} className={`${BTN_OK} h-10 text-[12.5px]`}><Check className="h-3 w-3" strokeWidth={2.6} />Approve</button>
                      <button type="button" onClick={() => reviewPicture(pic.id, "reject")} disabled={busy === pic.id} className={`${BTN_NO} h-10 text-[12.5px]`}><X className="h-3 w-3" strokeWidth={2.6} />Reject</button>
                    </div>
                  </div>
                );
              })}
            </section>
          )
        )}

        {/* Leave requests */}
        {activeTab === "leave" && (
          <>
            <div className="flex gap-1 p-[5px] rounded-full bg-ds-inset border border-ds-line2 w-max max-w-full overflow-x-auto" role="tablist" aria-label="Leave status">
              {(["PENDING", "APPROVED", "REJECTED"] as LeaveFilter[]).map((f) => {
                const on = leaveFilter === f;
                return (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => { setLeaveFilter(f); setSelectedLeaves(new Set()); }}
                    className={`inline-flex items-center gap-2 h-9 px-[18px] rounded-full text-[13px] font-semibold whitespace-nowrap transition-colors ${on ? "bg-ds-gold text-[color:var(--hx-060D14)]" : "text-ds-t2 hover:text-ds-text"}`}
                  >
                    {formatStatus(f)}
                    {leaveData && <span className={`text-[11px] font-semibold ${on ? "text-[rgba(6,13,20,.6)]" : "text-ds-t3"}`}>{allLeaves.filter((l) => l.status === f).length}</span>}
                  </button>
                );
              })}
            </div>
            <section className={TABLE}>
              <div className="overflow-x-auto">
                <div className="min-w-[940px]">
                  <div className={`${LEAVE_GRID} ${HEAD}`}>
                    <span>
                      {leaveFilter === "PENDING" && selectableLeaves.length > 0 && (
                        <Box on={allLeavesOn} label="Select all leave requests" onClick={() => setSelectedLeaves(allLeavesOn ? new Set() : new Set(selectableLeaves.map((l) => l.id)))} />
                      )}
                    </span>
                    <span>Employee</span><span>Date Range</span><span>Type</span><span>Reason</span>
                    <span>{leaveFilter === "PENDING" ? "Actions" : "Status"}</span>
                  </div>
                  {!leaveData && !leaveError ? loadingRows(LEAVE_GRID)
                    : leaveError ? empty("Leave requests couldn't be loaded just now. Refresh to try again.")
                    : leaves.length === 0 ? empty(`No ${leaveFilter.toLowerCase()} leave requests`)
                    : leaves.map((leave) => {
                        const name = leave.employeeName || leave.employee?.name || "—";
                        const self = leave.employeeId === user?.id;
                        const pending = leave.status === "PENDING";
                        const sel = selectedLeaves.has(leave.id);
                        const { range, days } = leaveRange(leave.startDate, leave.endDate);
                        const type = leave.leaveType || leave.type;
                        const tc = TYPE_COLOR[type] || "var(--hx-A7B3C2)";
                        const sc = STATUS_COLOR[leave.status] || "var(--hx-738395)";
                        return (
                          <div key={leave.id} className={`${LEAVE_GRID} min-h-[80px] py-3 px-5 border-b border-[color:var(--hx-132430)] last:border-b-0 text-[13px] hover:bg-[color:var(--hx-0A1620)] transition-colors ${sel ? "bg-[rgba(233,189,98,.05)]" : ""}`}>
                            <span>{pending && !self && <Box on={sel} label={`Select ${name}`} onClick={() => toggle(setSelectedLeaves, leave.id)} />}</span>
                            <Who name={name} email={leave.employee?.email} />
                            <span className="flex flex-col gap-0.5 min-w-0 leading-[1.25]">
                              <span className="font-semibold text-[color:var(--hx-E3E8EE)] truncate">{range}</span>
                              <span className="text-[11.5px] text-ds-t3">{days}</span>
                            </span>
                            <span>
                              <span className="inline-flex items-center h-7 px-3 rounded-full text-[11.5px] font-semibold whitespace-nowrap" style={{ background: rgba(tc, 0.12), color: tc }}>
                                {typeLabel(type)}
                              </span>
                            </span>
                            <span className="text-ds-t2 truncate" title={leave.reason || undefined}>{leave.reason || "—"}</span>
                            <span className="flex items-center gap-2 min-w-0">
                              {pending && self ? (
                                <span className="text-[12.5px] italic text-ds-t3 whitespace-nowrap">Self-approval not allowed</span>
                              ) : pending ? (
                                <>
                                  <button type="button" onClick={() => reviewLeave(leave.id, "approve")} disabled={busy === leave.id} className={BTN_OK}><Check className="h-3 w-3" strokeWidth={2.6} />Approve</button>
                                  <button type="button" onClick={() => reviewLeave(leave.id, "reject")} disabled={busy === leave.id} className={BTN_NO}><X className="h-3 w-3" strokeWidth={2.6} />Reject</button>
                                </>
                              ) : (
                                <span className="flex flex-col gap-1">
                                  <span
                                    className="inline-flex items-center gap-1.5 h-[30px] px-3 rounded-full border text-[12px] font-semibold whitespace-nowrap w-fit"
                                    style={{ background: rgba(sc, 0.1), borderColor: rgba(sc, 0.3), color: sc }}
                                  >
                                    <i className="h-[5px] w-[5px] rounded-full" style={{ background: sc }} />
                                    {formatStatus(leave.status)}
                                  </span>
                                  {leave.approvedAt && <span className="text-[11px] text-ds-t3">on {fdy(leave.approvedAt)}</span>}
                                </span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                </div>
              </div>
            </section>
          </>
        )}
      </div>

      {/* Bulk bar */}
      {selectedCount > 0 && (
        <div className="sticky bottom-5 z-20 flex justify-center mt-5 pointer-events-none">
          <div className="flex items-center gap-2.5 flex-wrap justify-center py-2 pl-5 pr-2 rounded-[28px] bg-[color:var(--hx-0E1B25)] border border-[color:var(--hx-2A4658)] shadow-[0_16px_40px_rgba(0,0,0,.55)] pointer-events-auto max-w-full">
            <span className="text-[13px] font-semibold text-ds-text whitespace-nowrap mr-1.5">{selectedCount} selected</span>
            <button type="button" disabled={bulkLoading} onClick={() => bulkAction(activeTab, "APPROVE")} className={`${BTN_OK} h-10 px-4 text-[12.5px]`}>
              <Check className="h-3 w-3" strokeWidth={2.6} /> Approve Selected
            </button>
            <button type="button" disabled={bulkLoading} onClick={() => bulkAction(activeTab, "REJECT")} className={`${BTN_NO} h-10 px-4 text-[12.5px]`}>
              <X className="h-3 w-3" strokeWidth={2.6} /> Reject Selected
            </button>
            <button type="button" onClick={clearSelection} title="Clear selection" aria-label="Clear selection" className="h-10 w-10 rounded-full grid place-items-center text-ds-t3 hover:text-ds-text">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
