"use client";
import { useState, useRef, useEffect } from "react";
import { Bell } from "lucide-react";
import { useNotifications, useUnreadCount } from "@/lib/hooks/use-notifications";
import { apiFetch } from "@/lib/api";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: countData, mutate: mutateCount } = useUnreadCount();
  const { data: notifData, mutate: mutateNotifs } = useNotifications();

  const count = (countData as any)?.data?.count ?? 0;
  const notifications: any[] = ((notifData as any)?.data ?? []).slice(0, 10);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleMarkRead(id: string) {
    try {
      await apiFetch(`/hr/notifications/${id}/read`, { method: "PUT" });
      mutateNotifs();
      mutateCount();
    } catch { /* ignore */ }
  }

  async function handleMarkAllRead() {
    try {
      await apiFetch("/hr/notifications/read-all", { method: "PUT" });
      mutateNotifs();
      mutateCount();
    } catch { /* ignore */ }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-1.5 rounded-lg text-white/60 hover:bg-[#2B2B2B] hover:text-white transition-all"
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
        <div className="absolute right-0 top-8 z-50 w-80 bg-white rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.12)] border border-[#E8E0D0] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#E8E0D0] bg-[#FEFCF7]">
            <span className="text-sm font-semibold text-[#1A1A1A]">Notifications</span>
            {count > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-xs text-[#7A7A7A] hover:text-[#1A1A1A] font-medium"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-[#E8E0D0]">
            {notifications.length === 0 ? (
              <p className="py-8 text-center text-sm text-[#B0B0B0]">No notifications</p>
            ) : (
              notifications.map((notif: any) => (
                <div
                  key={notif.id}
                  onClick={() => !notif.read && handleMarkRead(notif.id)}
                  className={`px-4 py-3 cursor-pointer hover:bg-[#FEFCF7] transition-colors ${
                    !notif.read ? "bg-[#FFF3C4]/30" : ""
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {!notif.read && (
                      <span className="mt-1.5 h-2 w-2 rounded-full bg-[#F5D547] shrink-0" />
                    )}
                    <div className={!notif.read ? "" : "ml-4"}>
                      <p className="text-sm font-medium text-[#1A1A1A]">{notif.title}</p>
                      <p className="text-xs text-[#7A7A7A] mt-0.5">{notif.message}</p>
                      <p className="text-xs text-[#B0B0B0] mt-1">
                        {new Date(notif.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
