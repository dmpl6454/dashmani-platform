"use client";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { Flame, Trophy } from "lucide-react";
import { Topstrip } from "@/components/portal-shell";

const MEDALS = ["🥇", "🥈", "🥉"];

const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#667eea,#764ba2)", "linear-gradient(135deg,#f093fb,#f5576c)",
  "linear-gradient(135deg,#4facfe,#00f2fe)", "linear-gradient(135deg,#43e97b,#38f9d7)",
  "linear-gradient(135deg,#fa709a,#fee140)", "linear-gradient(135deg,#a18cd1,#fbc2eb)",
  "linear-gradient(135deg,#fccb90,#d57eeb)", "linear-gradient(135deg,#e0c3fc,#8ec5fc)",
];
function avatarGrad(name: string) {
  let h = 0; for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_GRADIENTS[Math.abs(h) % AVATAR_GRADIENTS.length];
}

export default function LeaderboardPage() {
  const { data, isLoading } = useSWR("/hr/leaderboard", (url) => apiFetch(url));
  const entries: any[] = (data as any)?.data ?? [];

  return (
    <>
      <Topstrip title="Leaderboard" sub="Performance rankings" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px]">
        <div className="space-y-4 anim-fade-up d1">

          {/* Top 3 cards */}
          {entries.length >= 3 && (
            <div className="grid grid-cols-3 gap-4">
              {entries.slice(0, 3).map((entry: any, i: number) => (
                <div key={entry.employee.id} className={`v3-card v3-card-lift p-5 text-center anim-fade-up d${i + 1}`}>
                  <div className="text-[28px] mb-2">{MEDALS[i]}</div>
                  <div className="h-11 w-11 rounded-2xl grid place-items-center text-white font-bold text-[14px] mx-auto mb-2"
                       style={{ background: avatarGrad(entry.employee.name) }}>
                    {entry.employee.name?.[0]?.toUpperCase() || "?"}
                  </div>
                  <p className="text-[13.5px] font-bold text-ink">{entry.employee.name}</p>
                  <div className="font-num text-[22px] font-semibold text-indigo mt-1">{entry.totalReports}</div>
                  <div className="text-[11px] text-ink-3 font-medium">reports</div>
                  <div className="flex items-center justify-center gap-1 mt-2 text-[11px] text-ink-3">
                    <Flame size={11} className="text-terra" />
                    <span className="font-semibold text-ink">{entry.currentStreak}</span> streak
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Full list */}
          {isLoading ? (
            <div className="v3-card px-5 py-10 text-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo mx-auto" /></div>
          ) : entries.length === 0 ? (
            <div className="v3-card px-5 py-10 text-center"><Trophy size={24} className="mx-auto mb-3 text-ink-4" /><p className="text-[13px] text-ink-3 font-medium">No leaderboard data yet</p></div>
          ) : (
            <div className="v3-card overflow-hidden">
              {entries.map((entry: any, i: number) => (
                <div key={entry.employee.id} style={i < entries.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}}>
                  <div className="px-5 py-3.5 flex items-center gap-4 v3-row">
                    <span className={`font-num text-[18px] font-semibold w-7 text-center shrink-0 ${entry.rank <= 3 ? "text-indigo" : "text-ink-4"}`}>{entry.rank}</span>
                    <div className="h-8 w-8 rounded-full grid place-items-center text-white text-[11px] font-bold shrink-0"
                         style={{ background: avatarGrad(entry.employee.name) }}>
                      {entry.employee.name?.[0]?.toUpperCase() || "?"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13.5px] font-semibold text-ink">{entry.employee.name}</p>
                      <p className="text-[11px] text-ink-3 font-medium">{entry.employee.email}</p>
                    </div>
                    <div className="flex items-center gap-5 shrink-0 text-right">
                      <div className="flex items-center gap-1 text-[12px]">
                        <Flame size={12} className="text-terra" />
                        <span className="font-bold text-ink">{entry.currentStreak}</span>
                        <span className="text-ink-4">streak</span>
                      </div>
                      <div><p className="text-[12px] font-bold text-ink">{entry.totalLinks}</p><p className="text-[10px] text-ink-4">links</p></div>
                      <div><p className="text-[14px] font-bold text-indigo">{entry.totalReports}</p><p className="text-[10px] text-ink-4">reports</p></div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
