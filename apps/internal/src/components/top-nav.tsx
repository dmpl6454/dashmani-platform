"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import {
  Bell, LogOut, Settings, CheckCheck, BellOff, Megaphone, Search, Plus,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";

/* ── Compose-announcement modal (moved from dashboard — the only place it's used) ── */
function QuickAnnounceModal({ onClose }: { onClose: () => void }) {
  const [title,   setTitle]   = useState("");
  const [message, setMessage] = useState("");
  const [orgUnitId, setOrgUnitId] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [done,    setDone]    = useState<number | null>(null);

  const { data: teamsData } = useSWR("/teams", (url: string) => apiFetch<any>(url));
  const teams: any[] = (teamsData as any)?.data ?? [];
  const selectedTeam = orgUnitId ? teams.find((t: any) => t.id === orgUnitId) : null;

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
      const body: any = { title: title.trim(), message: message.trim() };
      if (orgUnitId) body.orgUnitId = orgUnitId;
      const res = await apiFetch<any>("/admin/announcements", {
        method: "POST",
        body: JSON.stringify(body),
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
              {selectedTeam
                ? `This will notify only members of "${selectedTeam.name}". You can't undo this.`
                : "This will email every active employee and add a notification to their portal. You can't undo this."}
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
              <label className="text-xs font-bold text-ink-4 uppercase tracking-wider mb-1.5 block">Send to</label>
              <select
                value={orgUnitId}
                onChange={(e) => setOrgUnitId(e.target.value)}
                className={inputCls}
              >
                <option value="">Everyone (all active employees)</option>
                {teams.map((t: any) => (
                  <option key={t.id} value={t.id}>Team: {t.name}</option>
                ))}
              </select>
              <p className="text-xs text-ink-4 mt-1">
                {selectedTeam ? `Only members of "${selectedTeam.name}" will be notified.` : "All active employees will be notified."}
              </p>
            </div>
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

/* ── Avatar helper (monogram on cream, ink border) ── */
function Avatar({ name, imageUrl, size = 7 }: { name?: string; imageUrl?: string; size?: number }) {
  const initials = (name || "A").charAt(0).toUpperCase();
  const sizeClass = `h-${size} w-${size}`;
  if (imageUrl) {
    return (
      <img
        src={imageUrl.startsWith("http") ? imageUrl : `${API_BASE}${imageUrl}`}
        alt={name}
        className={`${sizeClass} rounded-full object-cover border-2 border-ink`}
      />
    );
  }
  return (
    <div
      className={`${sizeClass} rounded-full border-2 border-ink bg-muted flex items-center justify-center text-sm font-bold text-ink shrink-0`}
    >
      {initials}
    </div>
  );
}

export function TopNav({ onOpenSearch }: { onOpenSearch?: () => void }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [isMac, setIsMac] = useState(true);
  useEffect(() => {
    setIsMac(/mac/i.test(navigator.platform || navigator.userAgent));
  }, []);
  const [userMenuOpen, setUserMenuOpen]   = useState(false);
  const [bellOpen, setBellOpen]           = useState(false);
  const [selectedNotif, setSelectedNotif] = useState<any>(null);
  const [announceOpen, setAnnounceOpen]   = useState(false);
  const bellRef    = useRef<HTMLDivElement>(null);
  const userRef    = useRef<HTMLDivElement>(null);

  /* ── Notification count (always polling) ── */
  const { data: countData, mutate: mutateCount } = useSWR(
    "/admin/notifications/count",
    (url: string) => apiFetch<any>(url),
    { refreshInterval: 15000 }
  );
  const unreadCount = countData?.data?.count ?? 0;

  /* ── Notification list (only when panel open) ── */
  const { data: notifsData, mutate: mutateNotifs } = useSWR(
    bellOpen ? "/admin/notifications" : null,
    (url: string) => apiFetch<any>(url)
  );
  const notifications = notifsData?.data || [];

  async function markAllRead() {
    try {
      await apiFetch("/admin/notifications/read-all", { method: "PUT" });
      mutateCount(); mutateNotifs();
    } catch {}
  }

  async function openNotif(n: any) {
    setSelectedNotif(n);
    if (!n.read) {
      try {
        await apiFetch(`/admin/notifications/${n.id}/read`, { method: "PUT" });
        mutateCount(); mutateNotifs();
      } catch {}
    }
  }

  /* ── Outside-click handlers ── */
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setBellOpen(false); setSelectedNotif(null);
      }
      if (userRef.current && !userRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function timeAgo(date: string) {
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  /* ── Breadcrumb from pathname ── */
  const ROUTE_LABELS: Record<string, string> = {
    dashboard: "Dashboard",
    employees: "Employees",
    teams: "Team Structure",
    tasks: "Tasks",
    content: "Content",
    accounts: "Accounts",
    workload: "Workload Matrix",
    clients: "Clients",
    projects: "Projects",
    attendance: "Attendance",
    approvals: "Approvals",
    analytics: "Analytics",
    reports: "Link Reports",
    "daily-reports": "Daily Updates",
    announcements: "Announcements",
    "ai-assistant": "AI Assistant",
    "salary-slips": "Salary Slips",
    "offer-letters": "Offer Letters",
    holidays: "Holiday Calendar",
    jobs: "Job Listings",
    expenses: "Expense Claims",
    devices: "Assigned Devices",
    "auto-teams": "Auto-Detected Teams",
    internships: "Internships",
    complaints: "Employee Complaints",
    "bug-reports": "Bug Reports",
    settings: "Settings",
  };
  const crumb = pathname.split("/").filter(Boolean);
  const pageLabel = crumb[0]
    ? (ROUTE_LABELS[crumb[0]] ?? (crumb[0].charAt(0).toUpperCase() + crumb[0].slice(1).replace(/-/g, " ")))
    : "Dashboard";

  return (
    <header className="sticky top-0 z-40 h-[57px] flex items-center justify-between px-5 border-b-2 border-ink/10 bg-bg/90 backdrop-blur-md shrink-0">

      {/* Page-level overlay, not part of the actions row — QuickAnnounceModal renders
          fixed inset-0, so it belongs at the header root rather than nested in the flex row. */}
      {announceOpen && <QuickAnnounceModal onClose={() => setAnnounceOpen(false)} />}

      {/* Left — breadcrumb */}
      <p className="text-sm font-semibold text-ink-3 select-none">{pageLabel}</p>

      {/* Right — actions */}
      <div className="flex items-center gap-1.5">

        {/* Search / ⌘K */}
        <button
          onClick={onOpenSearch}
          className="hidden sm:flex items-center gap-2 h-8 pl-3 pr-2.5 rounded-xl border-2 border-ink/20 bg-surface text-ink-3 text-xs font-medium btn-3d hover:text-ink transition-colors"
        >
          <Search className="h-3.5 w-3.5" />
          <span>Search</span>
          <kbd className="ml-0.5">{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>

        {/* Announcements history shortcut — distinct from the compose action below.
            Hidden on the announcements page itself to avoid pointing at the current page. */}
        {pathname !== "/announcements" && (
          <Link
            href="/announcements"
            title="Announcements"
            className="hidden sm:flex items-center gap-1.5 h-8 px-3 rounded-xl border-2 border-ink/12 text-ink-3 text-xs font-semibold btn-3d hover:text-ink hover:bg-muted transition-colors"
          >
            <Megaphone className="h-3.5 w-3.5" />
            Announcements
          </Link>
        )}

        {/* Compose — opens the broadcast modal directly from the header */}
        <button
          onClick={() => setAnnounceOpen(true)}
          title="Send Announcement"
          aria-label="Send Announcement"
          className="h-8 w-8 flex items-center justify-center rounded-xl border-2 border-ink/12 text-ink-3 btn-3d hover:text-ink hover:bg-muted transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        {/* Bell */}
        <div className="relative" ref={bellRef}>
          <button
            onClick={() => { setBellOpen(v => !v); setSelectedNotif(null); }}
            className="relative h-8 w-8 flex items-center justify-center rounded-xl border-2 border-ink/12 hover:bg-muted transition-colors btn-3d"
          >
            <Bell className="h-4 w-4 text-ink-3" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 h-4 min-w-[16px] flex items-center justify-center rounded-full bg-attention text-white text-[9px] font-bold px-1">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>

          {bellOpen && (
            // Anchored to the viewport edge on phones (fixed + inset-x) instead of the small
            // bell icon (absolute + right-0) — a 320px panel anchored to an icon that isn't at
            // the screen's true right edge was overflowing off the left side of the screen.
            <div className="fixed inset-x-4 top-[114px] sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 z-50 w-auto sm:w-80 v3-card shadow-pop overflow-hidden">
              {selectedNotif ? (
                /* ── Detail view ── */
                <>
                  <div className="flex items-center gap-2 px-4 py-3 border-b-2 border-ink/10">
                    <button
                      onClick={() => setSelectedNotif(null)}
                      className="flex items-center gap-1 text-xs text-ink-4 hover:text-ink font-medium transition-colors"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/></svg>
                      Back
                    </button>
                  </div>
                  <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
                    <p className="text-sm font-semibold text-ink leading-snug">{selectedNotif.title}</p>
                    <p className="text-xs text-ink-4">{new Date(selectedNotif.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</p>
                    <p className="text-sm text-ink-3 leading-relaxed whitespace-pre-wrap">{selectedNotif.message}</p>
                    {/* Deep-link to approval page for employee registration notifications */}
                    {(selectedNotif.title?.toLowerCase().includes("registration") ||
                      selectedNotif.title?.toLowerCase().includes("approval") ||
                      selectedNotif.message?.toLowerCase().includes("awaiting approval")) && (
                      <Link
                        href="/employees/pending"
                        onClick={() => { setBellOpen(false); setSelectedNotif(null); }}
                        className="inline-flex items-center gap-1.5 mt-1 px-3 py-1.5 rounded-lg bg-indigo text-white text-xs font-semibold hover:bg-indigo-deep transition-colors"
                      >
                        Review &amp; Approve →
                      </Link>
                    )}
                  </div>
                </>
              ) : (
                /* ── List view ── */
                <>
                  <div className="flex items-center justify-between px-4 py-3 border-b-2 border-ink/10">
                    <p className="text-sm font-bold text-ink">Notifications</p>
                    {unreadCount > 0 && (
                      <button onClick={markAllRead} className="flex items-center gap-1 text-xs text-indigo hover:text-indigo-deep font-semibold transition-colors">
                        <CheckCheck className="h-3.5 w-3.5" /> Mark all read
                      </button>
                    )}
                  </div>
                  <div className="max-h-96 overflow-y-auto divide-y divide-rule">
                    {notifications.length === 0 ? (
                      <div className="p-8 text-center">
                        <BellOff className="h-8 w-8 mx-auto mb-2 text-ink-4 opacity-40" />
                        <p className="text-sm text-ink-4">No notifications yet</p>
                      </div>
                    ) : notifications.map((n: any) => (
                      <div
                        key={n.id}
                        onClick={() => openNotif(n)}
                        className={`px-4 py-3 cursor-pointer transition-colors v3-row ${!n.read ? "bg-action-soft/30" : ""}`}
                      >
                        <div className="flex items-start gap-2">
                          {!n.read && <span className="mt-1.5 h-2 w-2 rounded-full bg-attention shrink-0 dot-pulse" />}
                          <div className={`flex-1 min-w-0 ${n.read ? "ml-4" : ""}`}>
                            <p className={`text-sm ${!n.read ? "font-semibold text-ink" : "text-ink-3"}`}>{n.title}</p>
                            <p className="text-xs text-ink-4 mt-0.5 line-clamp-2">{n.message}</p>
                            <p className="text-[10px] text-ink-4 mt-1">{timeAgo(n.createdAt)}</p>
                            {(n.title?.toLowerCase().includes("registration") ||
                              n.message?.toLowerCase().includes("awaiting approval")) && (
                              <Link
                                href="/employees/pending"
                                onClick={(e) => { e.stopPropagation(); setBellOpen(false); }}
                                className="inline-flex items-center gap-1 mt-1.5 text-[10px] font-bold text-indigo hover:underline"
                              >
                                Review &amp; Approve →
                              </Link>
                            )}
                          </div>
                          <svg className="h-3.5 w-3.5 text-border shrink-0 mt-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/></svg>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* User avatar + menu */}
        <div className="relative" ref={userRef}>
          <button
            onClick={() => setUserMenuOpen(v => !v)}
            className="flex items-center gap-2 h-8 pl-1 pr-2 rounded-xl border-2 border-ink/12 hover:bg-muted transition-colors btn-3d"
          >
            <Avatar name={user?.name ?? undefined} imageUrl={user?.profileImageUrl ?? undefined} size={6} />
            <span className="hidden md:block text-xs font-semibold text-ink">{user?.name?.split(" ")[0]}</span>
          </button>

          {userMenuOpen && (
            // Same viewport-anchoring fix as the notifications panel above — fixed to the
            // screen edge on phones instead of the small avatar button.
            <div className="fixed right-4 top-[114px] sm:absolute sm:right-0 sm:top-11 z-50 w-56 v3-card shadow-pop overflow-hidden">
              <div className="px-4 py-3 border-b-2 border-ink/10 bg-muted/40">
                <p className="text-sm font-bold text-ink">{user?.name}</p>
                <p className="text-xs text-ink-4 truncate">{user?.email}</p>
              </div>
              <div className="p-1.5 space-y-0.5">
                <Link
                  href="/settings"
                  onClick={() => setUserMenuOpen(false)}
                  className="flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-ink v3-row"
                >
                  <Settings className="h-4 w-4 text-ink-4" /> Settings
                </Link>
                <button
                  onClick={() => { setUserMenuOpen(false); logout(); }}
                  className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-sm text-danger v3-row"
                >
                  <LogOut className="h-4 w-4" /> Log out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
