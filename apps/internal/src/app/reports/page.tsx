"use client";
import { useState } from "react";
import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent, Badge, StatCard, Input } from "@dashmani/ui";
import { Users, FileText, Link2, Calendar } from "lucide-react";
import { useAdminReports, useReportSummary } from "@/lib/hooks/use-reports";
import { useEmployees } from "@/lib/hooks/use-employees";

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

export default function ReportsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [employeeId, setEmployeeId] = useState("");

  const { data: summaryData, isLoading: summaryLoading } = useReportSummary(startDate, endDate);
  const { data: reportsData, isLoading: reportsLoading } = useAdminReports({ employeeId, startDate, endDate });
  const { data: employeesData } = useEmployees();

  const summary = (summaryData as any)?.data;
  const reports = (reportsData as any)?.data ?? [];
  const employees = (employeesData as any)?.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Reports</h2>
          <p className="text-muted-foreground">Employee daily link submission reports</p>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Employees Reporting"
          value={summaryLoading ? "--" : summary?.employeesReporting ?? 0}
          icon={<Users className="h-8 w-8" />}
        />
        <StatCard
          title="Total Reports"
          value={summaryLoading ? "--" : summary?.totalReports ?? 0}
          icon={<FileText className="h-8 w-8" />}
        />
        <StatCard
          title="Total Links Submitted"
          value={summaryLoading ? "--" : summary?.totalLinks ?? 0}
          icon={<Link2 className="h-8 w-8" />}
        />
        <StatCard
          title="Today's Date"
          value={today}
          icon={<Calendar className="h-8 w-8" />}
        />
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-muted-foreground">Start Date</label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-44"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-muted-foreground">End Date</label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-44"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-muted-foreground">Employee</label>
              <select
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring w-52"
              >
                <option value="">All Employees</option>
                {employees.map((emp: any) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </div>
            {(startDate || endDate || employeeId) && (
              <button
                onClick={() => { setStartDate(""); setEndDate(""); setEmployeeId(""); }}
                className="text-sm text-blue-600 hover:underline self-end pb-1"
              >
                Clear filters
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Summary Table */}
      {!employeeId && (
        <Card>
          <CardHeader>
            <CardTitle>Employee Summary</CardTitle>
          </CardHeader>
          <CardContent>
            {summaryLoading ? (
              <p className="text-sm text-muted-foreground">Loading summary...</p>
            ) : (summary?.employees ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No report data found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="text-left py-2 pr-4 font-medium">Employee</th>
                      <th className="text-left py-2 pr-4 font-medium">Email</th>
                      <th className="text-right py-2 pr-4 font-medium">Reports</th>
                      <th className="text-right py-2 pr-4 font-medium">Total Links</th>
                      <th className="text-left py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(summary?.employees ?? []).map((emp: any) => (
                      <tr key={emp.id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="py-2 pr-4 font-medium">{emp.name}</td>
                        <td className="py-2 pr-4 text-muted-foreground">{emp.email}</td>
                        <td className="py-2 pr-4 text-right">{emp.reportCount}</td>
                        <td className="py-2 pr-4 text-right">{emp.totalLinks}</td>
                        <td className="py-2">
                          <Link
                            href={`/reports/${emp.id}`}
                            className="text-blue-600 hover:underline text-xs"
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
          </CardContent>
        </Card>
      )}

      {/* Recent Reports */}
      <div>
        <h3 className="text-lg font-semibold mb-4">
          {employeeId ? "Filtered Reports" : "Recent Reports"}
        </h3>
        {reportsLoading ? (
          <p className="text-sm text-muted-foreground">Loading reports...</p>
        ) : reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reports found.</p>
        ) : (
          <div className="space-y-4">
            {reports.map((report: any) => (
              <Card key={report.id}>
                <CardContent className="pt-4">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="font-semibold">{report.employee?.name ?? "Unknown"}</p>
                      <p className="text-xs text-muted-foreground">{report.employee?.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">
                        {new Date(report.date ?? report.createdAt).toLocaleDateString()}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {report.links?.length ?? 0} link{(report.links?.length ?? 0) !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>

                  {report.notes && (
                    <p className="text-sm text-muted-foreground mb-3 italic">{report.notes}</p>
                  )}

                  <div className="space-y-2">
                    {(report.links ?? []).map((link: any, idx: number) => (
                      <div
                        key={link.id ?? idx}
                        className="flex items-center gap-3 p-2 rounded-md bg-muted/40"
                      >
                        <span
                          className={`text-xs font-medium px-2 py-0.5 rounded-full ${platformBadgeClass(link.platform)}`}
                        >
                          {link.platform ?? "—"}
                        </span>
                        <span className="text-sm font-medium shrink-0">{link.accountName ?? link.account?.name}</span>
                        {link.description && (
                          <span className="text-xs text-muted-foreground truncate flex-1">{link.description}</span>
                        )}
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline text-xs shrink-0 ml-auto"
                        >
                          Open ↗
                        </a>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
