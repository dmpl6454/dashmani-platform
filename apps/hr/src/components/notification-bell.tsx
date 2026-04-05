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

  // Close dropdown on outside click
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
    } catch {
      // ignore
    }
  }

  async function handleMarkAllRead() {
    try {
      await apiFetch("/hr/notifications/read-all", { method: "PUT" });
      mutateNotifs();
      mutateCount();
    } catch {
      // ignore
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-1.5 rounded-md text-white/70 hover:bg-white/10 hover:text-white transition-colors"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {count > 0 && (
          <span className="absolute -top-1 -right-1 flex items-center justify-center h-4 w-4 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-8 z-50 w-80 bg-white rounded-lg shadow-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-gray-50">
            <span className="text-sm font-semibold text-gray-800">Notifications</span>
            {count > 0 && (
              <button
                onClick={handleMarkAllRead}
                className="text-xs text-blue-600 hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-gray-50">
            {notifications.length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-400">No notifications</p>
            ) : (
              notifications.map((notif: any) => (
                <div
                  key={notif.id}
                  onClick={() => !notif.read && handleMarkRead(notif.id)}
                  className={`px-4 py-3 cursor-pointer hover:bg-gray-50 transition-colors ${
                    !notif.read ? "bg-blue-50" : ""
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {!notif.read && (
                      <span className="mt-1.5 h-2 w-2 rounded-full bg-blue-500 shrink-0" />
                    )}
                    <div className={!notif.read ? "" : "ml-4"}>
                      <p className="text-sm font-medium text-gray-900">{notif.title}</p>
                      <p className="text-xs text-gray-500 mt-0.5">{notif.message}</p>
                      <p className="text-xs text-gray-400 mt-1">
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
