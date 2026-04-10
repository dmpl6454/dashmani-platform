"use client";
import { useState, useEffect } from "react";
import useSWR from "swr";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { useHrAuth } from "@/lib/auth";
import { useAssignedAccounts } from "@/lib/hooks/use-accounts";
import { useTodayReport } from "@/lib/hooks/use-reports";
import {
  TrendingUp, FileText, CheckCircle, Clock, ArrowRight, ExternalLink,
  CalendarCheck, Sparkles, Sun, Moon, Sunset, ChevronRight, AlertCircle
} from "lucide-react";

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "bg-gradient-to-br from-pink-50 to-purple-50 border-pink-100 text-pink-700",
  twitter: "bg-gradient-to-br from-sky-50 to-blue-50 border-sky-100 text-sky-700",
  x: "bg-gradient-to-br from-sky-50 to-blue-50 border-sky-100 text-sky-700",
  linkedin: "bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-100 text-blue-700",
  facebook: "bg-gradient-to-br from-blue-50 to-blue-50 border-blue-100 text-blue-600",
  youtube: "bg-gradient-to-br from-red-50 to-orange-50 border-red-100 text-red-600",
  google: "bg-gradient-to-br from-green-50 to-emerald-50 border-green-100 text-green-700",
  snapchat: "bg-gradient-to-br from-yellow-50 to-amber-50 border-yellow-100 text-yellow-700",
};

const PLATFORM_BADGE: Record<string, string> = {
  instagram: "bg-pink-50 text-pink-600",
  twitter: "bg-sky-50 text-sky-600",
  x: "bg-sky-50 text-sky-600",
  linkedin: "bg-blue-50 text-blue-600",
  facebook: "bg-blue-50 text-blue-600",
  youtube: "bg-red-50 text-red-600",
  google: "bg-green-50 text-green-600",
  snapchat: "bg-yellow-50 text-yellow-600",
};

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return { text: "Good Morning", icon: Sun };
  if (h < 17) return { text: "Good Afternoon", icon: Sunset };
  return { text: "Good Evening", icon: Moon };
}

const TIPS = [
  "Consistency beats perfection. Show up every day.",
  "Engage with your audience before posting.",
  "Analytics tell you what works -- double down on it.",
  "Batch your content creation for a smoother week.",
  "Quality captions drive more saves and shares.",
  "Post at peak hours for maximum reach.",
  "Use trending audio to boost reel performance.",
];

