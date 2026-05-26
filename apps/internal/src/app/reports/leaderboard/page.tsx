"use client";
import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Input } from "@dashmani/ui";
import { Trophy, Flame, Users, FileText, Link2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { UserAvatar } from "@/components/user-avatar";

const MEDALS = ["#1", "#2", "#3"];

export default function AdminLeaderboardPage() {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";

  const { data, isLoading } = useSWR(`/admin/reports/leaderboard${query}`, (url) => apiFetch(url));
  const entries: any[] = (data as any)?.data ?? [];

  const topPerformer = entries[0]?.employee?.name ?? "\u2014";
  const activeEmployees = entries.length;
  const totalReports = entries.reduce((sum: number, e: any) => sum + e.totalReports, 0);
  const totalLinks = entries.reduce((sum: number, e: any) => sum + e.totalLinks, 0);

  const statCards = [
    { title: "Top Performer", value: topPerformer, icon: Trophy, sub: "highest contributor" },
    { title: "Active Employees", value: activeEmployees, icon: Users, sub: "reporting" },
    { title: "Total Reports", value: totalReports, icon: FileText, sub: "submitted" },
    { title: "Total Links", value: totalLinks, icon: Link2, sub: "shared" },
  ];

  return (
    <div className="space-y-6 crx-animate-fade">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A] flex items-center gap-3">
            <Trophy className="h-8 w-8 text-[#F5D547]" />
            Leaderboard
          </h1>
          <p className="text-[#7A7A7A] mt-1">
            Employee ranking by reports, streaks, and engagement
          </p>
        </div>
        <Link
          href="/reports"
          className="text-sm text-[#1A1A1A] hover:text-[#F5D547] font-medium"
        >
          &larr; Back to Reports
        </Link>
      </div>

      {/* Date Range Filter */}
      <div className="flex flex-wrap gap-4 items-end p-5 bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] crx-animate-slide crx-delay-1">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-[#7A7A7A]">Start Date</label>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-44 border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-[#7A7A7A]">End Date</label>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-44 border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]"
          />
        </div>
        {(startDate || endDate) && (
          <button
            onClick={() => { setStartDate(""); setEndDate(""); }}
            className="text-sm text-[#1A1A1A] hover:text-[#F5D547] self-end pb-1"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((card, i) => {
          const Icon = card.icon;
          return (
            <div
              key={card.title}
              className={`bg-white rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-${i + 2}`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-[#7A7A7A]">{card.title}</span>
                <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
                  <Icon className="h-5 w-5 text-[#1A1A1A]" />
                </div>
              </div>
              <p className="text-[40px] font-light font-serif text-[#1A1A1A] leading-tight truncate">
                {isLoading ? "--" : card.value}
              </p>
              <p className="text-xs text-[#B0B0B0] mt-1">{card.sub}</p>
            </div>
          );
        })}
      </div>

      {/* Leaderboard Table */}
      <div className="rounded-2xl border border-[#E8E0D0] bg-white overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.05)] crx-animate-slide crx-delay-6">
        <div className="px-6 py-4 border-b border-[#F0EAD8]">
          <h3 className="font-semibold font-serif text-[#1A1A1A]">Rankings</h3>
        </div>
        {isLoading ? (
          <p className="py-8 text-center text-sm text-[#B0B0B0]">Loading...</p>
        ) : entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-[#B0B0B0]">No data found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F0EAD8]">
                  <th className="text-left py-3 px-5 text-[#7A7A7A] text-xs font-medium w-16">Rank</th>
                  <th className="text-left py-3 px-4 text-[#7A7A7A] text-xs font-medium">Employee</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Reports</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Links</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Avg/Day</th>
                  <th className="text-center py-3 px-4 text-[#7A7A7A] text-xs font-medium">Streak</th>
                  <th className="text-center py-3 px-4 text-[#7A7A7A] text-xs font-medium">Best Streak</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Engagement</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry: any) => (
                  <tr
                    key={entry.employee.id}
                    className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors"
                  >
                    <td className="py-3 px-5 text-center text-lg font-serif">
                      {entry.rank <= 3 ? (
                        <span className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-[#FFF3C4] text-[#1A1A1A] font-bold text-sm">
                          {MEDALS[entry.rank - 1]}
                        </span>
                      ) : `#${entry.rank}`}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <UserAvatar
                          name={entry.employee.name}
                          imageUrl={entry.employee.profileImageUrl}
                          size={7}
                          textClassName="text-xs"
                        />
                        <div>
                          <Link
                            href={`/reports/${entry.employee.id}`}
                            className="font-medium text-[#1A1A1A] hover:text-[#F5D547]"
                          >
                            {entry.employee.name}
                          </Link>
                          <p className="text-xs text-[#B0B0B0]">{entry.employee.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right font-medium text-[#1A1A1A]">{entry.totalReports}</td>
                    <td className="py-3 px-4 text-right text-[#1A1A1A]">{entry.totalLinks}</td>
                    <td className="py-3 px-4 text-right text-[#1A1A1A]">{entry.avgLinksPerDay}</td>
                    <td className="py-3 px-4 text-center">
                      <span className="flex items-center justify-center gap-1">
                        <Flame className="h-4 w-4 text-[#F5A623]" />
                        <span className="font-medium text-[#1A1A1A]">{entry.currentStreak}</span>
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center font-medium text-[#1A1A1A]">{entry.longestStreak}</td>
                    <td className="py-3 px-4 text-right text-[#1A1A1A]">{entry.totalEngagement}</td>
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
