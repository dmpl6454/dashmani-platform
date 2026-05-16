"use client";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useOverviewStats } from "@/lib/hooks/use-analytics";
import { useAnnouncements } from "@/lib/hooks/use-announcements";
import {
  Users, Building2, Clock, CheckCircle, FolderOpen, FileCheck, Send,
  UserPlus, ArrowRight, Megaphone, TrendingUp, BarChart3,
} from "lucide-react";
import { useState } from "react";
import { apiFetch } from "@/lib/api";

const statStrip = [
  { key: "totalEmployees",          label: "Employees",       icon: Users },
  { key: "activeTeams",             label: "Teams",           icon: Building2 },
  { key: "presentToday",            label: "Present",         icon: Clock },
  { key: "tasksCompletedThisMonth", label: "Tasks Done",      icon: CheckCircle },
  { key: "activeProjects",          label: "Projects",        icon: FolderOpen },
  { key: "pendingApprovals",        label: "Pending",         icon: FileCheck },
  { key: "contentPublishedThisMonth", label: "Published",     icon: Send },
  { key: "pendingEmployees",        label: "New Joiners",     icon: UserPlus },
];

function QuickAnnounceModal({ onClose }: { onClose: () => void }) {
  const [title,   setTitle]   = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [done,    setDone]    = useState<number | null>(null);

  const inputCls = "w-full border-2 border-ink/15 bg-surface rounded-xl px-4 py-2.5 text-sm text-ink placeholder:text-ink-4 transition-colors";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !message.trim()) return;
    setConfirming(true);
  }

  async function doSend() {
    setSending(true);
    setError(null);
    try {
      const res = await apiFetch<any>("/admin/announcements", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), message: message.trim() }),
      });
      setDone(res?.data?.recipientCount ?? 0);
    } catch (err: any) {
      setError(err?.message || "Failed to send. Please try again.");
      setConfirming(false);
    } finally { setSending(false); }
  }

  if (done !== null) return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="v3-card shadow-pop p-8 text-center w-full max-w-sm">
        <div className="h-14 w-14 rounded-xl border-2 border-ink bg-action flex items-center justify-center mx-auto mb-4">
          <Megaphone className="h-7 w-7 text-ink" />
        </div>
        <p className="text-lg font-bold text-ink font-display">Announcement sent!</p>
        <p className="text-sm text-ink-3 mt-1">Notified {done} employee{done !== 1 ? "s" : ""} via portal and email.</p>
        <button onClick={onClose} className="mt-6 px-6 py-2.5 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors">
          Done
        </button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="v3-card shadow-pop w-full max-w-lg overflow-hidden pop-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b-2 border-ink/10">
          <h2 className="font-bold text-ink flex items-center gap-2">
            <Megaphone size={18} className="text-action-deep" />
            {confirming ? "Confirm broadcast" : "Broadcast Announcement"}
          </h2>
          <button onClick={onClose} className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-ink-4 text-xl leading-none">×</button>
        </div>

        {confirming ? (
          <div className="p-6 space-y-4">
            <p className="text-sm text-ink-3">
              This will email every active employee and add a notification to their portal. You can't undo this.
            </p>
            <div className="v3-card-inset p-4 space-y-2">
              <p className="text-xs font-bold text-ink-4 uppercase tracking-wider">Preview</p>
              <p className="text-sm font-semibold text-ink">{title}</p>
              <p className="text-sm text-ink-3 whitespace-pre-wrap leading-relaxed">{message}</p>
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex items-center justify-end gap-3 pt-1">
              <button type="button" onClick={() => setConfirming(false)} disabled={sending} className="px-5 py-2 rounded-full border-2 border-ink/15 text-sm text-ink-3 hover:bg-muted transition-colors disabled:opacity-50">
                Back
              </button>
              <button type="button" onClick={doSend} disabled={sending} className="px-5 py-2.5 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors disabled:opacity-50 flex items-center gap-2">
                <Megaphone size={15} />
                {sending ? "Sending…" : "Yes, send to all"}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div>
              <div className="flex justify-between mb-1.5">
                <label className="text-xs font-bold text-ink-4 uppercase tracking-wider">Title</label>
                <span className="text-xs text-ink-4">{title.length}/120</span>
              </div>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} placeholder="e.g., Office closed on Monday" required className={inputCls} />
            </div>
            <div>
              <div className="flex justify-between mb-1.5">
                <label className="text-xs font-bold text-ink-4 uppercase tracking-wider">Message</label>
                <span className="text-xs text-ink-4">{message.length}/2000</span>
              </div>
              <textarea value={message} onChange={(e) => setMessage(e.target.value.slice(0, 2000))} placeholder="Write your message here..." required rows={5} className={`${inputCls} resize-none`} />
            </div>
            <div className="flex items-center justify-end gap-3 pt-1">
              <button type="button" onClick={onClose} className="px-5 py-2 rounded-full border-2 border-ink/15 text-sm text-ink-3 hover:bg-muted transition-colors">Cancel</button>
              <button type="submit" disabled={!title.trim() || !message.trim()} className="px-5 py-2.5 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors disabled:opacity-50 flex items-center gap-2">
                <Megaphone size={15} />
                Review &amp; send
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { data, isLoading } = useOverviewStats();
  const { announcements } = useAnnouncements();
  const stats = (data as any)?.data || {};
  const firstName = user?.name?.split(" ")[0] || "";
  const pendingEmployees = stats?.pendingEmployees ?? 0;
  const [announceOpen, setAnnounceOpen] = useState(false);
  const lastAnnouncement = announcements[0];

  return (
    <div className="space-y-5 pop-in">
      {announceOpen && <QuickAnnounceModal onClose={() => setAnnounceOpen(false)} />}

      {/* Page header */}
      <div>
        <p className="text-xs font-bold text-ink-4 uppercase tracking-widest mb-1">Management Portal</p>
        <h1 className="font-display text-3xl font-semibold text-ink leading-tight">
          Hello, {firstName} 👋
        </h1>
        <p className="text-sm text-ink-3 mt-0.5">Here's your organisation overview</p>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-4 lg:grid-cols-8 gap-3 fade-up d2">
        {statStrip.map(({ key, label, icon: Icon }, i) => {
          const value = stats[key];
          const isPending = key === "pendingApprovals" || key === "pendingEmployees";
          return (
            <div
              key={key}
              className="v3-card-sm p-3 flex flex-col gap-1 v3-card-lift"
              style={{ animationDelay: `${i * 0.04}s` }}
            >
              <div className={`h-7 w-7 rounded-lg flex items-center justify-center ${isPending ? "bg-attention/10" : "bg-indigo-soft"}`}>
                <Icon className={`h-3.5 w-3.5 ${isPending ? "text-attention" : "text-indigo"}`} />
              </div>
              <p className="font-display text-xl font-semibold text-ink leading-none">
                {isLoading ? "—" : (value ?? 0)}
              </p>
              <p className="text-[10px] text-ink-4 font-medium leading-tight">{label}</p>
            </div>
          );
        })}
      </div>

      {/* Bento grid */}
      <div className="bento grid-cols-1 lg:grid-cols-3 fade-up d3">

        {/* Broadcast CTA — full width */}
        <div className="lg:col-span-3 v3-card p-5 flex items-center justify-between gap-4 flex-wrap bg-ink v3-card-lift" style={{ borderColor: "#1A1A1A" }}>
          <div className="flex items-center gap-4">
            <div className="h-11 w-11 rounded-xl bg-action flex items-center justify-center shrink-0">
              <Megaphone className="h-5 w-5 text-ink" />
            </div>
            <div>
              <p className="font-bold text-white text-base">Broadcast to All Employees</p>
              <p className="text-xs text-white/50 mt-0.5">
                {lastAnnouncement
                  ? `Last: "${lastAnnouncement.title}" · ${new Date(lastAnnouncement.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
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
              className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-action text-ink text-sm font-bold btn-3d hover:bg-action-deep transition-colors"
            >
              <Megaphone className="h-4 w-4" /> Send Announcement
            </button>
          </div>
        </div>

        {/* Pending employees alert */}
        {!isLoading && pendingEmployees > 0 && (
          <div className="lg:col-span-3 v3-card p-4 flex items-center justify-between gap-4 bg-attention/5 v3-card-lift">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-attention/10 flex items-center justify-center">
                <UserPlus className="h-5 w-5 text-attention" />
              </div>
              <div>
                <p className="font-bold text-ink">
                  {pendingEmployees} employee{pendingEmployees !== 1 ? "s" : ""} awaiting approval
                </p>
                <p className="text-xs text-ink-4">Review and approve new team members</p>
              </div>
            </div>
            <Link
              href="/employees/pending"
              className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors"
            >
              Review <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        )}

        {/* Quick nav cards */}
        <Link href="/employees" className="v3-card-sm p-5 flex items-center gap-4 v3-card-lift group">
          <div className="h-12 w-12 rounded-xl border-2 border-ink/12 bg-indigo-soft flex items-center justify-center">
            <Users className="h-6 w-6 text-indigo" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-ink">{isLoading ? "—" : (stats.totalEmployees ?? 0)}</p>
            <p className="text-xs text-ink-4">Total Employees</p>
          </div>
          <ArrowRight className="h-4 w-4 text-ink-4 opacity-0 group-hover:opacity-100 transition-opacity" />
        </Link>

        <Link href="/projects" className="v3-card-sm p-5 flex items-center gap-4 v3-card-lift group">
          <div className="h-12 w-12 rounded-xl border-2 border-ink/12 bg-sage-soft flex items-center justify-center">
            <FolderOpen className="h-6 w-6 text-sage" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-ink">{isLoading ? "—" : (stats.activeProjects ?? 0)}</p>
            <p className="text-xs text-ink-4">Active Projects</p>
          </div>
          <ArrowRight className="h-4 w-4 text-ink-4 opacity-0 group-hover:opacity-100 transition-opacity" />
        </Link>

        <Link href="/analytics" className="v3-card-sm p-5 flex items-center gap-4 v3-card-lift group">
          <div className="h-12 w-12 rounded-xl border-2 border-ink/12 bg-terra-soft flex items-center justify-center">
            <TrendingUp className="h-6 w-6 text-terra" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-ink">{isLoading ? "—" : (stats.contentPublishedThisMonth ?? 0)}</p>
            <p className="text-xs text-ink-4">Published This Month</p>
          </div>
          <ArrowRight className="h-4 w-4 text-ink-4 opacity-0 group-hover:opacity-100 transition-opacity" />
        </Link>

      </div>
    </div>
  );
}
