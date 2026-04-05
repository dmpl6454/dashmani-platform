"use client";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { Flame } from "lucide-react";

const MEDALS = ["🥇", "🥈", "🥉"];

export default function LeaderboardPage() {
  const { data, isLoading } = useSWR("/hr/leaderboard", (url) => apiFetch(url));
  const entries: any[] = (data as any)?.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Leaderboard</h2>
        <p className="text-gray-500 text-sm mt-1">Performance rankings across all employees</p>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading leaderboard...</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-gray-500">No data available yet.</p>
      ) : (
        <div className="space-y-3">
          {entries.map((entry: any) => {
            const isTop3 = entry.rank <= 3;
            return (
              <div
                key={entry.employee.id}
                className={`rounded-lg border bg-white p-4 flex items-center gap-4 ${
                  isTop3 ? "border-yellow-400 shadow-sm" : "border-gray-200"
                }`}
              >
                {/* Rank */}
                <div className="text-2xl w-10 text-center shrink-0">
                  {entry.rank <= 3 ? MEDALS[entry.rank - 1] : `#${entry.rank}`}
                </div>

                {/* Employee info */}
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-gray-900">{entry.employee.name}</p>
                  <p className="text-xs text-gray-400">{entry.employee.email}</p>

                  <div className="flex items-center gap-4 mt-2 text-sm text-gray-600">
                    <span className="flex items-center gap-1">
                      <Flame className="h-4 w-4 text-orange-500" />
                      <span className="font-medium">{entry.currentStreak}</span>
                      <span className="text-gray-400">streak</span>
                    </span>
                    <span>
                      <span className="font-medium">{entry.totalLinks}</span>
                      <span className="text-gray-400 ml-1">links</span>
                    </span>
                    <span>
                      <span className="font-medium">{entry.totalEngagement}</span>
                      <span className="text-gray-400 ml-1">engagement</span>
                    </span>
                  </div>
                </div>

                {/* Right side stats */}
                <div className="text-right shrink-0">
                  <p className="text-2xl font-bold text-blue-700">{entry.totalReports}</p>
                  <p className="text-xs text-gray-400">reports</p>
                  <p className="text-sm font-medium text-gray-600 mt-1">{entry.avgLinksPerDay}</p>
                  <p className="text-xs text-gray-400">avg links/day</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
