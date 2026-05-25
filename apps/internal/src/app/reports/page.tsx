"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { Input } from "@dashmani/ui";
import { formatDate } from "@dashmani/shared";
import { Users, FileText, Link2, Calendar, Filter, X, TrendingUp, Trophy, Trash2, AlertTriangle, BarChart2 } from "lucide-react";
import { useAdminReports, useReportSummary } from "@/lib/hooks/use-reports";
import { useEmployees } from "@/lib/hooks/use-employees";
import { LinkPreviewCard } from "@/components/link-preview-card";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-700",
  twitter: "bg-sky-100 text-sky-700",
  linkedin: "bg-[#FFF3C4] text-[#1A1A1A]",
  facebook: "bg-[#FFF3C4] text-[#1A1A1A]",
  youtube: "bg-red-100 text-red-700",
  tiktok: "bg-[#F0E4C4] text-[#1A1A1A]",
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

const AVATAR_GRADIENTS = [
  "linear-gradient(135deg, #667eea, #764ba2)",
  "linear-gradient(135deg, #f093fb, #f5576c)",
  "linear-gradient(135deg, #4facfe, #00f2fe)",
  "linear-gradient(135deg, #43e97b, #38f9d7)",
  "linear-gradient(135deg, #fa709a, #fee140)",
  "linear-gradient(135deg, #a18cd1, #fbc2eb)",
];

