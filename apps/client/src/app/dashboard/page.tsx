"use client";
import useSWR from "swr";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  FolderOpen, CheckSquare, Clock, TrendingUp, ArrowRight,
  Sun, Sunset, Moon, AlertCircle, ChevronRight
} from "lucide-react";

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return { text: "Good Morning", Icon: Sun };
  if (h < 17) return { text: "Good Afternoon", Icon: Sunset };
  return { text: "Good Evening", Icon: Moon };
}

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: "bg-green-50 text-green-700 border-green-200",
  COMPLETED: "bg-blue-50 text-blue-700 border-blue-200",
  PAUSED: "bg-amber-50 text-amber-700 border-amber-200",
  ARCHIVED: "bg-gray-50 text-gray-500 border-gray-200",
};

export default function DashboardPage() {
  const { user } = useAuth();
  const { data, isLoading } = useSWR("/client/dashboard", (u: string) => apiFetch<any>(u));
  const d = data?.data || {};
  const greeting = getGreeting();
  const firstName = user?.name?.split(" ")[0] || user?.companyName || "there";

  return (
    <div className="space-y-8 crx-animate-fade">
      {/* Welcome */}
      <div>
        <div className="flex items-center gap-2 text-[#B0B0B0] text-sm mb-1">
          <greeting.Icon className="h-4 w-4 text-[#F5D547]" />
          <span>{greeting.text}</span>
        </div>
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">
          Welcome, <span className="font-normal">{firstName}</span>
        </h1>
        <p className="text-sm text-[#7A7A7A] mt-1">Here&apos;s your project overview</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="crx-animate-slide crx-delay-1 bg-white rounded-2xl border border-[#E8E0D0] p-5 hover:shadow-[0_4px_24px_rgba(0,0,0,0.06)] transition-all">
          <div className="h-10 w-10 rounded-xl bg-amber-50 shadow-[0_2px_8px_rgba(245,158,11,0.12)] flex items-center justify-center mb-3">
            <FolderOpen className="h-5 w-5 text-amber-600" />
          </div>
          <p className="font-serif text-3xl font-light text-[#1A1A1A]">{isLoading ? "\u2014" : d.activeProjects ?? 0}</p>
          <p className="text-xs text-[#7A7A7A] mt-0.5">Active Projects</p>
        </div>

        <div className="crx-animate-slide crx-delay-2 bg-white rounded-2xl border border-[#E8E0D0] p-5 hover:shadow-[0_4px_24px_rgba(0,0,0,0.06)] transition-all">
          <div className="h-10 w-10 rounded-xl bg-orange-50 shadow-[0_2px_8px_rgba(249,115,22,0.12)] flex items-center justify-center mb-3">
            <CheckSquare className="h-5 w-5 text-orange-600" />
          </div>
          <p className="font-serif text-3xl font-light text-[#1A1A1A]">{isLoading ? "\u2014" : d.pendingApprovals ?? 0}</p>
          <p className="text-xs text-[#7A7A7A] mt-0.5">Pending Approvals</p>
        </div>

        <div className="crx-animate-slide crx-delay-3 bg-white rounded-2xl border border-[#E8E0D0] p-5 hover:shadow-[0_4px_24px_rgba(0,0,0,0.06)] transition-all">
          <div className="h-10 w-10 rounded-xl bg-sky-50 shadow-[0_2px_8px_rgba(14,165,233,0.12)] flex items-center justify-center mb-3">
            <Clock className="h-5 w-5 text-sky-600" />
          </div>
          <p className="font-serif text-3xl font-light text-[#1A1A1A]">{isLoading ? "\u2014" : d.clientStatus ?? "Active"}</p>
          <p className="text-xs text-[#7A7A7A] mt-0.5">Account Status</p>
        </div>

        <div className="crx-animate-slide crx-delay-4 bg-white rounded-2xl border border-[#E8E0D0] p-5 hover:shadow-[0_4px_24px_rgba(0,0,0,0.06)] transition-all">
          <div className="h-10 w-10 rounded-xl bg-emerald-50 shadow-[0_2px_8px_rgba(16,185,129,0.12)] flex items-center justify-center mb-3">
            <TrendingUp className="h-5 w-5 text-emerald-600" />
          </div>
          <p className="font-serif text-3xl font-light text-[#1A1A1A]">{isLoading ? "\u2014" : d.overallHealth ?? "Good"}</p>
          <p className="text-xs text-[#7A7A7A] mt-0.5">Overall Health</p>
        </div>
      </div>

      {/* Pending Approvals */}
      {d.pendingApprovals > 0 && d.recentApprovals?.length > 0 && (
        <div className="crx-animate-slide crx-delay-5">
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-[#FFF8E1] to-[#FFF3C4] border border-[#F5D547]/30 p-5">
            <div className="absolute top-0 right-0 w-32 h-32 bg-[#F5D547]/10 rounded-full blur-[40px]" />
            <div className="relative">
              <div className="flex items-center gap-2 mb-3">
                <AlertCircle className="h-4 w-4 text-[#B8960C]" />
                <h2 className="font-semibold text-[#1A1A1A]">Pending Approvals</h2>
              </div>
              <div className="space-y-2">
                {d.recentApprovals.slice(0, 3).map((item: any) => (
                  <Link key={item.id} href={`/content/${item.id}`} className="flex items-center justify-between p-3 rounded-xl bg-white/60 hover:bg-white transition-all group">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[#1A1A1A] truncate">{item.title}</p>
                      <p className="text-xs text-[#7A7A7A]">{item.projectName}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-[#B0B0B0] group-hover:text-[#F5D547] transition-colors" />
                  </Link>
                ))}
              </div>
              <Link href="/approvals" className="inline-flex items-center gap-1 mt-3 text-sm font-semibold text-[#1A1A1A] hover:text-[#B8960C] transition-colors">
                View all approvals <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Projects */}
      {d.projects?.length > 0 && (
        <div className="crx-animate-slide crx-delay-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-[#1A1A1A]">Your Projects</h2>
            <Link href="/projects" className="text-sm text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors flex items-center gap-1">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {d.projects.map((proj: any) => (
              <Link key={proj.id} href={`/projects/${proj.id}`} className="group block">
                <div className="bg-white rounded-2xl border border-[#E8E0D0] p-5 hover:border-[#F5D547]/50 hover:shadow-[0_8px_32px_rgba(0,0,0,0.06)] transition-all duration-300">
                  <div className="flex items-start justify-between mb-3">
                    <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
                      <FolderOpen className="h-5 w-5 text-[#B8960C]" />
                    </div>
                    <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${STATUS_STYLES[proj.status] || "bg-gray-50 text-gray-500 border-gray-200"}`}>
                      {proj.status}
                    </span>
                  </div>
                  <h3 className="font-semibold text-[#1A1A1A] mb-1 group-hover:text-[#1A1A1A]">{proj.name}</h3>
                  <div className="flex items-center gap-4 text-xs text-[#7A7A7A]">
                    {proj.taskCount != null && <span>{proj.taskCount} tasks</span>}
                    {proj.fileCount != null && <span>{proj.fileCount} files</span>}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
