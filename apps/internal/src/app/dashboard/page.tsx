"use client";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useOverviewStats } from "@/lib/hooks/use-analytics";
import {
  Users, Building2, Clock, CheckCircle, FolderOpen, FileCheck, Send,
  UserPlus, AlertTriangle, ArrowRight, Sun, Sunset, Moon,
} from "lucide-react";

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return { text: "Good Morning", Icon: Sun };
  if (h < 17) return { text: "Good Afternoon", Icon: Sunset };
  return { text: "Good Evening", Icon: Moon };
}

const statCards = [
  { key: "totalEmployees", label: "Total Employees", icon: Users, color: "bg-blue-50 shadow-[0_2px_8px_rgba(59,130,246,0.12)]", iconColor: "text-blue-600", sub: "across all teams" },
  { key: "activeTeams", label: "Active Teams", icon: Building2, color: "bg-purple-50 shadow-[0_2px_8px_rgba(147,51,234,0.12)]", iconColor: "text-purple-600", sub: "currently active" },
  { key: "presentToday", label: "Present Today", icon: Clock, color: "bg-emerald-50 shadow-[0_2px_8px_rgba(16,185,129,0.12)]", iconColor: "text-emerald-600", sub: "checked in" },
  { key: "tasksCompletedThisMonth", label: "Tasks Completed", icon: CheckCircle, color: "bg-green-50 shadow-[0_2px_8px_rgba(34,197,94,0.12)]", iconColor: "text-green-600", sub: "this month" },
  { key: "activeProjects", label: "Active Projects", icon: FolderOpen, color: "bg-amber-50 shadow-[0_2px_8px_rgba(245,158,11,0.12)]", iconColor: "text-amber-600", sub: "in progress" },
  { key: "pendingApprovals", label: "Pending Approvals", icon: FileCheck, color: "bg-orange-50 shadow-[0_2px_8px_rgba(249,115,22,0.12)]", iconColor: "text-orange-600", sub: "awaiting review" },
  { key: "contentPublishedThisMonth", label: "Content Published", icon: Send, color: "bg-sky-50 shadow-[0_2px_8px_rgba(14,165,233,0.12)]", iconColor: "text-sky-600", sub: "this month" },
  { key: "pendingEmployees", label: "Pending Employees", icon: UserPlus, color: "bg-pink-50 shadow-[0_2px_8px_rgba(236,72,153,0.12)]", iconColor: "text-pink-600", sub: "need approval" },
];

export default function DashboardPage() {
  const { user } = useAuth();
  const { data, isLoading } = useOverviewStats();
  const stats = (data as any)?.data || {};
  const greeting = getGreeting();
  const firstName = user?.name?.split(" ")[0] || "";
  const pendingEmployees = stats?.pendingEmployees ?? 0;

  return (
    <div className="space-y-8 crx-animate-fade">
      {/* Welcome */}
      <div>
        <div className="flex items-center gap-2 text-[#B0B0B0] text-sm mb-1">
          <greeting.Icon className="h-4 w-4 text-[#F5D547]" />
          <span>{greeting.text}</span>
        </div>
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">
          Welcome back, <span className="font-normal">{firstName}</span>
        </h1>
        <p className="text-sm text-[#7A7A7A] mt-1">Here&apos;s your organization overview</p>
      </div>

      {/* Pending Alert */}
      {!isLoading && pendingEmployees > 0 && (
        <div className="crx-animate-slide crx-delay-1 relative overflow-hidden rounded-2xl bg-gradient-to-r from-[#FFF8E1] to-[#FFF3C4] border border-[#F5D547]/30 p-5">
          <div className="absolute top-0 right-0 w-32 h-32 bg-[#F5D547]/10 rounded-full blur-[40px]" />
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-[#F5D547] flex items-center justify-center animate-pulse">
                <AlertTriangle className="h-5 w-5 text-[#1A1A1A]" />
              </div>
              <div>
                <p className="font-semibold text-[#1A1A1A]">
                  {pendingEmployees} employee{pendingEmployees !== 1 ? "s" : ""} pending approval
                </p>
                <p className="text-xs text-[#7A7A7A]">Review and approve new team members</p>
              </div>
            </div>
            <Link
              href="/employees/pending"
              className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#1A1A1A] text-white text-sm font-semibold hover:bg-[#2B2B2B] transition-all duration-300 shadow-md"
            >
              Review <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card, i) => {
          const Icon = card.icon;
          const value = stats[card.key];
          return (
            <div
              key={card.key}
              className={`crx-animate-slide crx-delay-${Math.min(i + 1, 6)} bg-white rounded-2xl border border-[#E8E0D0] p-5 hover:shadow-[0_8px_32px_rgba(0,0,0,0.06)] hover:-translate-y-0.5 transition-all duration-300`}
            >
              <div className="flex items-center justify-between mb-3">
                <div className={`h-10 w-10 rounded-xl ${card.color} flex items-center justify-center`}>
                  <Icon className={`h-5 w-5 ${card.iconColor}`} />
                </div>
              </div>
              <p className="font-serif text-3xl font-light text-[#1A1A1A]">
                {isLoading ? "\u2014" : (value ?? 0)}
              </p>
              <p className="text-xs text-[#7A7A7A] mt-0.5">{card.label}</p>
              <p className="text-[10px] text-[#B0B0B0] mt-0.5">{card.sub}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
