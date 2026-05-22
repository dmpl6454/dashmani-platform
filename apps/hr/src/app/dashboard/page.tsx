"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { useHrAuth } from "@/lib/auth";
import { useAssignedAccounts } from "@/lib/hooks/use-accounts";
import { useTodayReport } from "@/lib/hooks/use-reports";
import { Topstrip } from "@/components/portal-shell";
import { ArrowRight, Check, Edit2, ChevronRight } from "lucide-react";

const PLATFORM_COLORS: Record<string, { bg: string; text: string; border: string; label: string }> = {
  instagram: { bg: "bg-pink-50",  text: "text-pink-700",  border: "border-pink-200",  label: "Instagram" },
  linkedin:  { bg: "bg-blue-50",  text: "text-blue-700",  border: "border-blue-200",  label: "LinkedIn"  },
  twitter:   { bg: "bg-sky-50",   text: "text-sky-600",   border: "border-sky-200",   label: "Twitter/X" },
  x:         { bg: "bg-sky-50",   text: "text-sky-600",   border: "border-sky-200",   label: "Twitter/X" },
  youtube:   { bg: "bg-red-50",   text: "text-red-600",   border: "border-red-200",   label: "YouTube"   },
  facebook:  { bg: "bg-blue-50",  text: "text-blue-600",  border: "border-blue-200",  label: "Facebook"  },
  snapchat:  { bg: "bg-yellow-50",text: "text-yellow-700",border: "border-yellow-200",label: "Snapchat"  },
  google:    { bg: "bg-green-50", text: "text-green-700", border: "border-green-200", label: "Google"    },
};
function platCfg(p: string) {
  return PLATFORM_COLORS[p?.toLowerCase()] ?? { bg: "bg-muted", text: "text-ink-3", border: "border-ink/10", label: p || "—" };
}

const TIPS = [
  "Consistency beats perfection — show up every day.",
  "Quality captions drive more saves and shares.",
  "Engage with your audience before posting.",
  "Post at peak hours for maximum reach.",
  "Batch your content creation for a smoother week.",
];

