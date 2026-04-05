"use client";
import { useState } from "react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { useAccountGrowth } from "@/lib/hooks/use-accounts";

const PERIOD_OPTIONS = [
  { label: "7 Days", value: 7 },
  { label: "14 Days", value: 14 },
  { label: "30 Days", value: 30 },
  { label: "90 Days", value: 90 },
];

const PLATFORM_COLORS: Record<string, string> = {
  facebook: "bg-blue-500",
  instagram: "bg-pink-500",
  youtube: "bg-red-500",
  x: "bg-gray-800",
  twitter: "bg-gray-800",
  snapchat: "bg-yellow-400",
  linkedin: "bg-blue-700",
};

function getPlatformColor(platform: string) {
  return PLATFORM_COLORS[platform?.toLowerCase()] || "bg-gray-400";
}

export default function GrowthPage() {
  const [days, setDays] = useState(7);
  const { data, isLoading } = useAccountGrowth(days);

  const accounts = data?.data || [];

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Account Growth</h1>
          <p className="text-gray-500 mt-1">Track follower growth across your accounts</p>
        </div>
        <div className="flex gap-2">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setDays(opt.value)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                days === opt.value
                  ? "bg-blue-600 text-white"
                  : "bg-white border border-gray-300 text-gray-600 hover:border-blue-400"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <p className="text-gray-400">Loading growth data...</p>
        </div>
      ) : accounts.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
          <p className="text-gray-400">No growth data available.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {accounts.map((acc: any) => {
            const change = acc.change ?? 0;
            const pct = acc.changePercent ?? 0;
            const isUp = change >= 0;
            const snapshots: any[] = acc.snapshots?.slice(-7) || [];

            return (
              <div key={acc.id} className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 space-y-4">
                {/* Header */}
                <div className="flex items-start gap-3">
                  <div className={`w-3 h-3 rounded-full mt-1 flex-shrink-0 ${getPlatformColor(acc.platform)}`} />
                  <div className="flex-1">
                    <p className="font-semibold text-gray-900">{acc.handle || acc.name}</p>
                    <p className="text-xs text-gray-400 capitalize">{acc.platform}</p>
                  </div>
                </div>

                {/* Stats */}
                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-xs text-gray-500">Current Followers</p>
                    <p className="text-2xl font-bold text-gray-900">
                      {acc.currentFollowers?.toLocaleString() ?? "—"}
                    </p>
                  </div>
                  <div className={`flex items-center gap-1 text-sm font-medium ${isUp ? "text-green-600" : "text-red-500"}`}>
                    {isUp ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                    <span>{isUp ? "+" : ""}{change.toLocaleString()}</span>
                    <span className="text-xs">({isUp ? "+" : ""}{pct.toFixed(1)}%)</span>
                  </div>
                </div>

                {/* Snapshots table */}
                {snapshots.length > 0 && (
                  <div className="border-t border-gray-100 pt-3">
                    <p className="text-xs font-medium text-gray-500 mb-2">Recent Snapshots</p>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-400">
                          <th className="text-left pb-1">Date</th>
                          <th className="text-right pb-1">Followers</th>
                          <th className="text-right pb-1">Posts</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {snapshots.map((snap: any, i: number) => (
                          <tr key={i} className="text-gray-600">
                            <td className="py-1">
                              {snap.date
                                ? new Date(snap.date).toLocaleDateString("en-IN", { month: "short", day: "numeric" })
                                : "—"}
                            </td>
                            <td className="text-right py-1">
                              {snap.followers?.toLocaleString() ?? "—"}
                            </td>
                            <td className="text-right py-1">{snap.posts ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
