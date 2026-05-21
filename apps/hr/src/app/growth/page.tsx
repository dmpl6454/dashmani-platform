"use client";
import { useState } from "react";
import { TrendingUp, TrendingDown } from "lucide-react";
import { useAccountGrowth } from "@/lib/hooks/use-accounts";
import { Topstrip } from "@/components/portal-shell";

const PERIOD_OPTIONS = [{ label: "7d", value: 7 }, { label: "14d", value: 14 }, { label: "30d", value: 30 }, { label: "90d", value: 90 }];

const PLATFORM_CFG: Record<string, { bg: string; text: string; label: string }> = {
  instagram: { bg: "bg-pink-50",  text: "text-pink-700",  label: "Instagram" },
  linkedin:  { bg: "bg-blue-50",  text: "text-blue-700",  label: "LinkedIn"  },
  twitter:   { bg: "bg-sky-50",   text: "text-sky-600",   label: "Twitter/X" },
  x:         { bg: "bg-sky-50",   text: "text-sky-600",   label: "Twitter/X" },
  youtube:   { bg: "bg-red-50",   text: "text-red-600",   label: "YouTube"   },
  facebook:  { bg: "bg-blue-50",  text: "text-blue-600",  label: "Facebook"  },
  snapchat:  { bg: "bg-yellow-50",text: "text-yellow-700",label: "Snapchat"  },
};
function platCfg(p: string) { return PLATFORM_CFG[p?.toLowerCase()] ?? { bg: "bg-muted", text: "text-ink-3", label: p || "—" }; }

export default function GrowthPage() {
  const [days, setDays] = useState(7);
  const { data, isLoading } = useAccountGrowth(days);
  const accounts = data?.data ?? [];

  return (
    <>
      <Topstrip title="Account Growth" sub="Follower trends" right={
        <div className="flex gap-1">
          {PERIOD_OPTIONS.map(opt => (
            <button key={opt.value} onClick={() => setDays(opt.value)}
              className={`h-8 px-3 rounded-full text-[12px] font-semibold border-2 transition-all ${days === opt.value ? "bg-ink text-white border-ink" : "bg-surface text-ink-2 border-ink/12 hover:border-ink/25"}`}>
              {opt.label}
            </button>
          ))}
        </div>
      } />
      <div className="px-6 py-6 flex-1 overflow-y-auto">
        <div className="space-y-4 anim-fade-up d1">
          {isLoading ? (
            <div className="v3-card px-5 py-10 text-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo mx-auto" /></div>
          ) : accounts.length === 0 ? (
            <div className="v3-card px-5 py-10 text-center"><TrendingUp size={24} className="mx-auto mb-3 text-ink-4" /><p className="text-[13px] text-ink-3 font-medium">No growth data available</p></div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {accounts.map((acc: any, i: number) => {
                const change = acc.change ?? 0; const pct = acc.changePercent ?? 0; const isUp = change >= 0;
                const snapshots: any[] = acc.snapshots?.slice(-7) ?? [];
                const pc = platCfg(acc.platform);
                const maxFollowers = Math.max(...snapshots.map((s: any) => s.followers || 0), 1);
                return (
                  <div key={acc.id} className={`v3-card v3-card-lift overflow-hidden anim-fade-up d${Math.min(i + 1, 8)}`}>
                    <div className="px-5 h-12 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                      <div className="flex items-center gap-2">
                        <span className={`h-5 px-2 rounded-full text-[10px] font-bold inline-flex items-center ${pc.bg} ${pc.text}`}>{pc.label}</span>
                        <span className="text-[13px] font-semibold text-ink truncate">{acc.handle || acc.name}</span>
                      </div>
                      <div className={`flex items-center gap-1 text-[12px] font-semibold ${isUp ? "text-success" : "text-danger"}`}>
                        {isUp ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                        {isUp ? "+" : ""}{change.toLocaleString()} ({isUp ? "+" : ""}{pct.toFixed(1)}%)
                      </div>
                    </div>
                    <div className="p-5">
                      <div className="font-display text-[32px] font-semibold text-ink leading-none">{acc.currentFollowers?.toLocaleString("en-IN") ?? "—"}</div>
                      <div className="text-[12px] text-ink-3 font-medium mt-1">current followers</div>
                      {snapshots.length > 0 && (
                        <div className="mt-4">
                          <div className="flex items-end gap-1 h-16">
                            {snapshots.map((s: any, j: number) => (
                              <div key={j} className="flex-1 flex flex-col items-center gap-1">
                                <div className="w-full rounded-t-sm" style={{ height: `${(s.followers / maxFollowers) * 56}px`, background: `rgba(93,95,239,${0.3 + j * 0.1})` }} />
                              </div>
                            ))}
                          </div>
                          <div className="flex justify-between mt-1 text-[10px] text-ink-4">
                            {snapshots.length > 0 && <span>{new Date(snapshots[0].date).toLocaleDateString("en-IN", { month: "short", day: "numeric" })}</span>}
                            {snapshots.length > 1 && <span>{new Date(snapshots[snapshots.length - 1].date).toLocaleDateString("en-IN", { month: "short", day: "numeric" })}</span>}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
