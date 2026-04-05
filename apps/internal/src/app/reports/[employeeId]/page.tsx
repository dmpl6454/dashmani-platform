"use client";
import { use } from "react";
import Link from "next/link";
import { Card, CardContent, Badge } from "@dashmani/ui";
import { ArrowLeft } from "lucide-react";
import { useAdminReports } from "@/lib/hooks/use-reports";
import { useEmployee } from "@/lib/hooks/use-employees";

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-700",
  twitter: "bg-sky-100 text-sky-700",
  linkedin: "bg-blue-100 text-blue-700",
  facebook: "bg-indigo-100 text-indigo-700",
  youtube: "bg-red-100 text-red-700",
  tiktok: "bg-slate-100 text-slate-700",
};

function platformBadgeClass(platform: string) {
  return PLATFORM_COLORS[platform?.toLowerCase()] ?? "bg-gray-100 text-gray-700";
}

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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link
          href="/reports"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Reports
        </Link>
      </div>

      <div>
        {empLoading ? (
          <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        ) : (
          <>
            <h2 className="text-2xl font-bold">{employee?.name ?? "Employee"}</h2>
            <p className="text-muted-foreground">{employee?.email}</p>
          </>
        )}
      </div>

      {/* Reports List */}
      {reportsLoading ? (
        <p className="text-sm text-muted-foreground">Loading reports...</p>
      ) : reports.length === 0 ? (
        <p className="text-sm text-muted-foreground">No reports found for this employee.</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {reports.length} report{reports.length !== 1 ? "s" : ""} found
          </p>
          {reports.map((report: any) => {
            const linkCount = report.links?.length ?? 0;
            const reportDate = report.date ?? report.createdAt;
            const submittedAt = report.createdAt ?? report.date;
            return (
              <Card key={report.id}>
                <CardContent className="pt-4">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <Badge variant="secondary">{formatDate(reportDate)}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {linkCount} link{linkCount !== 1 ? "s" : ""}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      Submitted at {formatTime(submittedAt)}
                    </span>
                  </div>

                  {report.notes && (
                    <p className="text-sm text-muted-foreground mb-3 italic border-l-2 border-muted pl-3">
                      {report.notes}
                    </p>
                  )}

                  <div className="space-y-2">
                    {(report.links ?? []).map((link: any, idx: number) => (
                      <div
                        key={link.id ?? idx}
                        className="flex items-start gap-3 p-3 rounded-md bg-muted/40"
                      >
                        <span
                          className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${platformBadgeClass(link.platform)}`}
                        >
                          {link.platform ?? "—"}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">
                            {link.accountName ?? link.account?.name ?? "—"}
                          </p>
                          {link.description && (
                            <p className="text-xs text-muted-foreground mt-0.5">{link.description}</p>
                          )}
                        </div>
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline text-xs shrink-0"
                        >
                          Open ↗
                        </a>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
