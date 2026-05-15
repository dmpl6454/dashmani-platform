"use client";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useOverviewStats } from "@/lib/hooks/use-analytics";
import { useAnnouncements } from "@/lib/hooks/use-announcements";
import {
  Users, Building2, Clock, CheckCircle, FolderOpen, FileCheck, Send,
  UserPlus, AlertTriangle, ArrowRight, Sun, Sunset, Moon, Megaphone,
} from "lucide-react";
import { useState } from "react";
import { apiFetch } from "@/lib/api";

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

function QuickAnnounceModal({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<number | null>(null);

  const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!confirm("Send this announcement to all active employees?")) return;
    setSending(true);
    try {
      const res = await apiFetch<any>("/admin/announcements", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), message: message.trim() }),
      });
      setDone(res?.data?.recipientCount ?? 0);
    } catch (err: any) {
      alert(err?.message || "Failed to send.");
    } finally {
      setSending(false);
    }
  }

  if (done !== null) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-8 text-center">
          <div className="h-14 w-14 rounded-full bg-[#F5D547] flex items-center justify-center mx-auto mb-4">
            <Megaphone className="h-7 w-7 text-[#1A1A1A]" />
          </div>
          <p className="text-lg font-semibold text-[#1A1A1A]">Announcement sent!</p>
          <p className="text-sm text-[#7A7A7A] mt-1">Notified {done} employee{done !== 1 ? "s" : ""} via portal and email.</p>
          <button onClick={onClose} className="mt-6 px-6 py-2.5 rounded-full bg-[#1A1A1A] text-white text-sm font-semibold hover:bg-[#2B2B2B] transition-colors">
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8E0D0]">
          <h2 className="font-semibold text-[#1A1A1A] flex items-center gap-2">
            <Megaphone size={18} className="text-[#F5D547]" />
            Broadcast Announcement
          </h2>
          <button onClick={onClose} className="rounded-full p-1.5 hover:bg-[#F5F5F5] transition-colors">
            <span className="text-[#7A7A7A] text-lg leading-none">×</span>
          </button>
        </div>
        <form onSubmit={handleSend} className="p-6 space-y-4">
          <div>
            <div className="flex justify-between mb-1">
              <label className="text-xs font-medium text-[#7A7A7A]">Title</label>
              <span className="text-xs text-[#B0B0B0]">{title.length}/120</span>
            </div>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} placeholder="e.g., Office closed on Monday" required className={inputClass} />
          </div>
          <div>
            <div className="flex justify-between mb-1">
              <label className="text-xs font-medium text-[#7A7A7A]">Message</label>
              <span className="text-xs text-[#B0B0B0]">{message.length}/2000</span>
            </div>
            <textarea value={message} onChange={(e) => setMessage(e.target.value.slice(0, 2000))} placeholder="Write your message here..." required rows={5} className={`${inputClass} resize-none`} />
          </div>
          <div className="flex items-center justify-end gap-3 pt-1">
            <button type="button" onClick={onClose} className="px-5 py-2 rounded-full border border-[#E8E0D0] text-sm text-[#7A7A7A] hover:bg-[#F5F5F5] transition-colors">Cancel</button>
            <button type="submit" disabled={sending} className="px-5 py-2 rounded-full bg-[#1A1A1A] text-white text-sm font-semibold hover:bg-[#2B2B2B] transition-colors disabled:opacity-50 flex items-center gap-2">
              <Megaphone size={15} />
              {sending ? "Sending..." : "Send to All Employees"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { data, isLoading } = useOverviewStats();
  const { announcements } = useAnnouncements();
  const stats = (data as any)?.data || {};
  const greeting = getGreeting();
  const firstName = user?.name?.split(" ")[0] || "";
  const pendingEmployees = stats?.pendingEmployees ?? 0;
  const [announceOpen, setAnnounceOpen] = useState(false);
  const lastAnnouncement = announcements[0];

  return (
    <div className="space-y-8 crx-animate-fade">
      {announceOpen && <QuickAnnounceModal onClose={() => setAnnounceOpen(false)} />}

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

      {/* Broadcast Announcement CTA */}
      <div className="crx-animate-slide crx-delay-1 relative overflow-hidden rounded-2xl border border-[#F5D547]/40 p-5" style={{ background: "linear-gradient(135deg, #1A1A1A 0%, #2B2B2B 100%)" }}>
        <div className="absolute top-0 right-0 w-40 h-40 bg-[#F5D547]/10 rounded-full blur-[60px]" />
        <div className="absolute bottom-0 left-20 w-24 h-24 bg-[#F5D547]/5 rounded-full blur-[40px]" />
        <div className="relative flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="h-11 w-11 rounded-xl bg-[#F5D547] flex items-center justify-center shrink-0">
              <Megaphone className="h-5 w-5 text-[#1A1A1A]" />
            </div>
            <div>
              <p className="font-semibold text-white text-base">Broadcast to All Employees</p>
              <p className="text-xs text-white/50 mt-0.5">
                {lastAnnouncement
                  ? `Last sent: "${lastAnnouncement.title}" · ${new Date(lastAnnouncement.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
                  : "Send a message and email to every active employee instantly"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/announcements" className="px-4 py-2 rounded-full border border-white/20 text-white/70 text-xs font-medium hover:bg-white/10 transition-colors">
              View history
            </Link>
            <button
              onClick={() => setAnnounceOpen(true)}
              className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#F5D547] text-[#1A1A1A] text-sm font-bold hover:bg-[#ffe040] transition-all shadow-lg shadow-[#F5D547]/20"
            >
              <Megaphone className="h-4 w-4" />
              Send Announcement
            </button>
          </div>
        </div>
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
