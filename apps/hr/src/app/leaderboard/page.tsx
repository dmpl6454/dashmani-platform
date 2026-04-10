"use client";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { Flame, Trophy } from "lucide-react";

const MEDALS = ["🥇", "🥈", "🥉"];

export default function LeaderboardPage() {
  const { data, isLoading } = useSWR("/hr/leaderboard", (url) => apiFetch(url));
  const entries: any[] = (data as any)?.data ?? [];

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
          <Trophy className="h-5 w-5 text-[#1A1A1A]" />
        </div>
        <div>
          <h2 className="text-4xl font-light text-[#1A1A1A] font-serif">Leaderboard</h2>
          <p className="text-[#7A7A7A] text-sm mt-0.5">Performance rankings across all employees</p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" />
        </div>
      ) : entries.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#E8E0D0] p-12 text-center shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <p className="text-[#B0B0B0]">No data available yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry: any) => {
            const isTop3 = entry.rank <= 3;
            return (
              <div
                key={entry.employee.id}
                className={`rounded-2xl bg-white p-5 flex items-center gap-4 border transition-all ${
                  isTop3 ? "border-[#F5D547] shadow-[0_2px_16px_rgba(245,213,71,0.15)]" : "border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.06)]"
                }`}
              >
                <div className="text-2xl w-12 text-center shrink-0">
                  {entry.rank <= 3 ? MEDALS[entry.rank - 1] : (
                    <span className="text-lg font-medium text-[#B0B0B0]">#{entry.rank}</span>
                  )}
                </div>

                <div className="h-10 w-10 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0" style={{ background: "linear-gradient(135deg, #E8D5B7, #B8956A)" }}>
                  {entry.employee.name?.charAt(0)?.toUpperCase() || "?"}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-[#1A1A1A]">{entry.employee.name}</p>
                  <p className="text-xs text-[#B0B0B0]">{entry.employee.email}</p>
                  <div className="flex items-center gap-4 mt-2 text-sm text-[#7A7A7A]">
                    <span className="flex items-center gap-1">
                      <Flame className="h-4 w-4 text-orange-500" />
                      <span className="font-medium text-[#1A1A1A]">{entry.currentStreak}</span>
                      <span>streak</span>
                    </span>
                    <span>
                      <span className="font-medium text-[#1A1A1A]">{entry.totalLinks}</span>
                      <span className="ml-1">links</span>
                    </span>
                    <span>
                      <span className="font-medium text-[#1A1A1A]">{entry.totalEngagement}</span>
                      <span className="ml-1">engagement</span>
                    </span>
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <p className="text-2xl font-light text-[#1A1A1A] font-serif">{entry.totalReports}</p>
                  <p className="text-xs text-[#B0B0B0]">reports</p>
                  <p className="text-sm font-medium text-[#7A7A7A] mt-1">{entry.avgLinksPerDay}</p>
                  <p className="text-xs text-[#B0B0B0]">avg links/day</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
