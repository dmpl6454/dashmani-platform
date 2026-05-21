"use client";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { Users, Check, X } from "lucide-react";
import { Topstrip } from "@/components/portal-shell";

export default function TeamPage() {
  const { data, isLoading } = useSWR("/hr/team", (url) => apiFetch(url));
  const dashboard = (data as any)?.data;
  const members: any[] = dashboard?.members ?? [];

  return (
    <>
      <Topstrip title="My Team" sub={dashboard?.teamName} />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px]">
        <div className="space-y-4 anim-fade-up d1">

          {isLoading ? (
            <div className="v3-card px-5 py-10 text-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo mx-auto" /></div>
          ) : !dashboard?.teamName ? (
            <div className="v3-card px-5 py-10 text-center"><Users size={24} className="mx-auto mb-3 text-ink-4" /><p className="text-[13px] text-ink-3 font-medium">You are not assigned to any team</p></div>
          ) : (
            <>
              {/* Stats */}
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: "Team Name",              value: dashboard.teamName,                                                              color: "text-indigo"  },
                  { label: "Members",                value: dashboard.memberCount,                                                           color: "text-ink"     },
                  { label: "Today's Submission Rate", value: `${dashboard.submissionRate ?? 0}%`,                                            color: dashboard.submissionRate >= 70 ? "text-success" : "text-attention" },
                ].map(s => (
                  <div key={s.label} className="v3-card p-4 text-center">
                    <div className={`font-display text-[24px] font-semibold ${s.color}`}>{s.value}</div>
                    <div className="text-[11.5px] text-ink-3 font-medium mt-0.5">{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Members table */}
              <div className="v3-card overflow-hidden">
                <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                  <h3 className="text-[14px] font-bold text-ink">Team Members</h3>
                </div>
                {members.length === 0 ? (
                  <div className="px-5 py-8 text-center"><p className="text-[13px] text-ink-3 font-medium">No members found</p></div>
                ) : (
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                        {["Name","Email","Today","Weekly","Links"].map(h => (
                          <th key={h} className="text-left px-5 py-3 text-[11px] font-bold text-ink-3 uppercase tracking-wider">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((m: any, i: number) => (
                        <tr key={m.id} className="v3-row" style={i < members.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.05)" } : {}}>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2.5">
                              <div className="h-7 w-7 rounded-full bg-indigo-soft text-indigo grid place-items-center text-[11px] font-bold shrink-0">
                                {m.name?.[0]?.toUpperCase() || "?"}
                              </div>
                              <span className="font-semibold text-ink">{m.name}</span>
                            </div>
                          </td>
                          <td className="px-5 py-3.5 text-ink-3 font-medium">{m.email}</td>
                          <td className="px-5 py-3.5">
                            {m.submittedToday
                              ? <Check size={16} strokeWidth={2.5} className="text-success" />
                              : <X size={16} strokeWidth={2.5} className="text-danger" />}
                          </td>
                          <td className="px-5 py-3.5 font-medium text-ink">{m.weeklyReports}<span className="text-ink-4">/7</span></td>
                          <td className="px-5 py-3.5 font-medium text-ink">{m.totalLinks}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