export default function DashboardPage() {
  const { user } = useHrAuth();
  const { data: accountsData } = useAssignedAccounts();
  const { data: reportData } = useTodayReport();
  const { data: attendanceData } = useSWR("/hr/attendance", (url: string) => apiFetch<any>(url).catch(() => null));

  const accounts = accountsData?.data ?? [];
  const todayReport = reportData?.data ?? null;
  const attendanceRaw = attendanceData?.data;
  const isEmployee = attendanceRaw?.isEmployee !== false; // false only for admin-only accounts
  const attendance = isEmployee ? attendanceRaw : null;
  const todayLinks = todayReport?.links ?? [];
  const submitted = !!todayReport;

  const firstName = user?.name?.split(" ")[0] ?? "there";
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const attendanceRate = attendance?.rate;
  const attendanceDays = attendance ? `${attendance.present}/${attendance.totalWorkdays} days` : null;

  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);

  const accentMap: Record<string, string> = {
    action:    "bg-action-soft text-ink-2",
    success:   "bg-success-bg text-success",
    attention: "bg-attention-bg text-attention",
    sage:      "bg-sage-soft text-sage",
  };

  const baseStats = [
    { label: "Accounts Assigned", value: accounts.length,                   sub: "active",                      accent: "action",    icon: "📊" },
    { label: "Links Today",       value: submitted ? todayLinks.length : 0, sub: submitted ? "submitted" : "pending", accent: submitted ? "success" : "attention", icon: "🔗" },
    { label: "Today's Report",    value: submitted ? "Done" : "Pending",    sub: submitted ? "submitted" : "not yet",  accent: submitted ? "success" : "attention", icon: "📝" },
  ];
  const attendanceStat = isEmployee
    ? [{ label: "Attendance", value: attendanceRate != null ? `${attendanceRate}%` : "—",
         sub: attendanceDays ?? "this month", accent: "sage", icon: "📅" }]
    : [];
  const stats = [...baseStats, ...attendanceStat];

  return (
    <>
      <Topstrip
        title="Dashboard"
        sub={today}
        right={
          !submitted ? (
            <Link href="/report"
              className="btn-3d inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-ink text-white text-[13px] font-semibold"
              style={{ border: "2px solid #1A1A1A" }}>
              <Edit2 size={14} />
              Submit Report
            </Link>
          ) : undefined
        }
      />

      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[1280px] mx-auto w-full">
        <div className="space-y-5">

          {/* Welcome */}
          <div className="anim-fade-up d1">
            <h2 className="font-display text-[28px] font-semibold text-ink leading-tight">
              Welcome back, {firstName} 👋
            </h2>
            <p className="text-[13px] text-ink-3 mt-1 font-medium italic">"{tip}"</p>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {stats.map((s, i) => (
              <div key={i} className={`anim-fade-up d${i + 2}`}>
                <div className="v3-card v3-card-lift p-5 flex flex-col gap-3">
                  <div className={`h-9 w-9 rounded-xl grid place-items-center text-lg ${accentMap[s.accent]}`}>
                    {s.icon}
                  </div>
                  <div>
                    <div className="font-display text-[28px] font-semibold leading-none text-ink">{s.value}</div>
                    <div className="text-[12.5px] font-semibold text-ink mt-1">{s.label}</div>
                    <div className="text-[11px] text-ink-3 font-medium mt-0.5">{s.sub}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* CTA / Success banner */}
          {!submitted ? (
            <div className="anim-fade-up d6">
              <Link href="/report"
                className="group w-full v3-card text-white p-6 flex items-center justify-between overflow-hidden relative hover:shadow-[6px_6px_0_rgba(93,95,239,0.22)] transition-all block"
                style={{ background: '#1A1A1A' }}>
                <div className="absolute top-0 right-0 w-48 h-48 rounded-full bg-action/10 blur-[60px]" />
                <div className="relative">
                  <p className="text-action text-[11px] font-bold uppercase tracking-wider mb-1">Action Required</p>
                  <p className="text-white text-[17px] font-bold">Submit your daily report</p>
                  <p className="text-white/50 text-[13px] mt-0.5">Don&apos;t forget to log your work for today</p>
                </div>
                <div className="relative h-11 w-11 rounded-xl bg-action grid place-items-center group-hover:scale-110 transition-transform shrink-0">
                  <ArrowRight size={18} className="text-ink" />
                </div>
              </Link>
            </div>
          ) : (
            <div className="anim-fade-up d6">
              <div className="v3-card-sm border bg-success-bg border-success/20 p-5 flex items-center gap-4">
                <div className="h-10 w-10 rounded-xl bg-success/15 grid place-items-center shrink-0">
                  <Check size={18} strokeWidth={2.5} className="text-success" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[14px] font-bold text-success">Report submitted for today</p>
                  <p className="text-[12px] text-success/70 mt-0.5 font-medium">
                    {todayLinks.length} link{todayLinks.length !== 1 ? "s" : ""} submitted · Great work!
                  </p>
                </div>
                <Link href="/report" className="text-[12.5px] text-success font-semibold flex items-center gap-1 hover:underline shrink-0">
                  View / Edit <ChevronRight size={13} />
                </Link>
              </div>
            </div>
          )}

          {/* Accounts + Tasks row */}
          <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
            {/* Accounts */}
            <div className="anim-fade-up d7">
              <div className="v3-card overflow-hidden">
                <div className="px-5 h-12 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                  <h3 className="text-[14px] font-bold text-ink">Your Accounts</h3>
                  <span className="text-[11px] text-ink-3 font-medium">{accounts.length} assigned</span>
                </div>
                {accounts.length === 0 ? (
                  <div className="px-5 py-8 text-center">
                    <p className="text-[13px] text-ink-3 font-medium">No accounts assigned yet.</p>
                  </div>
                ) : (
                  <div className="p-4 grid grid-cols-2 gap-3">
                    {accounts.map((acc: any) => {
                      const pc = platCfg(acc.platform || "");
                      return (
                        <div key={acc.id} className={`v3-card-sm border p-3 ${pc.border}`}>
                          <div className="flex items-center justify-between gap-2 mb-1.5">
                            <span className={`h-5 px-2 rounded-full text-[10px] font-bold inline-flex items-center ${pc.bg} ${pc.text}`}>
                              {pc.label}
                            </span>
                          </div>
                          <p className="text-[12.5px] font-bold text-ink truncate">{acc.handle || acc.name || acc.displayName}</p>
                          {acc.followerCount != null && (
                            <p className="text-[11px] text-ink-3 mt-0.5">{acc.followerCount.toLocaleString("en-IN")} followers</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Today's submitted links preview */}
            <div className="anim-fade-up d8 space-y-3">
              {submitted && todayLinks.length > 0 && (
                <div className="v3-card overflow-hidden">
                  <div className="px-5 h-12 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                    <h3 className="text-[14px] font-bold text-ink">Today&apos;s Report</h3>
                    <Link href="/report" className="text-[12.5px] text-indigo font-semibold hover:underline flex items-center gap-1">
                      View all <ArrowRight size={12} />
                    </Link>
                  </div>
                  <ul>
                    {todayLinks.slice(0, 4).map((lk: any, i: number, arr: any[]) => {
                      const platform = (lk.platformSlug || lk.platform || "").toLowerCase();
                      const pc = platCfg(platform);
                      return (
                        <li key={i} style={i < arr.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}}>
                          <div className="px-5 py-3 flex items-center gap-3 v3-row">
                            <span className={`h-5 px-2 rounded-full text-[10px] font-bold inline-flex items-center shrink-0 ${pc.bg} ${pc.text}`}>{pc.label}</span>
                            <span className="flex-1 text-[12.5px] font-medium text-ink-2 truncate">
                              {lk.accountHandle || lk.accountName || "—"}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {todayReport?.notes && (
                    <div className="px-5 py-3 bg-muted/30" style={{ borderTop: "1px solid rgba(26,26,26,0.06)" }}>
                      <p className="text-[12px] text-ink-3 font-medium italic">"{todayReport.notes}"</p>
                    </div>
                  )}
                </div>
              )}

              {/* Attendance mini-card */}
              {attendance && (
                <div className="v3-card p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-[13.5px] font-bold text-ink">Attendance</h3>
                    {attendanceRate != null && (
                      <span className="text-[11px] font-bold text-success">{attendanceRate}%</span>
                    )}
                  </div>
                  {attendance.thisMonth && (
                    <>
                      <div className="flex gap-1 flex-wrap">
                        {attendance.thisMonth.map((d: any) => {
                          const cls = d.s === "P" ? "bg-success/80" : d.s === "WE" ? "bg-muted" : d.s === "WFH" ? "bg-indigo/60" : "bg-attention/60";
                          return <div key={d.d} className={`h-5 w-5 rounded-md ${cls}`} title={`${d.d}: ${d.s}`} />;
                        })}
                      </div>
                      <div className="flex gap-3 mt-2">
                        {[{ l: "Present", c: "bg-success/80" }, { l: "WFH", c: "bg-indigo/60" }, { l: "Weekend", c: "bg-muted" }].map(x => (
                          <span key={x.l} className="flex items-center gap-1 text-[10px] text-ink-3 font-medium">
                            <span className={`h-2 w-2 rounded-sm ${x.c}`} />{x.l}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                  {!attendance.thisMonth && (
                    <p className="text-[12px] text-ink-3 font-medium">{attendanceDays ?? "No data"}</p>
                  )}
                </div>
              )}

              {isEmployee && !attendance && !submitted && (
                <div className="v3-card p-4 text-center">
                  <p className="text-[12px] text-ink-3">No attendance data available.</p>
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
