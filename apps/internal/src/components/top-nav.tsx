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
import { createPortal } from "react-dom";
// Deep import on purpose: the bell mounts on every page, and the @dashmani/shared
// barrel would pull zod and every validator into the shared client chunk
// (+16 kB First Load JS on 23 HR pages, measured). bell.ts has no dependencies.
import { bellListView, pipelineNotificationUrl } from "@dashmani/shared/src/pipeline/bell";

/* ── Compose-announcement modal (moved from dashboard — the only place it's used) ──
   Opened from the dark DsTopNav (and the legacy TopNav, which no route renders any
   more), so it is drawn in the "ds" dark palette. It portals to <body>, outside the
   layout's .ds-root, so it wraps itself in its own `ds-root contents` to pick up the
   scoped dark rules (focus rings, scrollbars, selection, native control colours). */
const QA_LABEL = "text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase";
const QA_GHOST_BTN =
  "w-full sm:w-auto justify-center inline-flex items-center h-[42px] px-5 rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold whitespace-nowrap hover:text-ds-text hover:border-[#2A4658] transition-colors disabled:opacity-60";
const QA_GOLD_BTN =
  "w-full sm:w-auto justify-center inline-flex items-center gap-2 h-[42px] px-5 rounded-full bg-ds-gold text-[#060D14] text-[13px] font-bold whitespace-nowrap hover:bg-[#F4D58C] transition-colors disabled:opacity-60";
const QA_ERROR = "px-3 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[#FB7185] text-[12.5px]";

