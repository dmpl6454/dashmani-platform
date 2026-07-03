"use client";
import { memo, useCallback, useState, useEffect } from "react";
import Link from "next/link";
import { Users, FileText, Link2, Calendar, Filter, X, TrendingUp, Trophy, Trash2, AlertTriangle, BarChart2, ArrowUpDown, ArrowUp, ArrowDown, Eye, Heart, MessageCircle, Youtube, Instagram, Facebook } from "lucide-react";
import { useTopLinks } from "@/lib/hooks/use-reports";
import { useAdminReports, useReportSummary, useInsightsSummary } from "@/lib/hooks/use-reports";
import { useEmployees } from "@/lib/hooks/use-employees";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { UserAvatar } from "@/components/user-avatar";
import { RangePills, presetStart, todayISO, rangeLabel } from "./_range";
import { ExportButton } from "./_export";

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-700",
  twitter: "bg-sky-100 text-sky-700",
  linkedin: "bg-[#FFF3C4] text-[#1A1A1A]",
  facebook: "bg-[#FFF3C4] text-[#1A1A1A]",
  youtube: "bg-red-100 text-red-700",
  tiktok: "bg-[#F0E4C4] text-[#1A1A1A]",
  snapchat: "bg-yellow-100 text-yellow-700",
};

const PLATFORM_CARD_STYLES: Record<string, { bg: string; labelColor: string; labelBg: string; bar: string; border: string }> = {
  instagram: { bg: "from-pink-50 to-rose-50",     labelColor: "text-pink-600",   labelBg: "bg-pink-100",    bar: "bg-pink-400",   border: "border-pink-100"   },
  linkedin:  { bg: "from-blue-50 to-indigo-50",   labelColor: "text-blue-700",   labelBg: "bg-blue-100",    bar: "bg-blue-500",   border: "border-blue-100"   },
  youtube:   { bg: "from-red-50 to-orange-50",    labelColor: "text-red-600",    labelBg: "bg-red-100",     bar: "bg-red-400",    border: "border-red-100"    },
  facebook:  { bg: "from-sky-50 to-blue-50",      labelColor: "text-sky-700",    labelBg: "bg-sky-100",     bar: "bg-sky-400",    border: "border-sky-100"    },
  twitter:   { bg: "from-cyan-50 to-sky-50",      labelColor: "text-cyan-700",   labelBg: "bg-cyan-100",    bar: "bg-cyan-400",   border: "border-cyan-100"   },
  tiktok:    { bg: "from-slate-50 to-zinc-50",    labelColor: "text-slate-700",  labelBg: "bg-slate-100",   bar: "bg-slate-400",  border: "border-slate-100"  },
  snapchat:  { bg: "from-yellow-50 to-amber-50",  labelColor: "text-yellow-600", labelBg: "bg-yellow-100",  bar: "bg-yellow-400", border: "border-yellow-100" },
};

function platformCardStyle(platform: string) {
  return PLATFORM_CARD_STYLES[platform?.toLowerCase()] ?? {
    bg: "from-[#FFFBF0] to-[#FFF8E1]", labelColor: "text-amber-700", labelBg: "bg-amber-100", bar: "bg-amber-400", border: "border-[#F0EAD8]",
  };
}

function platformBadgeClass(platform: string) {
  return PLATFORM_COLORS[platform?.toLowerCase()] ?? "bg-[#FFF3C4] text-[#1A1A1A]";
}


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
  if (col !== sortKey) return <ArrowUpDown className="h-3 w-3 opacity-30 ml-0.5 inline-block" />;
  return sortDir === "asc"
    ? <ArrowUp className="h-3 w-3 ml-0.5 inline-block text-[#1A1A1A]" />
    : <ArrowDown className="h-3 w-3 ml-0.5 inline-block text-[#1A1A1A]" />;
}

interface EmployeeRowProps {
  emp: any;
  onOpenEmpModal: (emp: any) => void;
  onOpenTodayModal: (emp: any) => void;
}

