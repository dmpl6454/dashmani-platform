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
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-light text-[#1A1A1A] font-serif">Account Growth</h1>
          <p className="text-[#7A7A7A] mt-1">Track follower growth across your accounts</p>
        </div>
        <div className="flex gap-2">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setDays(opt.value)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                days === opt.value
                  ? "bg-[#1A1A1A] text-white shadow-md"
                  : "bg-white border border-[#E8E0D0] text-[#7A7A7A] hover:border-[#F5D547]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#E8E0D0] p-12 text-center shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <p className="text-[#B0B0B0]">No growth data available.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {accounts.map((acc: any) => {
            const change = acc.change ?? 0;
            const pct = acc.changePercent ?? 0;
            const isUp = change >= 0;
            const snapshots: any[] = acc.snapshots?.slice(-7) || [];

            return (
              <div key={acc.id} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5 space-y-4">
                <div className="flex items-start gap-3">
                  <div className={`w-3 h-3 rounded-full mt-1 flex-shrink-0 ${getPlatformColor(acc.platform)}`} />
                  <div className="flex-1">
                    <p className="font-semibold text-[#1A1A1A]">{acc.handle || acc.name}</p>
                    <p className="text-xs text-[#B0B0B0] capitalize">{acc.platform}</p>
                  </div>
                </div>

                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-xs text-[#7A7A7A]">Current Followers</p>
                    <p className="text-2xl font-light text-[#1A1A1A] font-serif">{acc.currentFollowers?.toLocaleString() ?? "—"}</p>
                  </div>
                  <div className={`flex items-center gap-1 text-sm font-medium ${isUp ? "text-[#6BCB77]" : "text-[#E74C3C]"}`}>
                    {isUp ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
                    <span>{isUp ? "+" : ""}{change.toLocaleString()}</span>
                    <span className="text-xs">({isUp ? "+" : ""}{pct.toFixed(1)}%)</span>
                  </div>
                </div>

                {snapshots.length > 0 && (
                  <div className="border-t border-[#E8E0D0] pt-3">
                    <p className="text-xs font-medium text-[#7A7A7A] mb-2">Recent Snapshots</p>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-[#B0B0B0]">
                          <th className="text-left pb-1">Date</th>
                          <th className="text-right pb-1">Followers</th>
                          <th className="text-right pb-1">Posts</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#E8E0D0]/50">
                        {snapshots.map((snap: any, i: number) => (
                          <tr key={i} className="text-[#7A7A7A]">
                            <td className="py-1">{snap.date ? new Date(snap.date).toLocaleDateString("en-IN", { month: "short", day: "numeric" }) : "—"}</td>
                            <td className="text-right py-1">{snap.followers?.toLocaleString() ?? "—"}</td>
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