export function QuickAnnounceModal({ onClose }: { onClose: () => void }) {
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

  const inputCls = "w-full min-w-0 px-4 py-2.5 rounded-[12px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13.5px] outline-none transition-colors focus:border-[rgba(233,189,98,.6)] placeholder:text-ds-t4 [color-scheme:dark]";

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

  // Render the modal into a portal on <body>. The nav is this modal's DOM parent and
  // was acting as the containing block for the `fixed inset-0` overlay, trapping it in
  // the ~55px nav strip — so `inset-0` resolved to 0,0,0,0 but the box only spanned the
  // nav, and the centered modal landed off-screen (header clipped at the top). Portalling
  // to <body> makes the fixed overlay cover the real viewport. SSR-safe: the modal only
  // renders after a client-side click, so `document` is always defined here.
  if (typeof document === "undefined") return null;

  if (done !== null) return createPortal((
    <div className="ds-root contents">
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,6,10,.72)] p-4">
        <div role="dialog" aria-modal="true" aria-label="Announcement sent" className="relative w-full max-w-sm p-8 text-center bg-ds-card border border-ds-line2 rounded-[18px] shadow-[0_24px_60px_rgba(0,0,0,.6)] overflow-hidden">
          <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,#E9BD62_30%,#E9BD62_70%,transparent)]" />
          <div className="h-14 w-14 rounded-[14px] border border-[rgba(233,189,98,.35)] bg-[rgba(233,189,98,.1)] flex items-center justify-center mx-auto mb-4">
            <Megaphone className="h-7 w-7 text-ds-gold" />
          </div>
          <p className="text-[17px] font-semibold text-ds-text">Announcement sent!</p>
          <p className="text-[13px] text-ds-t2 mt-1">Notified {done} employee{done !== 1 ? "s" : ""} via portal and email.</p>
          <button onClick={onClose} className={`mt-6 ${QA_GOLD_BTN}`}>
            Done
          </button>
        </div>
      </div>
    </div>
  ), document.body);

  return createPortal((
    <div className="ds-root contents">
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(2,6,10,.72)] p-4" onClick={onClose}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={confirming ? "Confirm broadcast" : "Broadcast Announcement"}
          className="relative w-full max-w-lg max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden pop-in bg-ds-card border border-ds-line2 rounded-[18px] shadow-[0_24px_60px_rgba(0,0,0,.6)]"
          onClick={(e) => e.stopPropagation()}
        >
          <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,#E9BD62_30%,#E9BD62_70%,transparent)]" />
          <div className="flex items-center justify-between px-6 py-[18px] border-b border-[#1A2C38] shrink-0">
            <h2 className="text-[16px] font-semibold text-ds-text flex items-center gap-2.5">
              <Megaphone size={17} className="text-ds-gold" />
              {confirming ? "Confirm broadcast" : "Broadcast Announcement"}
            </h2>
            <button onClick={onClose} aria-label="Close" className="h-[30px] w-[30px] flex items-center justify-center rounded-[8px] hover:bg-[#132430] transition-colors text-ds-t3 hover:text-ds-text text-xl leading-none">×</button>
          </div>

          {confirming ? (
            <div className="px-6 py-[22px] space-y-4 flex-1 min-h-0 overflow-y-auto">
              <p className="text-[13.5px] leading-[1.55] text-ds-t2">
                {selectedTeam
                  ? `This will notify only members of "${selectedTeam.name}". You can't undo this.`
                  : "This will email every active employee and add a notification to their portal. You can't undo this."}
              </p>
              <div className="p-[18px] rounded-[14px] bg-ds-inset border border-[#1A2C38] space-y-2">
                <p className={QA_LABEL}>Preview</p>
                <p className="text-[15px] font-semibold text-ds-text [overflow-wrap:anywhere]">{title}</p>
                <p className="text-[13px] text-ds-t2 whitespace-pre-wrap leading-[1.6] [overflow-wrap:anywhere]">{message}</p>
              </div>
              {error && <p className={QA_ERROR}>{error}</p>}
              <div className="flex flex-col gap-2.5 pt-1 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
                <button type="button" onClick={() => setConfirming(false)} disabled={sending} className={QA_GHOST_BTN}>
                  Back
                </button>
                <button type="button" onClick={doSend} disabled={sending} className={QA_GOLD_BTN}>
                  <Megaphone size={15} className="shrink-0" />
                  {sending ? "Sending…" : "Yes, send to all"}
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="px-6 py-[22px] space-y-4 flex-1 min-h-0 overflow-y-auto">
              <div>
                <label className={`${QA_LABEL} mb-1.5 block`}>Send to</label>
                <select
                  value={orgUnitId}
                  onChange={(e) => setOrgUnitId(e.target.value)}
                  className={`${inputCls} cursor-pointer`}
                >
                  <option value="" className="bg-ds-card">Everyone (all active employees)</option>
                  {teams.map((t: any) => (
                    <option key={t.id} value={t.id} className="bg-ds-card">Team: {t.name}</option>
                  ))}
                </select>
                <p className="text-[12px] text-ds-t3 mt-1">
                  {selectedTeam ? `Only members of "${selectedTeam.name}" will be notified.` : "All active employees will be notified."}
                </p>
              </div>
              <div>
                <div className="flex justify-between mb-1.5">
                  <label className={QA_LABEL}>Title</label>
                  <span className="text-[11.5px] text-ds-t3 tabular-nums">{title.length}/120</span>
                </div>
                <input type="text" value={title} onChange={(e) => setTitle(e.target.value.slice(0, 120))} placeholder="e.g., Office closed on Monday" required className={inputCls} />
              </div>
              <div>
                <div className="flex justify-between mb-1.5">
                  <label className={QA_LABEL}>Message</label>
                  <span className="text-[11.5px] text-ds-t3 tabular-nums">{message.length}/2000</span>
                </div>
                <textarea value={message} onChange={(e) => setMessage(e.target.value.slice(0, 2000))} placeholder="Write your message here..." required rows={5} className={`${inputCls} resize-none leading-[1.55]`} />
              </div>
              <div className="flex flex-col gap-2.5 pt-1 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
                <button type="button" onClick={onClose} className={QA_GHOST_BTN}>Cancel</button>
                <button type="submit" disabled={!title.trim() || !message.trim()} className={QA_GOLD_BTN}>
                  <Megaphone size={15} className="shrink-0" />
                  Review &amp; send
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  ), document.body);
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
  const { data: notifsData, error: notifsError, isValidating: notifsValidating, mutate: mutateNotifs } = useSWR(
    bellOpen ? "/admin/notifications" : null,
    (url: string) => apiFetch<any>(url),
    { keepPreviousData: true, revalidateOnFocus: false, errorRetryCount: 3 }
  );
  // Only a LOADED response may claim emptiness (P4, same rules as the HR bell —
  // packages/shared/src/pipeline/bell.ts): loading, failed and empty are distinct.
  const notifView = bellListView<any>(notifsData, notifsError);
  const notifications = notifView.rows;

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
                    {/* PIPELINE rows open the HR-portal project in a new tab — only for an
                        allowlisted origin and a /pipeline/ path (never the title heuristic). */}
                    {(() => {
                      const url = pipelineNotificationUrl(selectedNotif);
                      return url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1.5 mt-1 px-3 py-1.5 rounded-lg bg-indigo text-white text-xs font-semibold hover:bg-indigo-deep transition-colors"
                        >
                          Open in Employee Portal ↗
                        </a>
                      ) : null;
                    })()}
                    {/* Deep-link to approval page for employee registration notifications */}
                    {selectedNotif.type !== "PIPELINE" &&
                     (selectedNotif.title?.toLowerCase().includes("registration") ||
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
                    {notifView.loading ? (
                      /* Loading: skeleton, never a false "No notifications yet" */
                      <div role="status" className="divide-y divide-rule">
                        <span className="sr-only">Loading notifications…</span>
                        {[0, 1, 2].map((i) => (
                          <div key={i} className="px-4 py-3" aria-hidden="true">
                            <div className="ml-4 space-y-1.5">
                              <div className="h-3.5 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
                              <div className="h-3 w-full rounded bg-muted/70 motion-safe:animate-pulse" />
                              <div className="h-2.5 w-14 rounded bg-muted/70 motion-safe:animate-pulse" />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : notifView.failed && notifications.length === 0 ? (
                      /* Failed with nothing loaded: say so, offer Retry */
                      <div role="alert" className="p-8 text-center">
                        <p className="text-sm text-ink-3">Couldn&apos;t load notifications</p>
                        <button
                          type="button"
                          onClick={() => mutateNotifs()}
                          disabled={notifsValidating}
                          className="mt-3 inline-flex items-center justify-center min-h-[44px] px-5 rounded-xl border-2 border-ink/15 text-sm font-semibold text-ink btn-3d hover:bg-muted transition-colors disabled:opacity-60"
                        >
                          {notifsValidating ? "Retrying…" : "Retry"}
                        </button>
                      </div>
                    ) : notifView.empty ? (
                      /* Loaded [] — the only state allowed to claim emptiness */
                      <div className="p-8 text-center">
                        <BellOff className="h-8 w-8 mx-auto mb-2 text-ink-4 opacity-40" />
                        <p className="text-sm text-ink-4">No notifications yet</p>
                      </div>
                    ) : (<>
                    {notifView.failed && (
                      /* A refresh failed: keep the last loaded rows, say so */
                      <div role="alert" className="flex items-center justify-between gap-2 px-4 py-2 bg-action-soft/40">
                        <p className="text-xs text-ink-3 min-w-0">Couldn&apos;t refresh notifications</p>
                        <button
                          type="button"
                          onClick={() => mutateNotifs()}
                          disabled={notifsValidating}
                          className="shrink-0 inline-flex items-center min-h-[44px] px-2 text-xs font-semibold text-indigo hover:text-indigo-deep disabled:opacity-60"
                        >
                          {notifsValidating ? "Retrying…" : "Retry"}
                        </button>
                      </div>
                    )}
                    {notifications.map((n: any) => (
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
                            {(() => {
                              const url = pipelineNotificationUrl(n);
                              return url ? (
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="inline-flex items-center gap-1 mt-1.5 text-[10px] font-bold text-indigo hover:underline"
                                >
                                  Open in Employee Portal ↗
                                </a>
                              ) : null;
                            })()}
                            {n.type !== "PIPELINE" &&
                             (n.title?.toLowerCase().includes("registration") ||
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
                    </>)}
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