const EmployeeRow = memo(function EmployeeRow({ emp, onOpenEmpModal, onOpenTodayModal }: EmployeeRowProps) {
  return (
    <tr className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors group">
      <td className="py-3 pr-4">
        <div className="flex items-center gap-3">
          <UserAvatar
            name={emp.name}
            imageUrl={emp.profileImageUrl}
            size={8}
            className="ring-2 ring-white shadow-sm"
            textClassName="text-xs"
          />
          <span className="font-medium text-[#1A1A1A] group-hover:text-[#F5D547] transition-colors">{emp.name}</span>
        </div>
      </td>
      <td className="py-3 pr-4 text-[#7A7A7A]">{emp.email}</td>
      <td className="py-3 pr-4 text-right">
        <span className="inline-flex items-center justify-center min-w-[28px] h-6 rounded-full bg-purple-50 text-purple-700 text-xs font-semibold px-2">
          {emp.reportCount}
        </span>
      </td>
      <td className="py-3 pr-4 text-right">
        <button
          onClick={() => onOpenEmpModal(emp)}
          title="View per-platform breakdown for the selected window"
          className="inline-flex items-center gap-1 min-w-[28px] h-6 rounded-full bg-emerald-50 text-emerald-700 text-xs font-semibold px-2 hover:bg-emerald-100 transition-colors cursor-pointer border border-transparent hover:border-emerald-300"
        >
          {emp.totalLinks}
          <BarChart2 className="h-3 w-3 opacity-60" />
        </button>
      </td>
      <td className="py-3 pr-4 text-right">
        <button
          onClick={() => onOpenTodayModal(emp)}
          title="View today's per-platform breakdown (always today, ignores the date filter)"
          className={`inline-flex items-center gap-1 min-w-[28px] h-6 rounded-full text-xs font-semibold px-2 transition-colors cursor-pointer border ${
            (emp.linksToday ?? 0) > 0
              ? "bg-blue-50 text-blue-700 border-transparent hover:bg-blue-100 hover:border-blue-300"
              : "bg-transparent text-[#B0B0B0] border-transparent hover:bg-[#F5F5F5] hover:border-[#E8E0D0]"
          }`}
        >
          {(emp.linksToday ?? 0) > 0 ? emp.linksToday : "—"}
          <BarChart2 className="h-3 w-3 opacity-60" />
        </button>
      </td>
      <td className="py-3 pr-4 text-right">
        <span className="text-xs text-[#7A7A7A]">{emp.avgLinksPerDay ?? "—"}</span>
      </td>
      <td className="py-3 pr-4 text-right">
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-orange-600">
          {emp.currentStreak ?? 0} 🔥
        </span>
      </td>
      <td className="py-3 pr-4 text-xs text-[#7A7A7A]">
        {emp.lastSubmittedAt
          ? new Date(emp.lastSubmittedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
          : "—"}
      </td>
      <td className="py-3">
        <Link
          href={`/reports/${emp.id}`}
          className="text-[#1A1A1A] hover:text-[#F5D547] text-xs font-medium transition-colors"
        >
          View Details
        </Link>
      </td>
    </tr>
  );
});

interface ReportCardProps {
  report: any;
  isAdmin: boolean;
  deletingLinkId: string | null;
  onDeleteLink: (linkId: string) => void;
}

const ReportCard = memo(function ReportCard({ report, isAdmin, deletingLinkId, onDeleteLink }: ReportCardProps) {
  return (
    <div
      className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-shadow duration-200 hover:shadow-[0_8px_32px_rgba(0,0,0,0.07)]"
      style={{ contentVisibility: "auto", containIntrinsicSize: "300px" } as any}
    >
      <div className="p-5">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <UserAvatar
              name={report.employee?.name}
              imageUrl={report.employee?.profileImageUrl}
              size={10}
              className="ring-2 ring-white shadow-sm"
            />
            <div>
              <p className="font-semibold text-[#1A1A1A]">{report.employee?.name ?? "Unknown"}</p>
              <p className="text-xs text-[#7A7A7A]">{report.employee?.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full px-3 py-1 text-xs font-medium bg-[#FFF8E1] text-[#1A1A1A] border border-[#F0EAD8]">
              {new Date(report.date ?? report.createdAt).toLocaleDateString()}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium bg-emerald-50 text-emerald-700">
              <Link2 className="h-3 w-3" />
              {report.links?.length ?? 0}
            </span>
          </div>
        </div>

        {report.notes && (
          <p className="text-sm text-[#7A7A7A] mb-4 italic pl-[52px]">{report.notes}</p>
        )}

        <div className="space-y-1 pl-[52px]">
          {(report.links ?? []).map((link: any, i: number) => (
            <div key={link.id ?? i} className="flex items-center gap-2 group/link py-1 px-2 rounded-lg hover:bg-[#FEFCF7] transition-colors">
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide border ${platformBadgeClass(link.platform)}`}>
                {link.platform ?? "—"}
              </span>
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 min-w-0 flex items-center gap-2 group/url"
                title={link.url}
              >
                {link.accountName && (
                  <span className="text-xs font-medium text-[#1A1A1A] shrink-0 group-hover/url:text-[#F5D547] transition-colors">{link.accountName}</span>
                )}
                <span className="text-[10px] text-[#B0B0B0] truncate group-hover/url:underline">{link.url}</span>
              </a>
              {link.description && (
                <span className="text-xs text-[#B0B0B0] truncate max-w-[200px] hidden md:block">{link.description}</span>
              )}
              {report.submittedAt && (
                <span className="text-[10px] text-[#B0B0B0] shrink-0 tabular-nums whitespace-nowrap">
                  {new Date(report.submittedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              {isAdmin && link.id && (
                <button
                  onClick={() => onDeleteLink(link.id)}
                  disabled={deletingLinkId === link.id}
                  title="Delete this link"
                  className="h-6 w-6 rounded-lg flex items-center justify-center text-[#B0B0B0] hover:text-red-500 hover:bg-red-50 transition-colors opacity-0 group-hover/link:opacity-100 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
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
        </div>
      </div>
    </div>
  );
});

export default function ReportsPage() {
  // Scroll the <main> container to top on mount (it uses overflow-auto, not window)
  useEffect(() => {
    document.querySelector("main")?.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, []);

  // Default to last 30 days so every card/chart starts windowed (not all-time).
  const [startDate, setStartDate] = useState(() => presetStart(30));
  const [endDate, setEndDate] = useState(() => todayISO());
  const [employeeId, setEmployeeId] = useState("");
  const [deletingLinkId, setDeletingLinkId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("totalLinks");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [empModal, setEmpModal] = useState<{ name: string; totalLinks: number; platformBreakdown: { platform: string; count: number }[] } | null>(null);
  const [platformModal, setPlatformModal] = useState<{ platform: string; count: number; dailyBreakdown: { date: string; count: number }[] } | null>(null);
  const [todayModal, setTodayModal] = useState<{ name: string; linksToday: number; platformBreakdown: { platform: string; count: number }[] } | null>(null);
  const [teamTodayModal, setTeamTodayModal] = useState<{ totalLinks: number; platformBreakdown: { platform: string; count: number }[] } | null>(null);

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

  const { data: summaryData, isLoading: summaryLoading, mutate: mutateSummary } = useReportSummary(startDate, endDate);
  const { data: reportsData, isLoading: reportsLoading, mutate: mutateReports } = useAdminReports({ employeeId, startDate, endDate });
  const { data: insightsData, isLoading: insightsLoading } = useInsightsSummary(startDate, endDate, employeeId || undefined);
  const [ytAllTime, setYtAllTime] = useState(false);
  // Top-links panels: one hook per platform (all share the same window toggle).
  const topWindowStart = ytAllTime ? undefined : startDate;
  const topWindowEnd = ytAllTime ? undefined : endDate;
  const { data: topYouTubeData, isLoading: topYouTubeLoading } = useTopLinks("youtube", topWindowStart, topWindowEnd, 20);
  const { data: topInstagramData, isLoading: topInstagramLoading } = useTopLinks("instagram", topWindowStart, topWindowEnd, 20);
  const { data: topFacebookData, isLoading: topFacebookLoading } = useTopLinks("facebook", topWindowStart, topWindowEnd, 20);
  // limit:500 so the reports employee-filter dropdown lists all employees (API caps at 50 otherwise).
  const { data: employeesData } = useEmployees({ limit: 500 });

  const summary = (summaryData as any)?.data;
  const reports = (reportsData as any)?.data ?? [];
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

  // First card: team mode shows "Employees Reporting"; single-employee mode shows that
  // employee's current streak instead (more useful than a count of 1).
  const firstCard = isEmployeeView
    ? { title: "Current Streak", value: `${selectedEmployee?.currentStreak ?? 0} 🔥`, icon: Users, iconColor: "text-orange-600", bgColor: "bg-orange-50 shadow-[0_2px_8px_rgba(234,88,12,0.12)]", sub: selectedEmployeeName }
    : { title: "Employees Reporting", value: summary?.employeesReporting ?? 0, icon: Users, iconColor: "text-blue-600", bgColor: "bg-blue-50 shadow-[0_2px_8px_rgba(59,130,246,0.12)]", sub: "submitted reports" };

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
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
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

  const statCards = [
    firstCard,
    { title: "Total Reports", value: viewTotalReports, icon: FileText, iconColor: "text-purple-600", bgColor: "bg-purple-50 shadow-[0_2px_8px_rgba(147,51,234,0.12)]", sub: windowLabel },
    { title: "Total Links", value: viewTotalLinks, icon: Link2, iconColor: "text-emerald-600", bgColor: "bg-emerald-50 shadow-[0_2px_8px_rgba(16,185,129,0.12)]", sub: windowLabel },
    { title: "Avg Links/Day", value: avgLinksInWindow, icon: TrendingUp, iconColor: "text-amber-600", bgColor: "bg-amber-50 shadow-[0_2px_8px_rgba(245,158,11,0.12)]", sub: windowLabel, clickable: true },
    {
      title: "YouTube Views",
      value: insightsLoading ? "—" : hasInsights ? fmtCompact(engagementViews) : "—",
      icon: Eye,
      iconColor: "text-rose-600",
      bgColor: "bg-rose-50 shadow-[0_2px_8px_rgba(244,63,94,0.12)]",
      sub: hasInsights ? `${fmtCompact(engagementLikes)} likes · ${fmtCompact(engagementComments)} comments` : "No YouTube views in this window",
    },
  ];

  return (
    <>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Link Reports</h1>
          <p className="text-sm text-[#7A7A7A] mt-1">Employee daily link submission reports</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportButton startDate={startDate} endDate={endDate} variant="light" />
          <Link
            href="/reports/links"
            className="inline-flex items-center gap-2 bg-white border border-[#E8E0D0] text-[#1A1A1A] rounded-full px-4 py-2 text-sm font-medium hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)] transition-shadow"
          >
            <TrendingUp className="h-4 w-4 text-emerald-600" />
            Links Analytics
          </Link>
          <Link
            href="/reports/leaderboard"
            className="inline-flex items-center gap-2 bg-[#1A1A1A] text-white rounded-full px-5 py-2.5 text-sm font-medium shadow-[0_4px_16px_rgba(0,0,0,0.18)] hover:shadow-[0_6px_24px_rgba(0,0,0,0.22)] transition-shadow"
          >
            <Trophy className="h-4 w-4" />
            Leaderboard
          </Link>
        </div>
      </div>

      {/* Filters — above the cards so you choose the window/employee first, then read the numbers */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
        <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-[#FFF8E1] flex items-center justify-center">
              <Filter className="h-4 w-4 text-[#B0B0B0]" />
            </div>
            <h3 className="font-serif text-[#1A1A1A] font-medium">Filters</h3>
          </div>
          <span className="text-xs font-medium text-[#7A7A7A] bg-[#FFF8E1] px-3 py-1 rounded-full border border-[#F0EAD8]">
            {windowLabel}
          </span>
        </div>
        <div className="p-6 space-y-4">
          {/* Time-period pills + custom range */}
          <RangePills
            startDate={startDate}
            endDate={endDate}
            onChange={(s, e) => { setStartDate(s); setEndDate(e); }}
          />
          {/* Employee selector */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-[#7A7A7A] flex items-center gap-1">
              <Users className="h-3 w-3" /> Employee
            </label>
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="h-10 rounded-xl border border-[#E8E0D0] bg-[#FEFCF8] px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] w-52"
            >
              <option value="">All Employees</option>
              {employees.map((emp: any) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        {statCards.map((card: any) => {
          const Icon = card.icon;
          const isClickable = card.clickable && viewTotalLinks > 0;
          const onClickHandler = isClickable
            ? () => setTeamTodayModal({ totalLinks: viewTotalLinks, platformBreakdown: viewPlatformBreakdown })
            : undefined;
          return (
            <div
              key={card.title}
              onClick={onClickHandler}
              className={`bg-white rounded-2xl p-5 border border-[#E8E0D0] transition-shadow duration-200 hover:shadow-[0_8px_32px_rgba(0,0,0,0.06)] ${isClickable ? "cursor-pointer hover:border-amber-300" : ""}`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-[#7A7A7A] font-medium flex items-center gap-1.5">
                  {card.title}
                  {isClickable && <BarChart2 className="h-3 w-3 text-amber-500" />}
                </span>
                <div className={`h-10 w-10 rounded-xl ${card.bgColor} flex items-center justify-center`}>
                  <Icon className={`h-5 w-5 ${card.iconColor}`} />
                </div>
              </div>
              <p className={`font-light font-num text-[#1A1A1A] leading-tight ${typeof card.value === "number" ? "text-[40px]" : "text-xl"}`}>
                {summaryLoading ? "\u2014" : card.value}
              </p>
              <p className="text-xs text-[#B0B0B0] mt-1">{card.sub}</p>
            </div>
          );
        })}
      </div>

      {/* Platform Breakdown Cards */}
      {!summaryLoading && viewPlatformBreakdown.length > 0 && (
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${viewPlatformBreakdown.length}, minmax(0, 1fr))` }}>
          {viewPlatformBreakdown
            .map(({ platform, count }) => {
              const style = platformCardStyle(platform);
              const pct = viewTotalLinks > 0 ? Math.round((count / viewTotalLinks) * 100) : 0;
              // Daily drill-down: per-employee when one is selected, else team-wide. Both carry dailyBreakdown.
              const sourceBreakdown = isEmployeeView
                ? (selectedEmployee?.platformBreakdown ?? [])
                : (summary?.platformBreakdown ?? []);
              const dailyBreakdown = (sourceBreakdown as any[]).find((p: any) => p.platform === platform)?.dailyBreakdown ?? [];
              return (
                <div
                  key={platform}
                  onClick={() => setPlatformModal({ platform, count, dailyBreakdown })}
                  className={`bg-gradient-to-br ${style.bg} rounded-2xl p-5 border ${style.border} shadow-[0_2px_12px_rgba(0,0,0,0.05)] flex flex-col gap-3 hover:shadow-[0_6px_20px_rgba(0,0,0,0.08)] transition-shadow duration-150 cursor-pointer`}
                >
                  {/* Header — name left, colored icon right (same pattern as stat cards) */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[#7A7A7A] capitalize">{platform}</span>
                    <div className={`h-10 w-10 rounded-xl ${style.labelBg} flex items-center justify-center`}>
                      <Link2 className={`h-5 w-5 ${style.labelColor}`} />
                    </div>
                  </div>

                  {/* Count — left aligned like stat cards */}
                  <p className="font-num font-light text-[40px] text-[#1A1A1A] leading-tight">{count}</p>
                  <p className="text-xs text-[#B0B0B0] -mt-2">links · {windowLabel.toLowerCase()}</p>

                  {/* Progress bar */}
                  <div className="h-1 w-full rounded-full bg-white/70">
                    <div
                      className={`h-1 rounded-full ${style.bar} transition-all duration-700`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* Top Links panels — YouTube, Instagram, Facebook. One shared window toggle
          on the first rendered panel; each panel reuses the same /admin/reports/top-links
          endpoint. YouTube ranks by views; Instagram/Facebook by likes+comments.
          A platform with no links in the active window simply hides its panel. */}
      {(() => {
        const PLATFORMS = [
          {
            key: "youtube" as const,
            label: "Top YouTube Links",
            Icon: Youtube,
            iconBg: "bg-red-50",
            iconColor: "text-red-500",
            metric: "views" as const, // primary sort metric (YouTube sorts by views, others by engagement)
            showViews: true,
            data: (topYouTubeData as any)?.data ?? [],
            loading: topYouTubeLoading,
            note: "YouTube · views",
          },
          {
            key: "instagram" as const,
            label: "Top Instagram Links",
            Icon: Instagram,
            iconBg: "bg-fuchsia-50",
            iconColor: "text-fuchsia-600",
            metric: "engagement" as const,
            showViews: false,
            data: (topInstagramData as any)?.data ?? [],
            loading: topInstagramLoading,
            note: "Instagram · likes + comments",
          },
          {
            key: "facebook" as const,
            label: "Top Facebook Links",
            Icon: Facebook,
            iconBg: "bg-blue-50",
            iconColor: "text-blue-600",
            metric: "engagement" as const,
            showViews: true,
            data: (topFacebookData as any)?.data ?? [],
            loading: topFacebookLoading,
            note: "Facebook · likes + comments",
          },
        ];

        // Anchor the shared window toggle to the first panel that renders content.
        // Facebook always renders (it shows an honest "collected in the background"
        // note when this window has no data yet), so include it for toggle-anchoring.
        const willRender = PLATFORMS.filter((p) => p.key === "facebook" || p.loading || p.data.length > 0);
        const toggleAnchorKey = willRender[0]?.key;

        return (
          <div className="space-y-6">
            {PLATFORMS.map((p) => {
              // YouTube and Instagram hide when empty — no data in this window is fine.
              // Facebook always renders so the "metrics refresh periodically" note shows.
              if (p.key !== "facebook" && !p.loading && p.data.length === 0) return null;
              const showToggle = p.key === toggleAnchorKey;
              const showViewsCol = p.showViews;
              const cols = showViewsCol
                ? "grid-cols-[1.5rem_1fr_8rem_5rem_5rem_5rem]"
                : "grid-cols-[1.5rem_1fr_8rem_5rem_5rem]";
              return (
                <div key={p.key} className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)]">
                  <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center gap-2 flex-wrap">
                    <div className={`h-8 w-8 rounded-lg ${p.iconBg} flex items-center justify-center shrink-0`}>
                      <p.Icon className={`h-4 w-4 ${p.iconColor}`} />
                    </div>
                    <h3 className="font-serif text-[#1A1A1A] font-medium">{p.label}</h3>
                    {showToggle && (
                      <div className="flex items-center gap-1 ml-2">
                        <button
                          onClick={() => setYtAllTime(false)}
                          className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${!ytAllTime ? "bg-[#1A1A1A] text-white border-[#1A1A1A]" : "text-[#7A7A7A] border-[#E8E0D0] hover:border-[#1A1A1A]"}`}
                        >
                          {windowLabel}
                        </button>
                        <button
                          onClick={() => setYtAllTime(true)}
                          className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${ytAllTime ? "bg-[#1A1A1A] text-white border-[#1A1A1A]" : "text-[#7A7A7A] border-[#E8E0D0] hover:border-[#1A1A1A]"}`}
                        >
                          All time
                        </button>
                      </div>
                    )}
                    <span className="ml-auto text-[10px] text-[#B0B0B0] shrink-0">
                      {p.note}
                      {(() => {
                        const rel = relativeUpdated(p.data);
                        return rel ? ` · ${rel}` : "";
                      })()}
                    </span>
                  </div>
                  {p.loading ? (
                    <div className="px-6 py-4 text-xs text-[#B0B0B0]">Loading…</div>
                  ) : p.key === "facebook" && p.data.length === 0 ? (
                    /* Facebook empty state — honest: metrics are collected gradually by the
                       insights job, so this fills in over time rather than being unavailable. */
                    <div className="px-6 py-5 text-xs text-[#7A7A7A] leading-relaxed max-w-prose">
                      Facebook views, reactions and comments are collected in the background and
                      refresh periodically. Recently submitted reels appear here once the next
                      insights run picks them up &mdash; check back shortly.
                    </div>
                  ) : (
                    <>
                      <div className={`px-6 py-2 grid ${cols} gap-3 text-[10px] font-medium text-[#B0B0B0] uppercase tracking-wide border-b border-[#F5F0E8]`}>
                        <span>#</span>
                        <span>Link</span>
                        <span>Employee</span>
                        {showViewsCol && <span className="text-right">Views</span>}
                        <span className="text-right">Likes</span>
                        <span className="text-right">Comments</span>
                      </div>
                      <ul className="divide-y divide-[#F5F0E8]">
                        {p.data.map((link: any, i: number) => (
                          <li key={`${link.linkId ?? link.url}-${i}`} className={`px-6 py-3 grid ${cols} gap-3 items-center`}>
                            <span className="text-xs font-medium text-[#B0B0B0]">{i + 1}</span>
                            <a
                              href={link.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-[#1A1A1A] hover:underline truncate min-w-0"
                              title={link.url}
                            >
                              {link.url}
                            </a>
                            <span className="text-xs text-[#7A7A7A] truncate">{link.employeeName}</span>
                            {showViewsCol && (
                              <span className="inline-flex items-center justify-end gap-1 text-[11px] font-semibold text-rose-700">
                                <Eye className="h-3 w-3 shrink-0" />
                                {fmtCompact(link.views)}
                              </span>
                            )}
                            <span className="inline-flex items-center justify-end gap-1 text-[11px] font-semibold text-pink-600">
                              <Heart className="h-3 w-3 shrink-0" />
                              {fmtCompact(link.likes)}
                            </span>
                            <span className="inline-flex items-center justify-end gap-1 text-[11px] font-semibold text-slate-500">
                              <MessageCircle className="h-3 w-3 shrink-0" />
                              {fmtCompact(link.comments)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Summary Table */}
      {!employeeId && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
          <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-[#FFF8E1] flex items-center justify-center">
              <TrendingUp className="h-4 w-4 text-[#B0B0B0]" />
            </div>
            <h3 className="font-serif text-[#1A1A1A] font-medium">Employee Summary</h3>
            {!summaryLoading && (summary?.employees ?? []).length > 0 && (
              <span className="ml-auto text-xs text-[#B0B0B0]">
                {(summary?.employees ?? []).length} employee{(summary?.employees ?? []).length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <div className="p-6">
            {summaryLoading ? (
              <div className="flex items-center justify-center gap-2 py-4 text-sm text-[#7A7A7A]">
                <svg className="animate-spin h-4 w-4 text-[#F5D547]" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                Loading summary...
              </div>
            ) : (summary?.employees ?? []).length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-sm text-[#7A7A7A]">
                <FileText className="h-8 w-8 text-[#E8E0D0]" />
                <span>No report data found.</span>
              </div>
            ) : (
              <div className="overflow-x-auto overflow-y-auto max-h-[560px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-white">
                    <tr className="border-b border-[#F0EAD8]">
                      {(
                        [
                          { key: "name",            label: "Employee",       align: "left"  },
                          { key: "email",           label: "Email",          align: "left"  },
                          { key: "reportCount",     label: "Reports",        align: "right" },
                          { key: "totalLinks",      label: "Total Links",    align: "right" },
                          { key: "linksToday",      label: null,             align: "right" },
                          { key: "avgLinksPerDay",  label: "Avg/Day",        align: "right" },
                          { key: "currentStreak",   label: "Streak",         align: "right" },
                          { key: "lastSubmittedAt", label: "Last Submitted", align: "left"  },
                        ] as { key: SortKey; label: string | null; align: "left" | "right" }[]
                      ).map(({ key, label, align }) => (
                        <th
                          key={key}
                          onClick={() => {
                            if (sortKey === key) {
                              setSortDir(d => d === "asc" ? "desc" : "asc");
                            } else {
                              setSortKey(key);
                              setSortDir(key === "name" || key === "email" ? "asc" : "desc");
                            }
                          }}
                          className={`py-2 pr-4 text-[#7A7A7A] text-xs font-medium cursor-pointer select-none whitespace-nowrap hover:text-[#1A1A1A] transition-colors ${align === "right" ? "text-right" : "text-left"} ${sortKey === key ? "text-[#1A1A1A]" : ""}`}
                        >
                          {key === "linksToday" ? (
                            <span className="inline-flex items-center gap-1" title="Links submitted today — always today, ignores the date filter">
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />
                              Today
                              <SortIcon col={key} sortKey={sortKey} sortDir={sortDir} />
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-0.5">
                              {label}
                              <SortIcon col={key} sortKey={sortKey} sortDir={sortDir} />
                            </span>
                          )}
                        </th>
                      ))}
                      {/* non-sortable actions column */}
                      <th className="py-2 text-[#7A7A7A] text-xs font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortEmployees(summary?.employees ?? [], sortKey, sortDir).map((emp: any) => (
                      <EmployeeRow
                        key={emp.id}
                        emp={emp}
                        onOpenEmpModal={handleOpenEmpModal}
                        onOpenTodayModal={handleOpenTodayModal}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Delete error banner */}
      {deleteError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-center gap-2 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {deleteError}
          <button onClick={() => setDeleteError(null)} className="ml-auto text-red-400 hover:text-red-600">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Recent Reports */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <div className="h-8 w-8 rounded-lg bg-[#FFF8E1] flex items-center justify-center">
            <FileText className="h-4 w-4 text-[#B0B0B0]" />
          </div>
          <h3 className="text-lg font-semibold font-serif text-[#1A1A1A]">
            {employeeId ? "Filtered Reports" : "Recent Reports"}
          </h3>
          {!reportsLoading && reports.length > 0 && (
            <span className="text-xs text-[#B0B0B0] ml-auto">
              {reports.length} report{reports.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
        {reportsLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#7A7A7A]">
            <svg className="animate-spin h-4 w-4 text-[#F5D547]" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
            Loading reports...
          </div>
        ) : reports.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-sm text-[#7A7A7A] bg-white rounded-2xl border border-[#E8E0D0]">
            <FileText className="h-10 w-10 text-[#E8E0D0]" />
            <span>No reports found.</span>
          </div>
        ) : (
          <div className="space-y-4">
            {reports.map((report: any) => (
              <ReportCard
                key={report.id}
                report={report}
                isAdmin={isAdmin}
                deletingLinkId={deletingLinkId}
                onDeleteLink={handleDeleteLink}
              />
            ))}
          </div>
        )}
      </div>
    </div>

    {/* Platform daily breakdown modal */}
    {platformModal && (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
        onClick={() => setPlatformModal(null)}
      >
        <div
          className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_16px_48px_rgba(0,0,0,0.16)] w-full max-w-sm mx-4 p-6"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <div className={`h-9 w-9 rounded-xl ${platformCardStyle(platformModal.platform).labelBg} flex items-center justify-center`}>
                <Link2 className={`h-4 w-4 ${platformCardStyle(platformModal.platform).labelColor}`} />
              </div>
              <div>
                <h2 className="font-serif text-[#1A1A1A] font-medium text-base capitalize">{platformModal.platform}</h2>
                <p className="text-xs text-[#B0B0B0]">{platformModal.count} total links</p>
              </div>
            </div>
            <button
              onClick={() => setPlatformModal(null)}
              className="h-7 w-7 rounded-lg flex items-center justify-center text-[#B0B0B0] hover:text-[#1A1A1A] hover:bg-[#F5F5F5] transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Daily breakdown table */}
          {!platformModal.dailyBreakdown.length ? (
            <p className="text-sm text-[#B0B0B0] text-center py-6">No data available.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto pr-1 space-y-2">
              {platformModal.dailyBreakdown.map(({ date, count }) => {
                const pct = platformModal.count > 0 ? Math.round((count / platformModal.count) * 100) : 0;
                const label = new Date(date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
                return (
                  <div key={date} className="flex items-center gap-3">
                    <span className="text-xs text-[#7A7A7A] w-24 shrink-0">{label}</span>
                    <div className="flex-1 h-1.5 rounded-full bg-[#F0EAD8]">
                      <div
                        className={`h-1.5 rounded-full ${platformCardStyle(platformModal.platform).bar} transition-all duration-500`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-sm font-semibold text-[#1A1A1A] w-8 text-right">{count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    )}

    {/* Per-employee platform breakdown modal */}
    {empModal && (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
        onClick={() => setEmpModal(null)}
      >
        <div
          className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_16px_48px_rgba(0,0,0,0.16)] w-full max-w-sm mx-4 p-6"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-xl bg-emerald-50 flex items-center justify-center">
                <Link2 className="h-5 w-5 text-emerald-600" />
              </div>
              <div>
                <h2 className="font-serif text-[#1A1A1A] font-medium text-base">{empModal.name}</h2>
                <p className="text-xs text-[#B0B0B0]">{empModal.totalLinks} links · by platform</p>
              </div>
            </div>
            <button
              onClick={() => setEmpModal(null)}
              className="h-7 w-7 rounded-lg flex items-center justify-center text-[#B0B0B0] hover:text-[#1A1A1A] hover:bg-[#F5F5F5] transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {!empModal.platformBreakdown.length ? (
            <p className="text-sm text-[#B0B0B0] text-center py-6">No links submitted yet.</p>
          ) : (
            <div className="space-y-3">
              {empModal.platformBreakdown.map(({ platform, count }) => {
                const pct = empModal.totalLinks > 0 ? Math.round((count / empModal.totalLinks) * 100) : 0;
                return (
                  <div key={platform}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${platformBadgeClass(platform)}`}>
                        {platform}
                      </span>
                      <span className="text-sm font-semibold text-[#1A1A1A]">
                        {count} <span className="text-xs font-normal text-[#B0B0B0]">({pct}%)</span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-[#F0EAD8]">
                      <div
                        className="h-1.5 rounded-full bg-emerald-400 transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    )}

    {/* Per-employee TODAY platform breakdown modal (filter-independent) */}
    {todayModal && (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
        onClick={() => setTodayModal(null)}
      >
        <div
          className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_16px_48px_rgba(0,0,0,0.16)] w-full max-w-sm mx-4 p-6"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-xl bg-blue-50 flex items-center justify-center">
                <BarChart2 className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <h2 className="font-serif text-[#1A1A1A] font-medium text-base">{todayModal.name}</h2>
                <p className="text-xs text-[#B0B0B0]">{todayModal.linksToday} links today · by platform</p>
              </div>
            </div>
            <button
              onClick={() => setTodayModal(null)}
              className="h-7 w-7 rounded-lg flex items-center justify-center text-[#B0B0B0] hover:text-[#1A1A1A] hover:bg-[#F5F5F5] transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {!todayModal.platformBreakdown.length ? (
            <p className="text-sm text-[#B0B0B0] text-center py-6">No links submitted today.</p>
          ) : (
            <div className="space-y-3">
              {todayModal.platformBreakdown.map(({ platform, count }) => {
                const pct = todayModal.linksToday > 0 ? Math.round((count / todayModal.linksToday) * 100) : 0;
                return (
                  <div key={platform}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${platformBadgeClass(platform)}`}>
                        {platform}
                      </span>
                      <span className="text-sm font-semibold text-[#1A1A1A]">
                        {count} <span className="text-xs font-normal text-[#B0B0B0]">({pct}%)</span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-[#F0EAD8]">
                      <div
                        className="h-1.5 rounded-full bg-blue-400 transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    )}

    {/* Team-wide window platform breakdown modal */}
    {teamTodayModal && (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40"
        onClick={() => setTeamTodayModal(null)}
      >
        <div
          className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_16px_48px_rgba(0,0,0,0.16)] w-full max-w-sm mx-4 p-6"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-xl bg-amber-50 flex items-center justify-center">
                <Calendar className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <h2 className="font-serif text-[#1A1A1A] font-medium text-base">{isEmployeeView ? selectedEmployeeName : "Team"} · {windowLabel}</h2>
                <p className="text-xs text-[#B0B0B0]">{teamTodayModal.totalLinks} links · {isEmployeeView ? "by platform" : "across team · by platform"}</p>
              </div>
            </div>
            <button
              onClick={() => setTeamTodayModal(null)}
              className="h-7 w-7 rounded-lg flex items-center justify-center text-[#B0B0B0] hover:text-[#1A1A1A] hover:bg-[#F5F5F5] transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {!teamTodayModal.platformBreakdown.length ? (
            <p className="text-sm text-[#B0B0B0] text-center py-6">No links submitted in this window.</p>
          ) : (
            <div className="space-y-3">
              {teamTodayModal.platformBreakdown.map(({ platform, count }) => {
                const pct = teamTodayModal.totalLinks > 0 ? Math.round((count / teamTodayModal.totalLinks) * 100) : 0;
                return (
                  <div key={platform}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${platformBadgeClass(platform)}`}>
                        {platform}
                      </span>
                      <span className="text-sm font-semibold text-[#1A1A1A]">
                        {count} <span className="text-xs font-normal text-[#B0B0B0]">({pct}%)</span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-[#F0EAD8]">
                      <div
                        className="h-1.5 rounded-full bg-amber-400 transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    )}
    </>
  );
}
