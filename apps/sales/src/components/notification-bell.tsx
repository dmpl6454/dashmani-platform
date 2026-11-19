"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Bell } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { bellListView, pipelineSalesPath } from "@dashmani/shared/src/pipeline/bell";

// The sales portal's bell (2026-11-18, owner: "marked members not getting notifications").
// Pipeline alerts — added to a project, @mentioned, a reply, a stage or due-date change, a
// review or a page assigned to you — are written for every staff account, but the sales
// portal had no bell, so people who work here never saw them. It reads the same list as the
// staff portal's bell (GET /admin/notifications, any staff session) and opens each row inside
// this portal (pipelineSalesPath: a project → /pipeline/view?id=…).
//
// ⚠️ Only a LOADED response may claim emptiness: loading, failed and empty are three states
// (bellListView), never "No notifications yet" for a failed request.

interface Row {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
  metadata?: unknown;
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d} d ago` : new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);

  const { data: countEnv, mutate: mutateCount } = useSWR(
    "/admin/notifications/count",
    (u: string) => apiFetch<{ count: number }>(u),
    { refreshInterval: 30_000, revalidateOnFocus: true },
  );
  const unread = countEnv?.data?.count ?? 0;

  const { data: listEnv, error: listError, mutate: mutateList } = useSWR(
    open ? "/admin/notifications" : null,
    (u: string) => apiFetch<Row[]>(u),
    { keepPreviousData: true, revalidateOnFocus: false, errorRetryCount: 3 },
  );
  const view = bellListView<Row>(listEnv, listError);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  // Read marks show at once, then both lists are re-read whether the request worked or not,
  // so a failure puts the server's state back.
  async function markRead(n: Row) {
    if (n.read) return;
    mutateList((cur) => (cur && Array.isArray(cur.data) ? { ...cur, data: cur.data.map((r) => (r.id === n.id ? { ...r, read: true } : r)) } : cur), { revalidate: false });
    mutateCount((cur) => (cur?.data ? { ...cur, data: { count: Math.max(0, cur.data.count - 1) } } : cur), { revalidate: false });
    try { await apiFetch(`/admin/notifications/${n.id}/read`, { method: "PUT" }); } catch { /* re-read below */ }
    mutateList(); mutateCount();
  }
  async function markAll() {
    mutateList((cur) => (cur && Array.isArray(cur.data) ? { ...cur, data: cur.data.map((r) => ({ ...r, read: true })) } : cur), { revalidate: false });
    mutateCount((cur) => (cur?.data ? { ...cur, data: { count: 0 } } : cur), { revalidate: false });
    try { await apiFetch("/admin/notifications/read-all", { method: "PUT" }); } catch { /* re-read below */ }
    mutateList(); mutateCount();
  }
  function openRow(n: Row) {
    void markRead(n);
    const path = pipelineSalesPath(n);
    if (path) {
      setOpen(false);
      router.push(path);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="btn btn-ghost btn-sm relative"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        onClick={() => setOpen((o) => !o)}
      >
        <Bell size={14} aria-hidden />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-indigo text-white text-[10px] font-bold leading-[18px] text-center" aria-hidden>
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="absolute right-0 top-full mt-2 w-[min(380px,calc(100vw-2rem))] card z-40 shadow-xl">
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-rule">
            <span className="text-[11px] uppercase tracking-[0.12em] text-ink-3">Notifications</span>
            {unread > 0 && (
              <button type="button" className="text-xs text-indigo-light hover:text-white" onClick={markAll}>Mark all read</button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {view.loading && <p className="px-3 py-6 text-center text-sm text-ink-3">Loading…</p>}
            {view.failed && view.rows.length === 0 && (
              <div className="px-3 py-6 text-center">
                <p className="text-sm text-ink-2">Couldn&apos;t load notifications.</p>
                <button type="button" className="btn btn-ghost btn-sm mt-2" onClick={() => mutateList()}>Try again</button>
              </div>
            )}
            {view.failed && view.rows.length > 0 && (
              <p className="px-3 py-2 text-xs text-ink-3 border-b border-rule">Couldn&apos;t refresh — showing the last list.</p>
            )}
            {view.empty && <p className="px-3 py-6 text-center text-sm text-ink-3">No notifications yet.</p>}
            {view.rows.length > 0 && (
              <ul className="divide-y divide-rule">
                {view.rows.map((n) => {
                  const linked = pipelineSalesPath(n) !== null;
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => openRow(n)}
                        className={`w-full text-left px-3 py-2.5 flex gap-2 hover:bg-muted/60 ${linked ? "cursor-pointer" : "cursor-default"}`}
                      >
                        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${n.read ? "bg-transparent" : "bg-indigo"}`} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className={`block text-sm ${n.read ? "text-ink-2" : "font-bold text-white"}`}>{n.title}</span>
                          {n.message && <span className="block text-xs text-ink-3 line-clamp-2">{n.message}</span>}
                          <span className="block text-[11px] text-ink-4 mt-0.5">
                            {ago(n.createdAt, now)}
                            {!n.read && <span className="sr-only"> · unread</span>}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
