"use client";
// Premium dark top bar ("ds" redesign). Same behaviour as the classic TopNav —
// search opens the command palette, the bell reads/marks the same notification
// endpoints, the user menu has Settings + Log out, and the announcement shortcuts
// are kept — only the look differs.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useRef, useEffect } from "react";
import useSWR from "swr";
import { Bell, BellOff, CheckCheck, ChevronDown, LogOut, Megaphone, Plus, Search, Settings, CalendarDays } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch, API_BASE } from "@/lib/api";
import { QuickAnnounceModal } from "@/components/top-nav";
// Deep import on purpose (see top-nav.tsx): the barrel would pull zod into every page.
import { bellListView, pipelineNotificationUrl } from "@dashmani/shared/src/pipeline/bell";

function initials(name?: string | null) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "A";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

function timeAgo(date: string) {
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const panel = "rounded-[6px] border border-ds-line2 bg-ds-inset shadow-[0_16px_40px_rgba(0,0,0,.55)] overflow-hidden";
const iconBtn = "relative h-8 w-8 flex items-center justify-center rounded-[6px] border border-transparent text-ds-t2 transition-colors hover:bg-ds-inset hover:border-ds-line2 hover:text-ds-text";

export function DsTopNav({ onOpenSearch }: { onOpenSearch?: () => void }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [isMac, setIsMac] = useState(true);
  const [today, setToday] = useState<string | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [selectedNotif, setSelectedNotif] = useState<any>(null);
  const [announceOpen, setAnnounceOpen] = useState(false);
  // Remembers WHICH url failed, so a later, different picture is still tried.
  const [avatarFailed, setAvatarFailed] = useState<string | null>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const userRef = useRef<HTMLDivElement>(null);

  // Client-only values (avoid SSR/hydration mismatch).
  useEffect(() => {
    setIsMac(/mac/i.test(navigator.platform || navigator.userAgent));
    setToday(new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "Asia/Kolkata" }));
  }, []);

  const { data: countData, mutate: mutateCount } = useSWR(
    "/admin/notifications/count",
    (url: string) => apiFetch<any>(url),
    { refreshInterval: 15000 },
  );
  const unreadCount = countData?.data?.count ?? 0;

  const { data: notifsData, error: notifsError, isValidating: notifsValidating, mutate: mutateNotifs } = useSWR(
    bellOpen ? "/admin/notifications" : null,
    (url: string) => apiFetch<any>(url),
    { keepPreviousData: true, revalidateOnFocus: false, errorRetryCount: 3 },
  );
  // Only a LOADED response may claim emptiness — loading, failed and empty are distinct.
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

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) { setBellOpen(false); setSelectedNotif(null); }
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const role: string | undefined = Array.isArray(user?.roles) ? user.roles[0] : undefined;
  const avatarSrc = user?.profileImageUrl
    ? (String(user.profileImageUrl).startsWith("http") ? user.profileImageUrl : `${API_BASE}${user.profileImageUrl}`)
    : null;

  const approvalHint = (n: any) =>
    n.type !== "PIPELINE" &&
    (n.title?.toLowerCase().includes("registration") ||
      n.title?.toLowerCase().includes("approval") ||
      n.message?.toLowerCase().includes("awaiting approval"));

  return (
    <header className="sticky top-0 z-30 h-16 flex items-center gap-3 px-4 sm:px-6 bg-ds-bg border-b border-[#0F1E2A] shrink-0">
      {announceOpen && <QuickAnnounceModal onClose={() => setAnnounceOpen(false)} />}

      {/* Search — opens the global command palette */}
      <button
        onClick={onOpenSearch}
        className="hidden sm:flex items-center gap-2 h-[34px] px-3.5 rounded-full bg-ds-chip border border-ds-line2 flex-[0_1_420px] min-w-0 text-left transition-colors hover:border-ds-line4"
      >
        <Search className="h-3.5 w-3.5 text-ds-t2 shrink-0" strokeWidth={2} />
        <span className="flex-1 min-w-0 truncate text-[12px] text-ds-t3">Search employees, accounts, links…</span>
        <kbd className="shrink-0">{isMac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <button onClick={onOpenSearch} className={`${iconBtn} sm:hidden`} aria-label="Search">
        <Search className="h-4 w-4" />
      </button>

      <div className="ml-auto flex items-center gap-2 shrink-0">
        {today && (
          <span className="hidden md:inline-flex items-center gap-2 h-8 px-3 rounded-[6px] bg-ds-inset border border-ds-line2 text-[12px] text-ds-text whitespace-nowrap">
            <CalendarDays className="h-3.5 w-3.5 text-ds-t2" strokeWidth={1.8} />
            Today · {today}
          </span>
        )}

        {pathname !== "/announcements" && (
          <Link href="/announcements" title="Announcements" className={`${iconBtn} hidden sm:flex`}>
            <Megaphone className="h-4 w-4" strokeWidth={1.8} />
          </Link>
        )}
        <button onClick={() => setAnnounceOpen(true)} title="Send announcement" aria-label="Send announcement" className={iconBtn}>
          <Plus className="h-4 w-4" />
        </button>

        {/* Bell */}
        <div className="relative" ref={bellRef}>
          <button
            onClick={() => { setBellOpen((v) => !v); setSelectedNotif(null); }}
            aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
            className={iconBtn}
          >
            <Bell className="h-4 w-4" strokeWidth={1.8} />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 h-4 min-w-[16px] px-1 grid place-items-center rounded-full bg-ds-red text-white text-[9px] font-bold shadow-[0_0_6px_#E52D47]">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>

          {bellOpen && (
            <div className={`fixed inset-x-4 top-[128px] sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 z-50 sm:w-80 ${panel}`}>
              {selectedNotif ? (
                <>
                  <div className="px-4 py-3 border-b border-ds-line">
                    <button onClick={() => setSelectedNotif(null)} className="text-xs font-medium text-ds-t3 hover:text-ds-text">‹ Back</button>
                  </div>
                  <div className="p-4 space-y-3 max-h-96 overflow-y-auto">
                    <p className="text-sm font-semibold text-ds-text leading-snug">{selectedNotif.title}</p>
                    <p className="text-xs text-ds-t3">{new Date(selectedNotif.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</p>
                    <p className="text-sm text-ds-t2 leading-relaxed whitespace-pre-wrap">{selectedNotif.message}</p>
                    {(() => {
                      const url = pipelineNotificationUrl(selectedNotif);
                      return url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] border border-ds-gold bg-ds-gold/[.12] text-ds-gold text-xs font-semibold hover:bg-ds-gold/[.22]">
                          Open in Employee Portal ↗
                        </a>
                      ) : null;
                    })()}
                    {approvalHint(selectedNotif) && (
                      <Link
                        href="/employees/pending"
                        onClick={() => { setBellOpen(false); setSelectedNotif(null); }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] border border-ds-gold bg-ds-gold/[.12] text-ds-gold text-xs font-semibold hover:bg-ds-gold/[.22]"
                      >
                        Review &amp; Approve →
                      </Link>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between px-4 py-3 border-b border-ds-line">
                    <p className="text-[13px] font-semibold text-ds-text">Notifications</p>
                    {unreadCount > 0 && (
                      <button onClick={markAllRead} className="flex items-center gap-1 text-xs font-semibold text-ds-gold hover:text-ds-gold2">
                        <CheckCheck className="h-3.5 w-3.5" /> Mark all read
                      </button>
                    )}
                  </div>
                  <div className="max-h-96 overflow-y-auto divide-y divide-ds-grid">
                    {notifView.loading ? (
                      <div role="status">
                        <span className="sr-only">Loading notifications…</span>
                        {[0, 1, 2].map((i) => (
                          <div key={i} className="px-4 py-3 space-y-1.5" aria-hidden="true">
                            <div className="h-3.5 w-2/3 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                            <div className="h-3 w-full rounded-[4px] bg-ds-hover/70 motion-safe:animate-pulse" />
                          </div>
                        ))}
                      </div>
                    ) : notifView.failed && notifications.length === 0 ? (
                      <div role="alert" className="p-8 text-center">
                        <p className="text-sm text-ds-t2">Couldn&apos;t load notifications</p>
                        <button onClick={() => mutateNotifs()} disabled={notifsValidating} className="mt-3 h-9 px-5 rounded-[6px] border border-ds-line2 text-sm font-semibold text-ds-text hover:border-ds-line4 disabled:opacity-60">
                          {notifsValidating ? "Retrying…" : "Retry"}
                        </button>
                      </div>
                    ) : notifView.empty ? (
                      <div className="p-8 text-center">
                        <BellOff className="h-7 w-7 mx-auto mb-2 text-ds-t4" />
                        <p className="text-sm text-ds-t3">No notifications yet</p>
                      </div>
                    ) : (
                      <>
                        {notifView.failed && (
                          <div role="alert" className="flex items-center justify-between gap-2 px-4 py-2 bg-ds-gold/[.07]">
                            <p className="text-xs text-ds-t2">Couldn&apos;t refresh notifications</p>
                            <button onClick={() => mutateNotifs()} disabled={notifsValidating} className="text-xs font-semibold text-ds-gold disabled:opacity-60">
                              {notifsValidating ? "Retrying…" : "Retry"}
                            </button>
                          </div>
                        )}
                        {notifications.map((n: any) => (
                          <div
                            key={n.id}
                            onClick={() => openNotif(n)}
                            className={`px-4 py-3 cursor-pointer transition-colors hover:bg-ds-hover ${!n.read ? "bg-ds-gold/[.05]" : ""}`}
                          >
                            <div className="flex items-start gap-2">
                              {!n.read && <span className="mt-1.5 h-2 w-2 rounded-full bg-ds-red shrink-0" />}
                              <div className={`flex-1 min-w-0 ${n.read ? "ml-4" : ""}`}>
                                <p className={`text-[13px] ${!n.read ? "font-semibold text-ds-text" : "text-ds-t2"}`}>{n.title}</p>
                                <p className="text-xs text-ds-t3 mt-0.5 line-clamp-2">{n.message}</p>
                                <p className="text-[10px] text-ds-t4 mt-1">{timeAgo(n.createdAt)}</p>
                                {(() => {
                                  const url = pipelineNotificationUrl(n);
                                  return url ? (
                                    <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-block mt-1.5 text-[10px] font-bold text-ds-gold hover:underline">
                                      Open in Employee Portal ↗
                                    </a>
                                  ) : null;
                                })()}
                                {n.type !== "PIPELINE" &&
                                  (n.title?.toLowerCase().includes("registration") || n.message?.toLowerCase().includes("awaiting approval")) && (
                                    <Link
                                      href="/employees/pending"
                                      onClick={(e) => { e.stopPropagation(); setBellOpen(false); }}
                                      className="inline-block mt-1.5 text-[10px] font-bold text-ds-gold hover:underline"
                                    >
                                      Review &amp; Approve →
                                    </Link>
                                  )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* User */}
        <div className="relative" ref={userRef}>
          <button
            onClick={() => setUserMenuOpen((v) => !v)}
            className="flex items-center gap-2.5 h-[38px] px-1.5 rounded-[6px] border border-transparent text-left transition-colors hover:bg-ds-inset hover:border-ds-line2"
          >
            {avatarSrc && avatarFailed !== avatarSrc ? (
              <img src={avatarSrc} alt="" onError={() => setAvatarFailed(avatarSrc)} className="h-8 w-8 rounded-full object-cover border border-ds-line3" />
            ) : (
              <span className="h-8 w-8 rounded-full bg-ds-chip border border-ds-line3 grid place-items-center text-[11px] font-semibold text-ds-text">{initials(user?.name)}</span>
            )}
            <span className="hidden md:flex flex-col leading-tight">
              <span className="text-[12.5px] font-semibold text-ds-text whitespace-nowrap">{user?.name}</span>
              {role && <span className="text-[10.5px] text-ds-t2 whitespace-nowrap">{role}</span>}
            </span>
            <ChevronDown className="hidden md:block h-3 w-3 text-ds-t2" strokeWidth={2.4} />
          </button>

          {userMenuOpen && (
            <div className={`fixed right-4 top-[128px] sm:absolute sm:right-0 sm:top-11 z-50 w-56 ${panel}`}>
              <div className="px-4 py-3 border-b border-ds-line">
                <p className="text-sm font-semibold text-ds-text truncate">{user?.name}</p>
                <p className="text-xs text-ds-t3 truncate">{user?.email}</p>
              </div>
              <div className="p-1.5">
                <Link href="/settings" onClick={() => setUserMenuOpen(false)} className="flex items-center gap-2.5 px-3 py-2 rounded-[6px] text-sm text-ds-text hover:bg-ds-hover">
                  <Settings className="h-4 w-4 text-ds-t3" /> Settings
                </Link>
                <button onClick={() => { setUserMenuOpen(false); logout(); }} className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[6px] text-sm text-ds-redsoft hover:bg-ds-hover">
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