function getAvatarGradient(name: string) {
  let hash = 0;
  for (let i = 0; i < (name || "").length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

export default function ReportsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [deletingLinkId, setDeletingLinkId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [empModal, setEmpModal] = useState<{ name: string; totalLinks: number; platformBreakdown: { platform: string; count: number }[] } | null>(null);
  const [platformModal, setPlatformModal] = useState<{ platform: string; count: number; dailyBreakdown: { date: string; count: number }[] } | null>(null);

  useEffect(() => {
    if (empModal || platformModal) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [empModal, platformModal]);

  const { user } = useAuth();
  const isAdmin = user?.roles?.some((r) => r === "Admin" || r === "Super Admin") ?? false;

  const { data: summaryData, isLoading: summaryLoading, mutate: mutateSummary } = useReportSummary(startDate, endDate);
  const { data: reportsData, isLoading: reportsLoading, mutate: mutateReports } = useAdminReports({ employeeId, startDate, endDate });
  const { data: employeesData } = useEmployees();

  const summary = (summaryData as any)?.data;
  const reports = (reportsData as any)?.data ?? [];
  const employees = (employeesData as any)?.data ?? [];

  const hasFilters = startDate || endDate || employeeId;

  async function handleDeleteLink(linkId: string) {
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
  }

  const statCards = [
    { title: "Employees Reporting", value: summary?.employeesReporting ?? 0, icon: Users, iconColor: "text-blue-600", bgColor: "bg-blue-50 shadow-[0_2px_8px_rgba(59,130,246,0.12)]", sub: "submitted reports" },
    { title: "Total Reports", value: summary?.totalReports ?? 0, icon: FileText, iconColor: "text-purple-600", bgColor: "bg-purple-50 shadow-[0_2px_8px_rgba(147,51,234,0.12)]", sub: "in this period" },
    { title: "Total Links", value: summary?.totalLinks ?? 0, icon: Link2, iconColor: "text-emerald-600", bgColor: "bg-emerald-50 shadow-[0_2px_8px_rgba(16,185,129,0.12)]", sub: "submitted" },
    { title: "Today", value: formatDate(today), icon: Calendar, iconColor: "text-amber-600", bgColor: "bg-amber-50 shadow-[0_2px_8px_rgba(245,158,11,0.12)]", sub: "current date" },
  ];

  return (
    <>
    <div className="space-y-6 crx-animate-fade">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Daily Reports</h1>
          <p className="text-sm text-[#7A7A7A] mt-1">Employee daily link submission reports</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/reports/links"
            className="inline-flex items-center gap-2 bg-white border border-[#E8E0D0] text-[#1A1A1A] rounded-full px-4 py-2 text-sm font-medium hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)] hover:-translate-y-0.5 transition-all"
          >
            <TrendingUp className="h-4 w-4 text-emerald-600" />
            Links Analytics
          </Link>
          <Link
            href="/reports/leaderboard"
            className="inline-flex items-center gap-2 bg-[#1A1A1A] text-white rounded-full px-5 py-2.5 text-sm font-medium shadow-[0_4px_16px_rgba(0,0,0,0.18)] hover:shadow-[0_6px_24px_rgba(0,0,0,0.22)] hover:-translate-y-0.5 transition-all"
          >
            <Trophy className="h-4 w-4" />
            Leaderboard
          </Link>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((card, i) => {
          const Icon = card.icon;
          return (
            <div
              key={card.title}
              className={`bg-white rounded-2xl p-5 border border-[#E8E0D0] transition-all duration-300 hover:shadow-[0_8px_32px_rgba(0,0,0,0.06)] hover:-translate-y-0.5 crx-animate-slide crx-delay-${i + 1}`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs text-[#7A7A7A] font-medium">{card.title}</span>
                <div className={`h-10 w-10 rounded-xl ${card.bgColor} flex items-center justify-center`}>
                  <Icon className={`h-5 w-5 ${card.iconColor}`} />
                </div>
              </div>
              <p className={`font-light font-serif text-[#1A1A1A] leading-tight ${typeof card.value === "number" ? "text-[40px]" : "text-xl"}`}>
                {summaryLoading ? "\u2014" : card.value}
              </p>
              <p className="text-xs text-[#B0B0B0] mt-1">{card.sub}</p>
            </div>
          );
        })}
      </div>

      {/* Platform Breakdown Cards */}
      {!summaryLoading && (summary?.platformBreakdown ?? []).filter((p: any) => p.count > 0).length > 0 && (
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${(summary.platformBreakdown as any[]).filter((p) => p.count > 0).length}, minmax(0, 1fr))` }}>
          {(summary.platformBreakdown as { platform: string; count: number }[])
            .filter((p) => p.count > 0)
            .map(({ platform, count }) => {
              const style = platformCardStyle(platform);
              const pct = summary.totalLinks > 0 ? Math.round((count / summary.totalLinks) * 100) : 0;
              return (
                <div
                  key={platform}
                  onClick={() => setPlatformModal({ platform, count, dailyBreakdown: (summary.platformBreakdown as any[]).find((p: any) => p.platform === platform)?.dailyBreakdown ?? [] })}
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
                  <p className="font-serif font-light text-[40px] text-[#1A1A1A] leading-tight">{count}</p>
                  <p className="text-xs text-[#B0B0B0] -mt-2">links</p>

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

      {/* Filters */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-5">
        <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-[#FFF8E1] flex items-center justify-center">
              <Filter className="h-4 w-4 text-[#B0B0B0]" />
            </div>
            <h3 className="font-serif text-[#1A1A1A] font-medium">Filters</h3>
          </div>
          {hasFilters && (
            <button
              onClick={() => { setStartDate(""); setEndDate(""); setEmployeeId(""); }}
              className="flex items-center gap-1.5 text-xs font-medium text-[#7A7A7A] hover:text-[#E74C3C] bg-[#FFF8E1] hover:bg-red-50 px-3 py-1.5 rounded-full transition-all border border-[#F0EAD8] hover:border-red-200"
            >
              <X className="h-3 w-3" />
              Clear all
            </button>
          )}
        </div>
        <div className="p-6">
          <div className="flex flex-wrap gap-4 items-end">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[#7A7A7A] flex items-center gap-1">
                <Calendar className="h-3 w-3" /> Start Date
              </label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-44 border border-[#E8E0D0] rounded-xl bg-[#FEFCF8] focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] h-10"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[#7A7A7A] flex items-center gap-1">
                <Calendar className="h-3 w-3" /> End Date
              </label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-44 border border-[#E8E0D0] rounded-xl bg-[#FEFCF8] focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] h-10"
              />
            </div>
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
      </div>

      {/* Summary Table */}
      {!employeeId && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-6">
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
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#F0EAD8]">
                      <th className="text-left py-2 pr-4 text-[#7A7A7A] text-xs font-medium">Employee</th>
                      <th className="text-left py-2 pr-4 text-[#7A7A7A] text-xs font-medium">Email</th>
                      <th className="text-right py-2 pr-4 text-[#7A7A7A] text-xs font-medium">Reports</th>
                      <th className="text-right py-2 pr-4 text-[#7A7A7A] text-xs font-medium">Total Links</th>
                      <th className="text-right py-2 pr-4 text-[#7A7A7A] text-xs font-medium whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />
                          Today
                        </span>
                      </th>
                      <th className="text-right py-2 pr-4 text-[#7A7A7A] text-xs font-medium">Avg/Day</th>
                      <th className="text-right py-2 pr-4 text-[#7A7A7A] text-xs font-medium">Streak</th>
                      <th className="text-left py-2 pr-4 text-[#7A7A7A] text-xs font-medium">Last Submitted</th>
                      <th className="text-left py-2 text-[#7A7A7A] text-xs font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(summary?.employees ?? []).map((emp: any) => (
                      <tr key={emp.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors group">
                        <td className="py-3 pr-4">
                          <div className="flex items-center gap-3">
                            <div
                              className="h-8 w-8 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0 ring-2 ring-white shadow-sm"
                              style={{ background: getAvatarGradient(emp.name) }}
                            >
                              {emp.name?.[0]?.toUpperCase()}
                            </div>
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
                            onClick={() => setEmpModal({ name: emp.name, totalLinks: emp.totalLinks, platformBreakdown: emp.platformBreakdown ?? [] })}
                            title="View platform breakdown"
                            className="inline-flex items-center gap-1 min-w-[28px] h-6 rounded-full bg-emerald-50 text-emerald-700 text-xs font-semibold px-2 hover:bg-emerald-200 hover:shadow-sm transition-all cursor-pointer border border-transparent hover:border-emerald-300"
                          >
                            {emp.totalLinks}
                            <BarChart2 className="h-3 w-3 opacity-60" />
                          </button>
                        </td>
                        <td className="py-3 pr-4 text-right">
                          {(emp.linksToday ?? 0) > 0 ? (
                            <span className="inline-flex items-center justify-center min-w-[28px] h-6 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold px-2">
                              {emp.linksToday}
                            </span>
                          ) : (
                            <span className="text-xs text-[#B0B0B0]">—</span>
                          )}
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
            {reports.map((report: any, idx: number) => (
              <div key={report.id} className={`bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all duration-300 hover:shadow-[0_8px_32px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-${Math.min(idx + 1, 6)}`}>
                <div className="p-5">
                  {/* Employee info header */}
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <div
                        className="h-10 w-10 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0 ring-2 ring-white shadow-sm"
                        style={{ background: getAvatarGradient(report.employee?.name || "") }}
                      >
                        {report.employee?.name?.[0]?.toUpperCase()}
                      </div>
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

                  <div className="space-y-2 pl-[52px]">
                    {(report.links ?? []).map((link: any, i: number) => (
                      <div key={link.id ?? i} className="relative group/link">
                        <LinkPreviewCard link={link} />
                        {isAdmin && link.id && (
                          <button
                            onClick={() => handleDeleteLink(link.id)}
                            disabled={deletingLinkId === link.id}
                            title="Delete this link"
                            className="absolute top-2 right-2 h-7 w-7 rounded-lg bg-white border border-[#E8E0D0] flex items-center justify-center text-[#B0B0B0] hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-all opacity-0 group-hover/link:opacity-100 disabled:opacity-50 disabled:cursor-not-allowed z-10"
                          >
                            {deletingLinkId === link.id ? (
                              <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
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
    </>
  );
}