export default function DashboardPage() {
  const { user } = useHrAuth();
  const { data: accountsData } = useAssignedAccounts();
  const { data: reportData } = useTodayReport();
  const { data: attendanceData } = useSWR("/hr/attendance", (url: string) => apiFetch<any>(url).catch(() => null));

  const accounts = accountsData?.data || [];
  const todayReport = reportData?.data || null;
  const attendance = attendanceData?.data;
  const todayLinks = todayReport?.links || [];
  const submitted = !!todayReport;

  const greeting = getGreeting();
  const GreetIcon = greeting.icon;
  const firstName = user?.name?.split(" ")[0] || "there";
  const today = new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const accountCount = accounts.length;
  const linkCount = todayLinks.length;
  const attendanceRate = attendance?.rate;
  const attendanceDays = attendance ? `${attendance.present}/${attendance.totalWorkdays}` : null;

  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);

  return (
    <div className="space-y-8 crx-animate-fade">
      {/* Welcome Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-[#B0B0B0] text-sm mb-1">
            <GreetIcon className="h-4 w-4 text-[#F5D547]" />
            <span>{greeting.text}</span>
          </div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">
            Welcome back, <span className="font-normal">{firstName}</span>
          </h1>
          <p className="text-sm text-[#7A7A7A] mt-1">{today}</p>
          <div className="flex items-center gap-2 mt-3 text-xs text-[#B0B0B0]">
            <Sparkles className="h-3.5 w-3.5 text-[#F5D547]" />
            <span className="italic">{tip}</span>
          </div>
        </div>
        {!submitted && (
          <Link href="/report" className="hidden md:flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#1A1A1A] text-white text-sm font-semibold hover:bg-[#2B2B2B] transition-all shadow-lg hover:shadow-xl">
            <FileText className="h-4 w-4" />
            Submit Report
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Accounts */}
        <div className="crx-animate-slide bg-gradient-to-br from-white to-[#FEFCF7] rounded-2xl border border-[#E8E0D0] p-5 hover:shadow-[0_4px_24px_rgba(0,0,0,0.06)] transition-all group backdrop-blur-sm" style={{ animationDelay: "0.05s", animationFillMode: "both" }}>
          <div className="flex items-center justify-between mb-3">
            <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center shadow-[0_2px_8px_rgba(245,213,71,0.2)] group-hover:shadow-[0_4px_12px_rgba(245,213,71,0.3)] transition-shadow">
              <TrendingUp className="h-5 w-5 text-[#B8960C]" />
            </div>
          </div>
          <p className="font-serif text-3xl font-light text-[#1A1A1A]">{accountCount}</p>
          <p className="text-xs text-[#7A7A7A] mt-0.5">Accounts Assigned</p>
        </div>

        {/* Links */}
        <div className="crx-animate-slide bg-gradient-to-br from-white to-[#F8FAFF] rounded-2xl border border-[#E8E0D0] p-5 hover:shadow-[0_4px_24px_rgba(0,0,0,0.06)] transition-all group backdrop-blur-sm" style={{ animationDelay: "0.1s", animationFillMode: "both" }}>
          <div className="flex items-center justify-between mb-3">
            <div className="h-10 w-10 rounded-xl bg-blue-50 flex items-center justify-center shadow-[0_2px_8px_rgba(59,130,246,0.15)] group-hover:shadow-[0_4px_12px_rgba(59,130,246,0.25)] transition-shadow">
              <FileText className="h-5 w-5 text-blue-600" />
            </div>
          </div>
          <p className="font-serif text-3xl font-light text-[#1A1A1A]">{linkCount}</p>
          <p className="text-xs text-[#7A7A7A] mt-0.5">Links Today</p>
        </div>

        {/* Status */}
        <div className={`crx-animate-slide rounded-2xl border p-5 transition-all backdrop-blur-sm ${submitted ? "bg-gradient-to-br from-green-50/60 to-emerald-50/40 border-green-100" : "bg-gradient-to-br from-orange-50/60 to-amber-50/40 border-orange-100"}`} style={{ animationDelay: "0.15s", animationFillMode: "both" }}>
          <div className="flex items-center justify-between mb-3">
            <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${submitted ? "bg-green-100 shadow-[0_2px_8px_rgba(107,203,119,0.2)]" : "bg-orange-100 shadow-[0_2px_8px_rgba(245,166,35,0.2)]"}`}>
              {submitted ? <CheckCircle className="h-5 w-5 text-green-600" /> : <AlertCircle className="h-5 w-5 text-orange-600" />}
            </div>
          </div>
          <p className={`font-serif text-3xl font-light ${submitted ? "text-green-700" : "text-orange-700"}`}>{submitted ? "Done" : "Pending"}</p>
          <p className="text-xs text-[#7A7A7A] mt-0.5">Today&apos;s Report</p>
        </div>

        {/* Attendance */}
        <div className="crx-animate-slide bg-gradient-to-br from-white to-[#F5FFF8] rounded-2xl border border-[#E8E0D0] p-5 hover:shadow-[0_4px_24px_rgba(0,0,0,0.06)] transition-all group backdrop-blur-sm" style={{ animationDelay: "0.2s", animationFillMode: "both" }}>
          <div className="flex items-center justify-between mb-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-50 flex items-center justify-center shadow-[0_2px_8px_rgba(16,185,129,0.15)] group-hover:shadow-[0_4px_12px_rgba(16,185,129,0.25)] transition-shadow">
              <CalendarCheck className="h-5 w-5 text-emerald-600" />
            </div>
          </div>
          <p className="font-serif text-3xl font-light text-[#1A1A1A]">{attendanceRate ?? "\u2014"}%</p>
          <p className="text-xs text-[#7A7A7A] mt-0.5">{attendanceDays ? `${attendanceDays} days` : "Attendance"}</p>
        </div>
      </div>

      {/* Quick Action - Only show if not submitted */}
      {!submitted && (
        <Link href="/report" className="crx-animate-slide group block" style={{ animationDelay: "0.25s", animationFillMode: "both" }}>
          <div className="relative rounded-2xl bg-[#1A1A1A] p-6 overflow-hidden hover:shadow-[0_8px_32px_rgba(0,0,0,0.2)] transition-all">
            {/* Ambient glow */}
            <div className="absolute top-0 right-0 w-48 h-48 rounded-full bg-[#F5D547]/10 blur-[60px]" />
            <div className="absolute bottom-0 left-0 w-32 h-32 rounded-full bg-[#F5D547]/5 blur-[40px]" />
            {/* Shine animation */}
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
            <div className="relative flex items-center justify-between">
              <div>
                <p className="text-[#F5D547] text-xs font-semibold uppercase tracking-wider mb-1">Action Required</p>
                <p className="text-white text-lg font-semibold">Submit your daily report</p>
                <p className="text-white/50 text-sm mt-1">Don&apos;t forget to log your work today</p>
              </div>
              <div className="h-12 w-12 rounded-xl bg-[#F5D547] flex items-center justify-center group-hover:scale-110 transition-transform shadow-[0_4px_16px_rgba(245,213,71,0.3)]">
                <ArrowRight className="h-5 w-5 text-[#1A1A1A]" />
              </div>
            </div>
          </div>
        </Link>
      )}

      {/* Submitted success banner */}
      {submitted && (
        <div className="crx-animate-slide rounded-2xl bg-gradient-to-r from-green-50 to-emerald-50/50 border border-green-100 p-5 flex items-center gap-4" style={{ animationDelay: "0.25s", animationFillMode: "both" }}>
          <div className="h-11 w-11 rounded-xl bg-green-100 flex items-center justify-center shadow-[0_2px_8px_rgba(107,203,119,0.2)]">
            <CheckCircle className="h-5 w-5 text-green-600" />
          </div>
          <div className="flex-1">
            <p className="text-green-800 font-semibold text-sm">Report submitted for today</p>
            <p className="text-green-600/70 text-xs mt-0.5">Great work! Keep the streak going.</p>
          </div>
          <Link href="/report" className="text-xs text-green-700 font-medium hover:text-green-900 flex items-center gap-1 transition-colors">
            View / Edit
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}

      {/* Assigned Accounts */}
      {accounts.length > 0 && (
        <div className="crx-animate-slide" style={{ animationDelay: "0.3s", animationFillMode: "both" }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-[#1A1A1A]">Your Accounts</h2>
            <span className="text-xs text-[#B0B0B0]">{accounts.length} assigned</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {accounts.map((acc: any) => {
              const platformClass = PLATFORM_COLORS[(acc.platform || "").toLowerCase()] || "bg-gradient-to-br from-gray-50 to-gray-50 border-gray-100 text-gray-600";
              return (
                <div key={acc.id} className={`rounded-xl border p-4 hover:shadow-[0_4px_16px_rgba(0,0,0,0.06)] hover:-translate-y-0.5 transition-all duration-200 ${platformClass}`}>
                  <div className="flex items-center justify-between">
                    <div className="min-w-0">
                      <p className="font-semibold text-[#1A1A1A] text-sm truncate">{acc.handle || acc.name || acc.displayName}</p>
                      <p className="text-xs opacity-70 capitalize">{acc.platform}</p>
                    </div>
                    {acc.url && (
                      <a href={acc.url} target="_blank" rel="noopener noreferrer" className="shrink-0 h-8 w-8 rounded-lg bg-white/60 flex items-center justify-center hover:bg-white transition-colors">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>
                  {acc.followerCount != null && (
                    <p className="text-xs mt-2 font-medium">{acc.followerCount.toLocaleString()} followers</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {accounts.length === 0 && (
        <div className="crx-animate-slide text-center py-10" style={{ animationDelay: "0.3s", animationFillMode: "both" }}>
          <p className="text-[#B0B0B0] text-sm">No accounts assigned yet.</p>
        </div>
      )}

      {/* Today's Report Summary */}
      {submitted && todayLinks.length > 0 && (
        <div className="crx-animate-slide bg-white rounded-2xl border border-[#E8E0D0] p-6 shadow-[0_2px_16px_rgba(0,0,0,0.04)]" style={{ animationDelay: "0.35s", animationFillMode: "both" }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-green-50 flex items-center justify-center">
                <CheckCircle className="h-4 w-4 text-green-600" />
              </div>
              <h2 className="text-lg font-semibold text-[#1A1A1A]">Today&apos;s Report</h2>
            </div>
            <span className="px-3 py-1 rounded-full bg-green-50 text-green-700 text-xs font-medium">Submitted</span>
          </div>
          <div className="space-y-2">
            {todayLinks.map((link: any, i: number) => {
              const platform = (link.account?.platform || link.platform || "").toLowerCase();
              const badgeClass = PLATFORM_BADGE[platform] || "bg-gray-50 text-gray-600";
              return (
                <div key={i} className="flex items-center gap-3 py-2 border-b border-[#F0EAD8] last:border-0">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase ${badgeClass}`}>
                    {platform || "\u2014"}
                  </span>
                  <span className="text-sm text-[#7A7A7A] truncate flex-1">{link.account?.handle || link.account?.name || link.account?.displayName}</span>
                  <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:text-blue-700 truncate max-w-[200px]">
                    {link.url}
                  </a>
                </div>
              );
            })}
          </div>
          {todayReport?.notes && (
            <div className="mt-3 p-3 rounded-xl bg-[#FFF8E1] text-sm text-[#7A7A7A]">
              <p className="text-xs font-medium text-[#B8960C] mb-1">Notes</p>
              {todayReport.notes}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
