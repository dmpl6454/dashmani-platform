"use client";
import { use } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useAdminReports } from "@/lib/hooks/use-reports";
import { useEmployee } from "@/lib/hooks/use-employees";
import { LinkPreviewCard } from "@/components/link-preview-card";

function formatTime(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatDate(dateStr: string) {
  try {
    return new Date(dateStr).toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" });
  } catch {
    return dateStr;
  }
}

export default function EmployeeReportsPage({ params }: { params: Promise<{ employeeId: string }> }) {
  const { employeeId } = use(params);
  const { data: employeeData, isLoading: empLoading } = useEmployee(employeeId);
  const { data: reportsData, isLoading: reportsLoading } = useAdminReports({ employeeId });

  const employee = (employeeData as any)?.data;
  const reports = (reportsData as any)?.data ?? [];

  return (
    <div className="space-y-6 crx-animate-fade">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link
          href="/reports"
          className="flex items-center gap-1 text-sm text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Reports
        </Link>
      </div>

      <div>
        {empLoading ? (
          <div className="h-8 w-48 bg-[#F0E4C4] animate-pulse rounded-lg" />
        ) : (
          <div className="flex items-center gap-4">
            <div
              className="h-12 w-12 rounded-full flex items-center justify-center text-white text-lg font-semibold shrink-0"
              style={{ background: "linear-gradient(135deg, #E8D5B7, #B8956A)" }}
            >
              {employee?.name?.[0]?.toUpperCase()}
            </div>
            <div>
              <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">{employee?.name ?? "Employee"}</h1>
              <p className="text-[#7A7A7A]">{employee?.email}</p>
            </div>
          </div>
        )}
      </div>

      {/* Reports List */}
      {reportsLoading ? (
        <p className="text-sm text-[#7A7A7A]">Loading reports...</p>
      ) : reports.length === 0 ? (
        <p className="text-sm text-[#7A7A7A]">No reports found for this employee.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-[#7A7A7A]">
            {reports.length} report{reports.length !== 1 ? "s" : ""} found
          </p>
          {reports.map((report: any, idx: number) => {
            const linkCount = report.links?.length ?? 0;
            const reportDate = report.date ?? report.createdAt;
            const submittedAt = report.createdAt ?? report.date;
            return (
              <div key={report.id} className={`bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-${Math.min(idx + 1, 6)}`}>
                <div className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <span className="rounded-full px-3 py-1 text-xs font-medium bg-[#FFF3C4] text-[#1A1A1A]">{formatDate(reportDate)}</span>
                      <span className="text-xs text-[#7A7A7A]">
                        {linkCount} link{linkCount !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <span className="text-xs text-[#7A7A7A]">
                      Submitted at {formatTime(submittedAt)}
                    </span>
                  </div>

                  {report.notes && (
                    <p className="text-sm text-[#7A7A7A] mb-3 italic border-l-2 border-[#E8E0D0] pl-3">
                      {report.notes}
                    </p>
                  )}

                  <div className="space-y-2">
                    {(report.links ?? []).map((link: any, i: number) => (
                      <LinkPreviewCard key={link.id ?? i} link={link} />
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
