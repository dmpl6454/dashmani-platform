"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import {
  Bell, LogOut, Settings, CheckCheck, BellOff, Megaphone, Search,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";

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
  const [userMenuOpen, setUserMenuOpen]   = useState(false);
  const [bellOpen, setBellOpen]           = useState(false);
  const [selectedNotif, setSelectedNotif] = useState<any>(null);
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
  const crumb = pathname.split("/").filter(Boolean);
  const pageLabel = crumb[0]
    ? crumb[0].charAt(0).toUpperCase() + crumb[0].slice(1).replace(/-/g, " ")
    : "Dashboard";

  return (
    <header className="sticky top-0 z-40 h-[57px] flex items-center justify-between px-5 border-b-2 border-ink/10 bg-bg/90 backdrop-blur-md shrink-0">

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
          <kbd className="ml-0.5">⌘K</kbd>
        </button>

        {/* Announcements history shortcut — distinct from the dashboard "Send announcement"
            CTA. Hidden on the announcements page itself to avoid pointing at the current page. */}
        {pathname !== "/announcements" && (
          <Link
            href="/announcements"
            title="Announcements history"
            className="hidden sm:flex items-center gap-1.5 h-8 px-3 rounded-xl border-2 border-ink/12 text-ink-3 text-xs font-semibold btn-3d hover:text-ink hover:bg-muted transition-colors"
          >
            <Megaphone className="h-3.5 w-3.5" />
            History
          </Link>
        )}

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
            <div className="absolute right-0 top-11 z-50 w-80 v3-card shadow-pop overflow-hidden">
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
            <div className="absolute right-0 top-11 z-50 w-56 v3-card shadow-pop overflow-hidden">
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
