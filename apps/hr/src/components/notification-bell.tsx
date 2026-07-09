"use client";
import { useState, useRef, useEffect } from "react";
import { Bell, BellOff, CheckCheck } from "lucide-react";
import { useNotifications, useUnreadCount } from "@/lib/hooks/use-notifications";
import { apiFetch } from "@/lib/api";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [selectedNotif, setSelectedNotif] = useState<any>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [rightOffset, setRightOffset] = useState(0);
  const { data: countData, mutate: mutateCount } = useUnreadCount();
  const { data: notifData, mutate: mutateNotifs } = useNotifications();

  const count = (countData as any)?.data?.count ?? 0;
  const notifications: any[] = ((notifData as any)?.data ?? []).slice(0, 50);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSelectedNotif(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Keep the panel directly under the bell (vertical placement is pure CSS via
  // `top-full`, so it's unaffected by the header's backdrop-filter containing
  // block). We only nudge it horizontally: pin its right edge 12px inside the
  // viewport — expressed as an offset relative to the bell wrapper — so on pages
  // where an action button insets the bell, the panel doesn't crop off the left
  // edge. A `0` offset (bell at the screen edge) keeps it aligned to the bell.
  useEffect(() => {
    if (!open) return;
    const compute = () => {
      const w = ref.current?.getBoundingClientRect();
      if (!w) return;
      const vw = window.innerWidth;
      const width = Math.min(320, vw - 24); // must match the panel's rendered width
      // Aligned to the bell (offset 0), the panel's left edge would be here:
      const leftIfAligned = w.right - width;
      // Only if that crops off-screen do we push right so the left edge is 12px in.
      // Negative offset pushes the panel toward the viewport's right edge.
      setRightOffset(leftIfAligned < 12 ? w.right - 12 - width : 0);
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [open]);

  async function openNotif(n: any) {
    setSelectedNotif(n);
    if (!n.read) {
      try {
        await apiFetch(`/hr/notifications/${n.id}/read`, { method: "PUT" });
        mutateNotifs();
        mutateCount();
      } catch { /* ignore */ }
    }
  }

  async function handleMarkAllRead() {
    try {
      await apiFetch("/hr/notifications/read-all", { method: "PUT" });
      mutateNotifs();
      mutateCount();
    } catch { /* ignore */ }
  }

  function timeAgo(date: string) {
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => { setOpen((v) => !v); setSelectedNotif(null); }}
        className="relative p-1.5 rounded-lg text-[#7A7A7A] hover:bg-[#F5F5F5] hover:text-[#1A1A1A] transition-all"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {count > 0 && (
          <span className="absolute -top-1 -right-1 flex items-center justify-center h-4 w-4 rounded-full bg-[#F5D547] text-[#1A1A1A] text-[10px] font-bold leading-none">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{ right: rightOffset }}
          className="absolute top-full mt-2 z-50 w-80 max-w-[calc(100vw-1.5rem)] bg-white rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.12)] border border-[#E8E0D0] overflow-hidden"
        >
          {selectedNotif ? (
            /* ── Detail view ── */
            <div>
              <div className="flex items-center gap-2 px-4 py-3 border-b border-[#E8E0D0] bg-[#FEFCF7]">
                <button
                  onClick={() => setSelectedNotif(null)}
                  className="flex items-center gap-1 text-xs text-[#7A7A7A] hover:text-[#1A1A1A] font-medium transition-colors"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                  Back
                </button>
              </div>
              <div className="p-4 space-y-3 max-h-[420px] overflow-y-auto">
                <p className="text-sm font-semibold text-[#1A1A1A] leading-snug">{selectedNotif.title}</p>
                <p className="text-xs text-[#B0B0B0]">
                  {new Date(selectedNotif.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                </p>
                <p className="text-sm text-[#555] leading-relaxed whitespace-pre-wrap">{selectedNotif.message}</p>
              </div>
            </div>
          ) : (
            /* ── List view ── */
            <>
              <div className="flex items-center justify-between px-4 py-3 border-b border-[#E8E0D0] bg-[#FEFCF7]">
                <span className="text-sm font-semibold text-[#1A1A1A]">Notifications</span>
                {count > 0 && (
                  <button
                    onClick={handleMarkAllRead}
                    className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                    Mark all read
                  </button>
                )}
              </div>

              <div className="max-h-[400px] overflow-y-auto divide-y divide-[#E8E0D0]">
                {notifications.length === 0 ? (
                  <div className="py-8 text-center text-[#B0B0B0]">
                    <BellOff className="h-8 w-8 mx-auto mb-2 opacity-40" />
                    <p className="text-sm">No notifications yet</p>
                  </div>
                ) : (
                  notifications.map((notif: any) => (
                    <div
                      key={notif.id}
                      onClick={() => openNotif(notif)}
                      className={`px-4 py-3 cursor-pointer hover:bg-[#FEFCF7] transition-colors ${
                        !notif.read ? "bg-[#FFF3C4]/30" : ""
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {!notif.read && (
                          <span className="mt-1.5 h-2 w-2 rounded-full bg-[#F5D547] shrink-0" />
                        )}
                        <div className={`flex-1 min-w-0 ${notif.read ? "ml-4" : ""}`}>
                          <p className={`text-sm ${!notif.read ? "font-semibold text-[#1A1A1A]" : "text-[#7A7A7A]"}`}>
                            {notif.title}
                          </p>
                          <p className="text-xs text-[#7A7A7A] mt-0.5 line-clamp-2">{notif.message}</p>
                          <p className="text-xs text-[#B0B0B0] mt-1">{timeAgo(notif.createdAt)}</p>
                        </div>
                        <svg className="h-3.5 w-3.5 text-[#D0C8BA] shrink-0 mt-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
