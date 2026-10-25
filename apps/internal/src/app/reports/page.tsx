"use client";
import { memo, useCallback, useState, useEffect } from "react";
import Link from "next/link";
import { Users, FileText, Link2, Calendar, X, TrendingUp, Trophy, Trash2, AlertTriangle, BarChart2, ArrowUpDown, ArrowUp, ArrowDown, Eye, Heart, MessageCircle, ChevronDown } from "lucide-react";
import { useTopLinks } from "@/lib/hooks/use-reports";
import { useAdminReports, useReportSummary, useInsightsSummary } from "@/lib/hooks/use-reports";
import { useEmployees } from "@/lib/hooks/use-employees";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { DsRangeFilters, presetStart, todayISO, rangeLabel } from "./_range";
import { ExportButton, AllLinksCsvButton } from "./_export";
import { TrueLinksPanel } from "./_true-links";

// Mockup palette.
const PLATFORM_COLOR: Record<string, string> = {
  instagram: "var(--hx-F472B6)",
  facebook: "var(--hx-6EB2FF)",
  youtube: "var(--hx-FB7185)",
  snapchat: "var(--hx-FACC15)",
  twitter: "var(--hx-38BDF8)",
  linkedin: "var(--hx-4AA3DF)",
  tiktok: "var(--hx-A7B3C2)",
};
const platformColor = (p?: string) => PLATFORM_COLOR[(p ?? "").toLowerCase()] ?? "var(--hx-E9BD62)";
const PLATFORM_NAME: Record<string, string> = { youtube: "YouTube", tiktok: "TikTok", linkedin: "LinkedIn" };
const platformName = (p?: string) => {
  const k = (p ?? "").toLowerCase();
  return PLATFORM_NAME[k] ?? (k ? k.charAt(0).toUpperCase() + k.slice(1) : "—");
};
const HUES = ["var(--hx-238BFF)", "var(--hx-E9BD62)", "var(--hx-9B7EDE)", "var(--hx-00D7A0)", "var(--hx-FB7185)", "var(--hx-6EB2FF)"];
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
};
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const initials = (name?: string) =>
  (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
const nf = new Intl.NumberFormat("en-IN");

function Mono({ name, size = 36 }: { name?: string; size?: number }) {
  const hue = HUES[hash(name || "") % HUES.length];
  return (
    <span
      aria-hidden="true"
      className="rounded-full border grid place-items-center font-bold shrink-0"
      style={{ width: size, height: size, fontSize: size >= 40 ? 12 : 11, background: rgba(hue, 0.12), borderColor: rgba(hue, 0.3), color: hue }}
    >
      {initials(name)}
    </span>
  );
}

function PlatformBadge({ platform }: { platform?: string }) {
  const c = platformColor(platform);
  return (
    <span
      className="inline-flex items-center h-[22px] px-[9px] rounded-full border text-[10px] font-bold tracking-[.06em] uppercase whitespace-nowrap shrink-0"
      style={{ background: rgba(c, 0.1), borderColor: rgba(c, 0.3), color: c }}
    >
      {platform ?? "—"}
    </span>
  );
}

const CARD = "flex flex-col min-w-0 rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)]";
const HEAD_ROW = "bg-ds-inset border-b border-ds-line2 text-[10.5px] font-semibold tracking-[.08em] uppercase text-ds-t3 whitespace-nowrap";
const BTN = "inline-flex items-center gap-2 h-[42px] px-4 rounded-full border border-ds-line2 bg-ds-inset text-ds-t5 text-[13px] font-semibold whitespace-nowrap hover:border-[color:var(--hx-2A4658)] hover:text-ds-text";

type SortKey = "name" | "email" | "reportCount" | "totalLinks" | "linksToday" | "avgLinksPerDay" | "currentStreak" | "lastSubmittedAt";
type SortDir = "asc" | "desc";

function sortEmployees(employees: any[], key: SortKey, dir: SortDir): any[] {
  return [...employees].sort((a, b) => {
    let av: any;
    let bv: any;
    if (key === "avgLinksPerDay") {
      av = parseFloat(a.avgLinksPerDay ?? "0") || 0;
      bv = parseFloat(b.avgLinksPerDay ?? "0") || 0;
    } else if (key === "lastSubmittedAt") {
      av = a.lastSubmittedAt ? new Date(a.lastSubmittedAt).getTime() : 0;
      bv = b.lastSubmittedAt ? new Date(b.lastSubmittedAt).getTime() : 0;
    } else if (key === "name" || key === "email") {
      av = (a[key] ?? "").toLowerCase();
      bv = (b[key] ?? "").toLowerCase();
    } else {
      av = a[key] ?? 0;
      bv = b[key] ?? 0;
    }
    if (av < bv) return dir === "asc" ? -1 : 1;
    if (av > bv) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

interface SortIconProps { col: SortKey; sortKey: SortKey; sortDir: SortDir; }
function SortIcon({ col, sortKey, sortDir }: SortIconProps) {
  if (col !== sortKey) return <ArrowUpDown className="h-3 w-3 opacity-45 shrink-0" />;
  return sortDir === "asc" ? <ArrowUp className="h-3 w-3 text-ds-gold shrink-0" /> : <ArrowDown className="h-3 w-3 text-ds-gold shrink-0" />;
}

const SUMMARY_GRID =
  "grid gap-x-3.5 items-center [grid-template-columns:minmax(200px,20fr)_minmax(170px,20fr)_80px_110px_80px_80px_80px_110px_110px]";

interface EmployeeRowProps {
  emp: any;
  onOpenEmpModal: (emp: any) => void;
  onOpenTodayModal: (emp: any) => void;
}

const EmployeeRow = memo(function EmployeeRow({ emp, onOpenEmpModal, onOpenTodayModal }: EmployeeRowProps) {
  const today = emp.linksToday ?? 0;
  const streak = emp.currentStreak ?? 0;
  return (
    <div className={`${SUMMARY_GRID} min-h-[64px] py-2.5 px-6 border-b border-[color:var(--hx-132430)] last:border-b-0 text-[13px] tabular-nums hover:bg-[color:var(--hx-0A1620)] transition-colors`}>
      <span className="flex items-center gap-3 min-w-0">
        <Mono name={emp.name} />
        <span className="text-[14px] font-semibold text-ds-text truncate" title={emp.name}>{emp.name}</span>
      </span>
      <span className="text-ds-t2 truncate" title={emp.email}>{emp.email}</span>
      <span className="text-right">
        <span className="inline-flex items-center justify-center min-w-[32px] h-[26px] px-2 rounded-[8px] bg-[rgba(155,126,222,.14)] text-[color:var(--hx-B8A3EC)] font-bold">
          {emp.reportCount}
        </span>
      </span>
      <span className="text-right">
        <button
          type="button"
          onClick={() => onOpenEmpModal(emp)}
          title="View per-platform breakdown for the selected window"
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[8px] bg-[rgba(0,215,160,.1)] text-ds-teal font-bold hover:bg-[rgba(0,215,160,.18)]"
        >
          {nf.format(emp.totalLinks ?? 0)}
          <BarChart2 className="h-3 w-3 opacity-70" />
        </button>
      </span>
      <span className="text-right">
        <button
          type="button"
          onClick={() => onOpenTodayModal(emp)}
          title="View today's per-platform breakdown (always today, ignores the date filter)"
          className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-[8px] font-semibold ${today > 0 ? "text-ds-teal hover:bg-[rgba(0,215,160,.1)]" : "text-[color:var(--hx-4A6275)] hover:bg-ds-hover"}`}
        >
          {today > 0 ? nf.format(today) : "—"}
          <BarChart2 className="h-3 w-3 opacity-60" />
        </button>
      </span>
      <span className="text-right text-ds-t5">{emp.avgLinksPerDay ?? "—"}</span>
      <span className={`text-right font-bold ${streak ? "text-[color:var(--hx-F59E66)]" : "text-ds-t3"}`}>{streak} 🔥</span>
      <span className="text-ds-t2 whitespace-nowrap">
        {emp.lastSubmittedAt ? new Date(emp.lastSubmittedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—"}
      </span>
      <span className="text-right">
        <Link href={`/reports/${emp.id}`} className="text-[12.5px] font-semibold text-ds-gold hover:text-[color:var(--hx-F4D58C)] whitespace-nowrap">
          View Details →
        </Link>
      </span>
    </div>
  );
});

interface ReportCardProps {
  report: any;
  isAdmin: boolean;
  open: boolean;
  onToggle: () => void;
  deletingLinkId: string | null;
  onDeleteLink: (linkId: string) => void;
}

const ReportCard = memo(function ReportCard({ report, isAdmin, open, onToggle, deletingLinkId, onDeleteLink }: ReportCardProps) {
  const [showAllLinks, setShowAllLinks] = useState(false);
  const LINK_CAP = 20;
  const allLinks = report.links ?? [];
  const shownLinks = showAllLinks ? allLinks : allLinks.slice(0, LINK_CAP);
  const time = report.submittedAt
    ? new Date(report.submittedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div
      className={`rounded-[16px] border bg-ds-card overflow-hidden transition-colors ${open ? "border-[color:var(--hx-2A4658)]" : "border-ds-line"}`}
      style={{ contentVisibility: "auto", containIntrinsicSize: open ? "420px" : "80px" } as any}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-3.5 flex-wrap min-h-[72px] px-[22px] py-3.5 text-left hover:bg-[color:var(--hx-0A1620)] transition-colors"
      >
        <Mono name={report.employee?.name} size={40} />
        <span className="flex-[1_1_200px] min-w-0 leading-[1.3]">
          <span className="block text-[15px] font-semibold text-ds-text truncate">{report.employee?.name ?? "Unknown"}</span>
          <span className="block text-[12.5px] text-ds-t3 truncate">{report.employee?.email}</span>
        </span>
        <span className="flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center h-[30px] px-3 rounded-full bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.3)] text-ds-gold text-[12px] font-semibold whitespace-nowrap">
            {new Date(report.date ?? report.createdAt).toLocaleDateString()}
          </span>
          <span className="inline-flex items-center gap-1.5 h-[30px] px-3 rounded-full bg-[rgba(0,215,160,.1)] border border-[rgba(0,215,160,.28)] text-ds-teal text-[12px] font-bold whitespace-nowrap">
            <Link2 className="h-3.5 w-3.5" />
            {report.links?.length ?? 0}
          </span>
          <ChevronDown className={`h-4 w-4 text-ds-t3 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>

      {open && (
        <div className="border-t border-ds-line py-1.5">
          {report.notes && (
            // break-words: notes are free text and occasionally contain an unbroken URL.
            <p className="px-[22px] sm:pl-[76px] py-2 text-[12.5px] text-ds-t2 italic break-words">{report.notes}</p>
          )}
          {shownLinks.map((link: any, i: number) => (
            /* Phones: the row wraps — badge, account and time on top, the URL full-width
               below. Only the URL and account shrink, so nothing paints over anything. */
            <div
              key={link.id ?? i}
              className="group/link flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 min-h-[42px] py-1.5 px-[22px] sm:pl-[76px] text-[12.5px] hover:bg-[color:var(--hx-0A1620)]"
            >
              <PlatformBadge platform={link.platform} />
              {link.accountName && (
                <span className="font-semibold text-ds-t5 truncate min-w-0 max-w-[45%] sm:max-w-[160px]" title={link.accountName}>{link.accountName}</span>
              )}
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                title={link.url}
                className="order-last sm:order-none basis-full sm:basis-0 grow min-w-0 truncate text-ds-t3 hover:text-ds-gold"
              >
                {link.url}
              </a>
              {link.description && (
                <span className="hidden md:block text-ds-t3 truncate max-w-[200px]">{link.description}</span>
              )}
              {time && <span className="ml-auto sm:ml-0 text-ds-t3 whitespace-nowrap tabular-nums shrink-0">{time}</span>}
              {isAdmin && link.id && (
                /* Visible on touch screens (no hover there); revealed on hover with a mouse.
                   Deleting still asks for confirmation first. */
                <button
                  type="button"
                  onClick={() => onDeleteLink(link.id)}
                  disabled={deletingLinkId === link.id}
                  title="Delete this link"
                  aria-label="Delete this link"
                  className="h-6 w-6 rounded-[6px] grid place-items-center text-ds-t3 hover:text-[color:var(--hx-FB7185)] hover:bg-[rgba(229,72,77,.1)] shrink-0 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/link:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
                >
                  {deletingLinkId === link.id ? (
                    <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </button>
              )}
            </div>
          ))}
          {allLinks.length === 0 && <p className="px-[22px] sm:pl-[76px] py-2 text-[12.5px] text-ds-t3">No links in this report.</p>}
          {allLinks.length > LINK_CAP && (
            <button
              type="button"
              onClick={() => setShowAllLinks((v) => !v)}
              className="mx-[22px] sm:ml-[76px] mt-1 mb-1.5 text-[12px] font-semibold text-ds-gold hover:text-[color:var(--hx-F4D58C)]"
            >
              {showAllLinks ? "Show fewer" : `Show all ${allLinks.length} links`}
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/** Dark breakdown dialog shared by the four drill-downs. */
function BreakdownModal({ title, sub, icon, color, onClose, children }: {
  title: string; sub: string; icon: React.ReactNode; color: string; onClose: () => void; children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-[rgba(2,6,10,.7)]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-sm bg-ds-card border border-ds-line2 rounded-[16px] p-6 shadow-[0_20px_50px_rgba(0,0,0,.6)] overflow-hidden"
      >
        <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px" style={{ background: `linear-gradient(90deg,transparent,${color} 30%,${color} 70%,transparent)` }} />
        <div className="flex items-center justify-between gap-3 mb-5">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="h-9 w-9 rounded-[10px] grid place-items-center shrink-0" style={{ background: rgba(color, 0.12), color }}>{icon}</span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-ds-text truncate">{title}</h2>
              <p className="text-[12px] text-ds-t3">{sub}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="h-7 w-7 rounded-[8px] grid place-items-center text-ds-t3 hover:text-ds-text hover:bg-ds-hover">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ShareList({ rows, total, barColor, empty }: { rows: { platform: string; count: number }[]; total: number; barColor?: string; empty: string }) {
  if (!rows.length) return <p className="text-[13px] text-ds-t3 text-center py-6">{empty}</p>;
  return (
    <div className="space-y-3">
      {rows.map(({ platform, count }) => {
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        const c = barColor ?? platformColor(platform);
        return (
          <div key={platform}>
            <div className="flex items-center justify-between mb-1.5">
              <PlatformBadge platform={platform} />
              <span className="text-[13px] font-semibold text-ds-text tabular-nums">
                {nf.format(count)} <span className="text-[11.5px] font-normal text-ds-t3">({pct}%)</span>
              </span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-[color:var(--hx-132430)] overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: c }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function ReportsPage() {
  usePageTitle("Link Reports");
  // Scroll the <main> container to top on mount (it uses overflow-auto, not window)
  useEffect(() => {
    document.querySelector("main")?.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  // Default to last 30 days so every card/chart starts windowed (not all-time).
  const [startDate, setStartDate] = useState(() => presetStart(30));
  const [endDate, setEndDate] = useState(() => todayISO());
  const [employeeId, setEmployeeId] = useState("");
  const [reportsPage, setReportsPage] = useState(1);
  const [openReport, setOpenReport] = useState(0);
  const [deletingLinkId, setDeletingLinkId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("totalLinks");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [empModal, setEmpModal] = useState<{ name: string; totalLinks: number; platformBreakdown: { platform: string; count: number }[] } | null>(null);
  const [platformModal, setPlatformModal] = useState<{ platform: string; count: number; dailyBreakdown: { date: string; count: number }[] } | null>(null);
  const [todayModal, setTodayModal] = useState<{ name: string; linksToday: number; platformBreakdown: { platform: string; count: number }[] } | null>(null);
  const [teamTodayModal, setTeamTodayModal] = useState<{ totalLinks: number; platformBreakdown: { platform: string; count: number }[] } | null>(null);
  const [topTab, setTopTab] = useState<string>("youtube");

  useEffect(() => {
    const main = document.querySelector("main") as HTMLElement | null;
    if (empModal || platformModal || todayModal || teamTodayModal) {
      document.body.style.overflow = "hidden";
      if (main) main.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
      if (main) main.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
      if (main) main.style.overflow = "";
    };
  }, [empModal, platformModal, todayModal, teamTodayModal]);

  const { user } = useAuth();
  const isAdmin = user?.roles?.some((r) => r === "Admin" || r === "Super Admin") ?? false;

  // Reset to page 1 whenever the filters change — a stale page number from a
  // previous filter could otherwise point past the end of the new result set.
  useEffect(() => {
    setReportsPage(1);
  }, [employeeId, startDate, endDate]);
  // The first report on each page starts open; the rest are collapsed.
  useEffect(() => {
    setOpenReport(0);
  }, [employeeId, startDate, endDate, reportsPage]);

  const { data: summaryData, isLoading: summaryLoading, mutate: mutateSummary } = useReportSummary(startDate, endDate);
  const { data: reportsData, isLoading: reportsLoading, mutate: mutateReports } = useAdminReports({ employeeId, startDate, endDate, page: reportsPage, pageSize: 50 });
  const { data: insightsData, isLoading: insightsLoading } = useInsightsSummary(startDate, endDate, employeeId || undefined);
  const [ytAllTime, setYtAllTime] = useState(false);
  // Top-links panels: one hook per platform (all share the same window toggle).
  const topWindowStart = ytAllTime ? undefined : startDate;
  const topWindowEnd = ytAllTime ? undefined : endDate;
  const { data: topYouTubeData, isLoading: topYouTubeLoading } = useTopLinks("youtube", topWindowStart, topWindowEnd, 20);
  const { data: topInstagramData, isLoading: topInstagramLoading } = useTopLinks("instagram", topWindowStart, topWindowEnd, 20);
  const { data: topFacebookData, isLoading: topFacebookLoading } = useTopLinks("facebook", topWindowStart, topWindowEnd, 20);
  const { data: topSnapchatData, isLoading: topSnapchatLoading } = useTopLinks("snapchat", topWindowStart, topWindowEnd, 20);
  // limit:500 so the reports employee-filter dropdown lists all employees (API caps at 50 otherwise).
  const { data: employeesData } = useEmployees({ limit: 500 });

  const summary = (summaryData as any)?.data;
  const reports = (reportsData as any)?.data ?? [];
  const reportsMeta = (reportsData as any)?.meta;
  const employees = (employeesData as any)?.data ?? [];

  const handleOpenEmpModal = useCallback((emp: any) => {
    setEmpModal({ name: emp.name, totalLinks: emp.totalLinks, platformBreakdown: emp.platformBreakdown ?? [] });
  }, []);

  // Today's breakdown is always today, independent of the date-range filter.
  const handleOpenTodayModal = useCallback((emp: any) => {
    setTodayModal({ name: emp.name, linksToday: emp.linksToday ?? 0, platformBreakdown: emp.todayPlatformBreakdown ?? [] });
  }, []);

  const handleDeleteLink = useCallback(async (linkId: string) => {
    if (!window.confirm("Delete this link? This cannot be undone.")) return;
    setDeletingLinkId(linkId);
    setDeleteError(null);
    try {
      await apiFetch(`/admin/reports/links/${linkId}`, { method: "DELETE" });
      await Promise.all([mutateReports(), mutateSummary()]);
    } catch (err: any) {
      setDeleteError(err.message ?? "Failed to delete link");
    } finally {
      setDeletingLinkId(null);
    }
  }, [mutateReports, mutateSummary]);

  const windowLabel = rangeLabel(startDate, endDate);

  // When an employee is selected the cards scope to that one employee. Their
  // entry in summary.employees is per-employee + windowed; if they have no
  // reports in the window they won't be in that list, so we treat them as a
  // zero-data employee (NOT fall back to team-wide totals).
  const isEmployeeView = !!employeeId;
  const selectedEmployee = isEmployeeView
    ? ((summary?.employees ?? []) as any[]).find((e: any) => e.id === employeeId)
    : null;
  // Name for labels even when the employee has no windowed data.
  const selectedEmployeeName =
    selectedEmployee?.name ??
    (employees as any[]).find((e: any) => e.id === employeeId)?.name ??
    "Employee";

  // Per-platform breakdown that drives the platform cards + the avg-card modal.
  const viewPlatformBreakdown: { platform: string; count: number }[] = (
    isEmployeeView
      ? (selectedEmployee?.platformBreakdown ?? [])
      : (summary?.platformBreakdown ?? [])
  )
    .map((p: any) => ({ platform: p.platform, count: p.count ?? 0 }))
    .filter((p: any) => p.count > 0)
    .sort((a: any, b: any) => b.count - a.count);

  const viewTotalLinks = isEmployeeView ? (selectedEmployee?.totalLinks ?? 0) : (summary?.totalLinks ?? 0);
  const viewTotalReports = isEmployeeView ? (selectedEmployee?.reportCount ?? 0) : (summary?.totalReports ?? 0);

  // Avg links/day across the selected window (window length in days).
  const windowDays = Math.max(
    1,
    Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1,
  );
  const avgLinksInWindow = Math.round((viewTotalLinks / windowDays) * 10) / 10;

  // Engagement insight card — scopes to selected employee or whole team, follows window pill.
  // ⚠️ The card is labelled "YouTube Views", so it MUST use the YOUTUBE-only figures, not the
  // cross-platform totalViews (which folds in FB/IG and overstated YT views 4.6–5.5×). The
  // per-platform breakdown is in insights.byPlatform; pull YouTube's row.
  const insights = (insightsData as any)?.data;
  const ytPlatform = (insights?.byPlatform ?? []).find((p: any) => p?.platform === "youtube");
  const engagementViews = ytPlatform?.totalViews ?? 0;
  const engagementLikes = ytPlatform?.totalLikes ?? 0;
  const engagementComments = ytPlatform?.totalComments ?? 0;
  const hasInsights = !insightsLoading && engagementViews > 0;
  function fmtCompact(n: number | null | undefined): string {
    if (n == null) return "—";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  // Human "updated N ago" from the newest fetchedAt across a panel's rows. Returns null
  // when there are no rows (panel then shows only the cadence-agnostic note).
  function relativeUpdated(rows: Array<{ fetchedAt?: string | Date | null }>): string | null {
    let newest = 0;
    for (const r of rows) {
      if (!r?.fetchedAt) continue;
      const t = new Date(r.fetchedAt).getTime();
      if (!Number.isNaN(t) && t > newest) newest = t;
    }
    if (!newest) return null;
    const mins = Math.max(0, Math.round((Date.now() - newest) / 60000));
    if (mins < 60) return `Updated ${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return `Updated ${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return `Updated ${days}d ago`;
  }

  // Per-ROW staleness marker. WHY per-row and not just the panel-level "Updated N ago"
  // above: the sweep polls each link independently (fresh links every run, the older tail
  // on a rotating cursor), so one panel can mix a 1-hour-old row with a 3-week-old one.
  // A single panel-level max would then read "Updated 1h ago" and actively UNDERSTATE how
  // stale the lower rows are — worse than showing nothing. Returns null for anything
  // fresher than the threshold so healthy rows stay visually clean.
  const STALE_ROW_HOURS = 48;
  function rowStaleness(fetchedAt?: string | Date | null): string | null {
    if (!fetchedAt) return null;
    const t = new Date(fetchedAt).getTime();
    if (Number.isNaN(t)) return null;
    const hrs = (Date.now() - t) / 3_600_000;
    if (hrs < STALE_ROW_HOURS) return null;
    const days = Math.round(hrs / 24);
    return `${days}d old`;
  }

  const ICON = "h-[14px] w-[14px]";
  const statCards: { title: string; value: string | number; color: string; icon: React.ReactNode; sub: string; clickable?: boolean }[] = [
    // First card: team mode shows "Employees Reporting"; single-employee mode shows that
    // employee's current streak instead (more useful than a count of 1).
    isEmployeeView
      ? { title: "Current Streak", value: `${selectedEmployee?.currentStreak ?? 0} 🔥`, color: "var(--hx-F59E66)", icon: <Users className={ICON} />, sub: selectedEmployeeName }
      : { title: "Employees Reporting", value: summary?.employeesReporting ?? 0, color: "var(--hx-6EB2FF)", icon: <Users className={ICON} />, sub: "submitted reports" },
    { title: "Total Reports", value: nf.format(viewTotalReports), color: "var(--hx-B8A3EC)", icon: <FileText className={ICON} />, sub: windowLabel },
    { title: "Total Links", value: nf.format(viewTotalLinks), color: "var(--hx-00D7A0)", icon: <Link2 className={ICON} />, sub: windowLabel },
    { title: "Avg Links/Day", value: avgLinksInWindow, color: "var(--hx-E9BD62)", icon: <TrendingUp className={ICON} />, sub: windowLabel, clickable: true },
    {
      title: "YouTube Views",
      value: insightsLoading ? "—" : hasInsights ? fmtCompact(engagementViews) : "—",
      color: "var(--hx-FB7185)",
      icon: <Eye className={ICON} />,
      sub: hasInsights ? `${fmtCompact(engagementLikes)} likes · ${fmtCompact(engagementComments)} comments` : "No YouTube views in this window",
    },
  ];

  // Top Links. YouTube/Facebook/Snapchat rank by views; Instagram by likes+comments
  // (Snapchat has no likes metric — its likes column always reads "—").
  const PLATFORMS = [
    { key: "youtube", label: "YouTube", showViews: true, data: (topYouTubeData as any)?.data ?? [], loading: topYouTubeLoading, note: "YouTube · views" },
    { key: "instagram", label: "Instagram", showViews: false, data: (topInstagramData as any)?.data ?? [], loading: topInstagramLoading, note: "Instagram · likes + comments" },
    { key: "facebook", label: "Facebook", showViews: true, data: (topFacebookData as any)?.data ?? [], loading: topFacebookLoading, note: "Facebook · likes + comments" },
    {
      key: "snapchat",
      label: "Snapchat",
      showViews: true,
      showLikes: false,
      data: (topSnapchatData as any)?.data ?? [],
      loading: topSnapchatLoading,
      // Null views are LEGITIMATE: Snapchat serves viewCount:"-1" (a sentinel meaning
      // "not published") for many Spotlights — live-verified 10/10 on 2026-07-18.
      // The dash is honest absence, not missing data. Don't "fix" it to 0.
      note: "Snapchat · views where Spotlight publishes them (a dash means Snapchat doesn't expose a public view count for that post — not missing data) · no likes on Spotlight",
    },
  ];
  // A platform with no links in the active window drops out; Facebook always stays
  // (it shows an honest "collected in the background" note when empty).
  const visibleTop = PLATFORMS.filter((p) => p.key === "facebook" || p.loading || p.data.length > 0);
  const activeTop = visibleTop.find((p) => p.key === topTab) ?? visibleTop[0];

  const summaryEmployees: any[] = summary?.employees ?? [];
  const SUMMARY_COLS: { key: SortKey; label: string; align: "left" | "right"; title?: string }[] = [
    { key: "name", label: "Employee", align: "left" },
    { key: "email", label: "Email", align: "left" },
    { key: "reportCount", label: "Reports", align: "right" },
    { key: "totalLinks", label: "Total Links", align: "right" },
    { key: "linksToday", label: "Today", align: "right", title: "Links submitted today — always today, ignores the date filter" },
    { key: "avgLinksPerDay", label: "Avg/Day", align: "right" },
    { key: "currentStreak", label: "Streak", align: "right" },
    { key: "lastSubmittedAt", label: "Last Submitted", align: "left" },
  ];

  return (
    <>
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_300px] min-w-0">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Link Reports</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">Employee daily link submission reports</p>
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <ExportButton startDate={startDate} endDate={endDate} employeeId={employeeId || undefined} variant="ds" />
          <AllLinksCsvButton startDate={startDate} endDate={endDate} employeeId={employeeId || undefined} variant="ds" />
          <Link href="/reports/links" className={BTN}>
            <TrendingUp className="h-[15px] w-[15px] text-[color:var(--hx-6EB2FF)]" />
            Links Analytics
          </Link>
          <Link href="/reports/leaderboard" className="inline-flex items-center gap-2 h-[42px] px-4 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)]">
            <Trophy className="h-[15px] w-[15px]" />
            Leaderboard
          </Link>
        </div>
      </section>

      {/* Filters — above the cards so you choose the window/employee first, then read the numbers */}
      <section className="flex items-end gap-x-5 gap-y-4 flex-wrap px-[22px] py-[18px] rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card">
        <DsRangeFilters startDate={startDate} endDate={endDate} onChange={(s, e) => { setStartDate(s); setEndDate(e); }} />
        <label className="flex flex-col gap-2 min-w-[200px] flex-[0_1_240px]">
          <span className="text-[10.5px] font-semibold tracking-[.12em] uppercase text-ds-t3">Employee</span>
          <select
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="h-10 px-3.5 rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] outline-none cursor-pointer [color-scheme:dark] focus:border-ds-gold"
          >
            <option value="" className="bg-ds-card">All Employees</option>
            {employees.map((emp: any) => (
              <option key={emp.id} value={emp.id} className="bg-ds-card">{emp.name}</option>
            ))}
          </select>
        </label>
        <span className="ml-auto self-center inline-flex items-center h-[30px] px-3 rounded-full bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.3)] text-ds-gold text-[12px] font-semibold whitespace-nowrap">
          {windowLabel}
        </span>
      </section>

      {/* Stat Cards */}
      <section className="grid gap-3 mt-4 [grid-template-columns:repeat(auto-fit,minmax(170px,1fr))]">
        {statCards.map((card) => {
          const isClickable = card.clickable && viewTotalLinks > 0;
          const body = (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-ds-t2 truncate flex items-center gap-1.5">
                  {card.title}
                  {isClickable && <BarChart2 className="h-3 w-3 text-ds-gold shrink-0" />}
                </span>
                <span className="h-[30px] w-[30px] rounded-[9px] grid place-items-center shrink-0" style={{ background: rgba(card.color, 0.13), color: card.color }}>
                  {card.icon}
                </span>
              </div>
              <span className="leading-[1.2] min-w-0">
                <span className="block text-[28px] font-bold tracking-[-.04em] tabular-nums text-ds-text whitespace-nowrap truncate">
                  {summaryLoading ? "—" : card.value}
                </span>
                <span className="block text-[11.5px] text-ds-t3 truncate" title={card.sub}>{card.sub}</span>
              </span>
            </>
          );
          const cls = "flex flex-col gap-3.5 px-5 py-[18px] rounded-[16px] bg-ds-card border border-[color:var(--hx-2A4658)] min-w-0 text-left";
          return isClickable ? (
            <button
              key={card.title}
              type="button"
              onClick={() => setTeamTodayModal({ totalLinks: viewTotalLinks, platformBreakdown: viewPlatformBreakdown })}
              className={`${cls} hover:border-[rgba(233,189,98,.5)] transition-colors`}
            >
              {body}
            </button>
          ) : (
            <div key={card.title} className={cls}>{body}</div>
          );
        })}
      </section>

      {/* Platform Breakdown Cards */}
      {!summaryLoading && viewPlatformBreakdown.length > 0 && (
        <section className="grid gap-3 mt-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))]">
          {viewPlatformBreakdown.map(({ platform, count }) => {
            const c = platformColor(platform);
            const share = viewTotalLinks > 0 ? (count / viewTotalLinks) * 100 : 0;
            // Daily drill-down: per-employee when one is selected, else team-wide. Both carry dailyBreakdown.
            const sourceBreakdown = isEmployeeView
              ? (selectedEmployee?.platformBreakdown ?? [])
              : (summary?.platformBreakdown ?? []);
            const dailyBreakdown = (sourceBreakdown as any[]).find((p: any) => p.platform === platform)?.dailyBreakdown ?? [];
            return (
              <button
                key={platform}
                type="button"
                onClick={() => setPlatformModal({ platform, count, dailyBreakdown })}
                title="View the daily breakdown"
                className="relative flex flex-col gap-3 px-5 py-[18px] rounded-[16px] bg-ds-card border border-ds-line min-w-0 overflow-hidden text-left hover:border-[color:var(--hx-2A4658)] transition-colors"
              >
                <span aria-hidden="true" className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: c }} />
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[13px] font-semibold text-ds-text min-w-0">
                    <i className="h-2 w-2 rounded-full shrink-0" style={{ background: c }} />
                    <span className="truncate">{platformName(platform)}</span>
                  </span>
                  <span className="text-[12px] font-semibold" style={{ color: c }}>{share < 1 && share > 0 ? share.toFixed(2) : share.toFixed(1)}%</span>
                </div>
                <span className="leading-[1.2]">
                  <span className="block text-[26px] font-bold tracking-[-.04em] tabular-nums text-ds-text">{nf.format(count)}</span>
                  <span className="text-[11.5px] text-ds-t3">links · {windowLabel.toLowerCase()}</span>
                </span>
                <span className="h-[5px] rounded-[3px] bg-[color:var(--hx-132430)] overflow-hidden">
                  <span className="block h-full rounded-[3px]" style={{ width: `${Math.max(share, 0.8)}%`, background: c }} />
                </span>
              </button>
            );
          })}
        </section>
      )}

      {/* True Links — dedupe-aware stats + per-employee shared/unique leaderboard.
          Own endpoint + hook (server-cached), so it loads independently and can
          never slow or block the summary cards above. Honors the same window pills
          and employee dropdown as everything else on the page. */}
      <div className="mt-4">
        <TrueLinksPanel startDate={startDate} endDate={endDate} employeeId={employeeId || undefined} windowLabel={windowLabel} />
      </div>

      {/* Top Links — one card, one tab per platform (same endpoint per platform as before). */}
      {activeTop && (
        <section className={`${CARD} mt-4`}>
          <div className="flex items-center justify-between gap-x-4 gap-y-3 min-h-[64px] px-6 py-3 border-b border-ds-line flex-wrap">
            <span className="flex items-center gap-3.5 flex-wrap min-w-0">
              <span className="text-[15px] font-semibold tracking-[-.01em] text-ds-text whitespace-nowrap">Top Links</span>
              <span className="flex gap-[3px] p-1 rounded-full bg-ds-inset border border-ds-line2 max-w-full overflow-x-auto" role="tablist" aria-label="Platform">
                {visibleTop.map((p) => {
                  const on = p.key === activeTop.key;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => setTopTab(p.key)}
                      className={`inline-flex items-center gap-[7px] h-[30px] px-[13px] rounded-full text-[12.5px] font-semibold whitespace-nowrap shrink-0 ${on ? "bg-[color:var(--hx-132430)] text-ds-text" : "text-ds-t2 hover:text-ds-text"}`}
                    >
                      <i className="h-[7px] w-[7px] rounded-full" style={{ background: platformColor(p.key) }} />
                      {p.label}
                    </button>
                  );
                })}
              </span>
              <span className="flex gap-[3px] p-[3px] rounded-full border border-ds-line2 shrink-0">
                {[{ v: false, label: windowLabel }, { v: true, label: "All time" }].map((m) => (
                  <button
                    key={String(m.v)}
                    type="button"
                    aria-pressed={ytAllTime === m.v}
                    onClick={() => setYtAllTime(m.v)}
                    className={`h-[26px] px-[11px] rounded-full text-[11.5px] font-semibold whitespace-nowrap ${ytAllTime === m.v ? "bg-ds-gold text-[color:var(--hx-060D14)]" : "text-ds-t2 hover:text-ds-text"}`}
                  >
                    {m.label}
                  </button>
                ))}
              </span>
            </span>
            {/* Wrapping allowed on purpose: the Snapchat note is long, and a non-shrinking
                text box can never wrap and would run off the card. */}
            <span className="min-w-0 max-w-[520px] text-[12px] leading-[1.45] text-ds-t3 sm:text-right">
              {activeTop.note}
              {(() => {
                const rel = relativeUpdated(activeTop.data);
                return rel ? ` · ${rel}` : "";
              })()}
            </span>
          </div>
          {activeTop.loading ? (
            <div className="px-6 py-6 text-[12.5px] text-ds-t3">Loading…</div>
          ) : activeTop.key === "facebook" && activeTop.data.length === 0 ? (
            /* Facebook empty state — honest: metrics are collected gradually by the
               insights job, so this fills in over time rather than being unavailable. */
            <div className="px-6 py-5 text-[12.5px] text-ds-t2 leading-relaxed max-w-prose">
              Facebook views, reactions and comments are collected in the background and
              refresh periodically. Recently submitted reels appear here once the next
              insights run picks them up &mdash; check back shortly.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[720px]">
                <div className={`grid gap-x-3.5 items-center h-[46px] px-6 ${HEAD_ROW} [grid-template-columns:28px_minmax(0,1fr)_minmax(0,170px)_84px_84px_92px]`}>
                  <span>#</span><span>Link</span><span>Employee</span>
                  <span className="text-right">Views</span><span className="text-right">Likes</span><span className="text-right">Comments</span>
                </div>
                {activeTop.data.map((link: any, i: number) => {
                  const stale = rowStaleness(link.fetchedAt);
                  const noLikes = (activeTop as any).showLikes === false;
                  return (
                    <div
                      key={`${link.linkId ?? link.url}-${i}`}
                      className="grid gap-x-3.5 items-center min-h-[54px] py-2 px-6 border-b border-[color:var(--hx-132430)] last:border-b-0 text-[13px] tabular-nums hover:bg-[color:var(--hx-0A1620)] [grid-template-columns:28px_minmax(0,1fr)_minmax(0,170px)_84px_84px_92px]"
                    >
                      <span className="text-[12px] font-bold text-ds-t3">{i + 1}</span>
                      {/* The URL and the staleness chip share ONE grid cell, so the column
                          count — and the header alignment — never changes. */}
                      <span className="flex items-center gap-2 min-w-0">
                        <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url} className="truncate min-w-0 text-ds-t5 hover:text-ds-gold">
                          {link.url}
                        </a>
                        {stale && (
                          <span
                            className="shrink-0 inline-flex items-center h-[22px] px-2 rounded-full bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.3)] text-ds-gold text-[10.5px] font-semibold whitespace-nowrap"
                            title={`Metrics last refreshed ${stale.replace(" old", "")} ago. This link is waiting its turn in the background refresh queue.`}
                          >
                            {stale}
                          </span>
                        )}
                      </span>
                      <span className="text-ds-t2 truncate" title={link.employeeName}>{link.employeeName}</span>
                      <span className={`flex items-center justify-end gap-[5px] font-semibold ${activeTop.showViews && link.views != null ? "text-[color:var(--hx-FDA4AF)]" : "text-[color:var(--hx-4A6275)]"}`}>
                        <Eye className="h-3 w-3 shrink-0" />
                        {activeTop.showViews ? fmtCompact(link.views) : "—"}
                      </span>
                      <span className={`flex items-center justify-end gap-[5px] font-semibold ${noLikes || link.likes == null ? "text-[color:var(--hx-4A6275)]" : "text-[color:var(--hx-F9A8D4)]"}`}>
                        <Heart className="h-3 w-3 shrink-0" />
                        {noLikes ? "—" : fmtCompact(link.likes)}
                      </span>
                      <span className="flex items-center justify-end gap-[5px] font-semibold text-ds-t2">
                        <MessageCircle className="h-3 w-3 shrink-0" />
                        {fmtCompact(link.comments)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Employee Summary */}
      {!employeeId && (
        <section className={`${CARD} mt-4`}>
          <div className="flex items-center justify-between gap-3 min-h-[64px] px-6 py-3 border-b border-ds-line flex-wrap">
            <span className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-.01em] text-ds-text whitespace-nowrap">
              <TrendingUp className="h-[15px] w-[15px] text-ds-gold" />
              Employee Summary
            </span>
            {!summaryLoading && summaryEmployees.length > 0 && (
              <span className="text-[12px] text-ds-t3">
                {summaryEmployees.length} employee{summaryEmployees.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          {summaryLoading ? (
            <div className="px-6 py-8 text-[13px] text-ds-t3 text-center">Loading summary…</div>
          ) : summaryEmployees.length === 0 ? (
            <div className="px-6 py-10 text-[13px] text-ds-t3 text-center">
              <FileText className="h-[30px] w-[30px] mx-auto mb-2 opacity-50" strokeWidth={1.5} />
              No report data found.
            </div>
          ) : (
            <div className="overflow-auto max-h-[560px]">
              <div className="min-w-[1080px]">
                <div className={`${SUMMARY_GRID} h-[46px] px-6 ${HEAD_ROW} sticky top-0 z-10`}>
                  {SUMMARY_COLS.map(({ key, label, align, title }) => (
                    <button
                      key={key}
                      type="button"
                      title={title ?? `Sort by ${label.toLowerCase()}`}
                      onClick={() => {
                        if (sortKey === key) {
                          setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                        } else {
                          setSortKey(key);
                          setSortDir(key === "name" || key === "email" ? "asc" : "desc");
                        }
                      }}
                      className={`flex items-center gap-[5px] min-w-0 uppercase tracking-[.08em] ${align === "right" ? "justify-end" : "justify-start"} ${sortKey === key ? "text-ds-text" : "hover:text-ds-t5"}`}
                    >
                      {key === "linksToday" && <span className="h-1.5 w-1.5 rounded-full bg-ds-teal shrink-0" />}
                      {label}
                      <SortIcon col={key} sortKey={sortKey} sortDir={sortDir} />
                    </button>
                  ))}
                  <span />
                </div>
                {sortEmployees(summaryEmployees, sortKey, sortDir).map((emp: any) => (
                  <EmployeeRow key={emp.id} emp={emp} onOpenEmpModal={handleOpenEmpModal} onOpenTodayModal={handleOpenTodayModal} />
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Delete error banner */}
      {deleteError && (
        <div className="mt-4 px-4 py-3 rounded-[10px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] flex items-center gap-2 text-[13px] text-[color:var(--hx-FB7185)]">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {deleteError}
          <button type="button" onClick={() => setDeleteError(null)} aria-label="Dismiss" className="ml-auto hover:text-ds-text">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Recent Reports */}
      <section className="mt-7">
        <div className="flex items-center justify-between gap-3 mb-3">
          <span className="flex items-center gap-2.5 text-[20px] font-bold tracking-[-.02em] text-ds-text">
            <FileText className="h-[15px] w-[15px] text-ds-gold" />
            {employeeId ? "Filtered Reports" : "Recent Reports"}
          </span>
          {!reportsLoading && reports.length > 0 && (
            <span className="text-[12px] text-ds-t3">
              {nf.format(reportsMeta?.total ?? reports.length)} report{(reportsMeta?.total ?? reports.length) !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        {reportsLoading ? (
          <div className="flex flex-col gap-2.5" aria-hidden="true">
            {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-[72px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />)}
          </div>
        ) : reports.length === 0 ? (
          <div className="py-12 px-5 rounded-[16px] border border-dashed border-ds-line2 text-center text-[13px] text-ds-t3">
            <FileText className="h-[30px] w-[30px] mx-auto mb-2 opacity-50" strokeWidth={1.5} />
            No reports found.
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-2.5">
              {reports.map((report: any, i: number) => (
                <ReportCard
                  key={report.id}
                  report={report}
                  isAdmin={isAdmin}
                  open={openReport === i}
                  onToggle={() => setOpenReport((o) => (o === i ? -1 : i))}
                  deletingLinkId={deletingLinkId}
                  onDeleteLink={handleDeleteLink}
                />
              ))}
            </div>
            {(reportsPage > 1 || reportsMeta?.hasMore) && (
              <div className="flex items-center justify-center gap-3 pt-5">
                <button
                  type="button"
                  onClick={() => setReportsPage((p) => Math.max(1, p - 1))}
                  disabled={reportsPage <= 1 || reportsLoading}
                  className="h-10 px-5 rounded-full border border-ds-line2 bg-ds-inset text-ds-t5 text-[13px] font-semibold hover:text-ds-text disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="text-[12px] text-ds-t3">Page {reportsPage}</span>
                <button
                  type="button"
                  onClick={() => setReportsPage((p) => p + 1)}
                  disabled={!reportsMeta?.hasMore || reportsLoading}
                  className="h-10 px-5 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13px] font-bold hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {reportsLoading ? "Loading…" : "Next"}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>

    {/* Platform daily breakdown modal */}
    {platformModal && (
      <BreakdownModal
        title={platformName(platformModal.platform)}
        sub={`${nf.format(platformModal.count)} total links`}
        color={platformColor(platformModal.platform)}
        icon={<Link2 className="h-4 w-4" />}
        onClose={() => setPlatformModal(null)}
      >
        {!platformModal.dailyBreakdown.length ? (
          <p className="text-[13px] text-ds-t3 text-center py-6">No data available.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto pr-1 space-y-2">
            {platformModal.dailyBreakdown.map(({ date, count }) => {
              const pct = platformModal.count > 0 ? Math.round((count / platformModal.count) * 100) : 0;
              const label = new Date(date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
              return (
                <div key={date} className="flex items-center gap-3">
                  <span className="text-[12px] text-ds-t2 w-24 shrink-0">{label}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-[color:var(--hx-132430)] overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: platformColor(platformModal.platform) }} />
                  </div>
                  <span className="text-[13px] font-semibold text-ds-text w-10 text-right tabular-nums">{count}</span>
                </div>
              );
            })}
          </div>
        )}
      </BreakdownModal>
    )}

    {/* Per-employee platform breakdown modal */}
    {empModal && (
      <BreakdownModal
        title={empModal.name}
        sub={`${nf.format(empModal.totalLinks)} links · by platform`}
        color="var(--hx-00D7A0)"
        icon={<Link2 className="h-4 w-4" />}
        onClose={() => setEmpModal(null)}
      >
        <ShareList rows={empModal.platformBreakdown} total={empModal.totalLinks} empty="No links submitted yet." />
      </BreakdownModal>
    )}

    {/* Per-employee TODAY platform breakdown modal (filter-independent) */}
    {todayModal && (
      <BreakdownModal
        title={todayModal.name}
        sub={`${nf.format(todayModal.linksToday)} links today · by platform`}
        color="var(--hx-6EB2FF)"
        icon={<BarChart2 className="h-4 w-4" />}
        onClose={() => setTodayModal(null)}
      >
        <ShareList rows={todayModal.platformBreakdown} total={todayModal.linksToday} empty="No links submitted today." />
      </BreakdownModal>
    )}

    {/* Team-wide window platform breakdown modal */}
    {teamTodayModal && (
      <BreakdownModal
        title={`${isEmployeeView ? selectedEmployeeName : "Team"} · ${windowLabel}`}
        sub={`${nf.format(teamTodayModal.totalLinks)} links · ${isEmployeeView ? "by platform" : "across team · by platform"}`}
        color="var(--hx-E9BD62)"
        icon={<Calendar className="h-4 w-4" />}
        onClose={() => setTeamTodayModal(null)}
      >
        <ShareList rows={teamTodayModal.platformBreakdown} total={teamTodayModal.totalLinks} empty="No links submitted in this window." />
      </BreakdownModal>
    )}
    </>
  );
}
