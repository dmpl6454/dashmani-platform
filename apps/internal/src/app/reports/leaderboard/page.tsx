"use client";
import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { StatCard, Input } from "@dashmani/ui";
import { Trophy, Flame, Users, FileText, Link2 } from "lucide-react";
import { apiFetch } from "@/lib/api";

const MEDALS = ["🥇", "🥈", "🥉"];

export default function AdminLeaderboardPage() {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";

  const { data, isLoading } = useSWR(`/admin/reports/leaderboard${query}`, (url) => apiFetch(url));
  const entries: any[] = (data as any)?.data ?? [];

  // Stat summaries
  const topPerformer = entries[0]?.employee?.name ?? "—";
  const activeEmployees = entries.length;
  const totalReports = entries.reduce((sum: number, e: any) => sum + e.totalReports, 0);
  const totalLinks = entries.reduce((sum: number, e: any) => sum + e.totalLinks, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Trophy className="h-6 w-6 text-yellow-500" />
            Performance Leaderboard
          </h2>
          <p className="text-muted-foreground text-sm mt-1">
            Employee ranking by reports, streaks, and engagement
          </p>
        </div>
        <Link
          href="/reports"
          className="text-sm text-blue-600 hover:underline"
        >
          &larr; Back to Reports
        </Link>
      </div>

      {/* Date Range Filter */}
      <div className="flex flex-wrap gap-4 items-end p-4 bg-white rounded-lg border border-gray-200">
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
        {(startDate || endDate) && (
          <button
            onClick={() => { setStartDate(""); setEndDate(""); }}
            className="text-sm text-blue-600 hover:underline self-end pb-1"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Top Performer"
          value={isLoading ? "--" : topPerformer}
          icon={<Trophy className="h-8 w-8 text-yellow-500" />}
        />
        <StatCard
          title="Active Employees"
          value={isLoading ? "--" : activeEmployees}
          icon={<Users className="h-8 w-8" />}
        />
        <StatCard
          title="Total Reports"
          value={isLoading ? "--" : totalReports}
          icon={<FileText className="h-8 w-8" />}
        />
        <StatCard
          title="Total Links"
          value={isLoading ? "--" : totalLinks}
          icon={<Link2 className="h-8 w-8" />}
        />
      </div>

      {/* Leaderboard Table */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900">Rankings</h3>
        </div>
        {isLoading ? (
          <p className="py-8 text-center text-sm text-gray-400">Loading...</p>
        ) : entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">No data found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left py-3 px-5 font-medium text-gray-500 w-16">Rank</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-500">Employee</th>
                  <th className="text-right py-3 px-4 font-medium text-gray-500">Reports</th>
                  <th className="text-right py-3 px-4 font-medium text-gray-500">Links</th>
                  <th className="text-right py-3 px-4 font-medium text-gray-500">Avg/Day</th>
                  <th className="text-center py-3 px-4 font-medium text-gray-500">Streak</th>
                  <th className="text-center py-3 px-4 font-medium text-gray-500">Best Streak</th>
                  <th className="text-right py-3 px-4 font-medium text-gray-500">Engagement</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry: any) => (
                  <tr
                    key={entry.employee.id}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50 transition-colors"
                  >
                    <td className="py-3 px-5 text-center text-lg">
                      {entry.rank <= 3 ? MEDALS[entry.rank - 1] : `#${entry.rank}`}
                    </td>
                    <td className="py-3 px-4">
                      <Link
                        href={`/reports/${entry.employee.id}`}
                        className="font-medium text-blue-600 hover:underline"
                      >
                        {entry.employee.name}
                      </Link>
                      <p className="text-xs text-gray-400">{entry.employee.email}</p>
                    </td>
                    <td className="py-3 px-4 text-right font-medium">{entry.totalReports}</td>
                    <td className="py-3 px-4 text-right">{entry.totalLinks}</td>
                    <td className="py-3 px-4 text-right">{entry.avgLinksPerDay}</td>
                    <td className="py-3 px-4 text-center">
                      <span className="flex items-center justify-center gap-1">
                        <Flame className="h-4 w-4 text-orange-500" />
                        <span className="font-medium">{entry.currentStreak}</span>
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center font-medium">{entry.longestStreak}</td>
                    <td className="py-3 px-4 text-right">{entry.totalEngagement}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
