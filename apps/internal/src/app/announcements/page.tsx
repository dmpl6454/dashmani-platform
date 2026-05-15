"use client";

import { useState } from "react";
import { Megaphone, Plus, X, Users } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAnnouncements } from "@/lib/hooks/use-announcements";

const inputClass =
  "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

function AnnouncementModal({
  onClose,
  onSent,
}: {
  onClose: () => void;
  onSent: (count: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim() || !message.trim()) {
      setError("Title and message are required.");
      return;
    }
    if (
      !confirm(
        "This will send a notification and email to all active employees. Continue?"
      )
    )
      return;

    setSending(true);
    try {
      const res = await apiFetch<any>("/admin/announcements", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), message: message.trim() }),
      });
      onSent(res?.data?.recipientCount ?? 0);
    } catch (err: any) {
      setError(err?.message || "Failed to send announcement.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E8E0D0]">
          <h2 className="font-semibold text-[#1A1A1A] flex items-center gap-2">
            <Megaphone size={18} className="text-[#F5D547]" />
            New Announcement
          </h2>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 hover:bg-[#F5F5F5] transition-colors"
          >
            <X size={18} className="text-[#7A7A7A]" />
          </button>
        </div>

        <form onSubmit={handleSend} className="p-6 space-y-4">
          <div>
            <div className="flex justify-between mb-1">
              <label className="text-xs font-medium text-[#7A7A7A]">Title</label>
              <span className="text-xs text-[#B0B0B0]">{title.length}/120</span>
            </div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 120))}
              placeholder="e.g., Office Closed on Monday"
              required
              className={inputClass}
            />
          </div>

          <div>
            <div className="flex justify-between mb-1">
              <label className="text-xs font-medium text-[#7A7A7A]">Message</label>
              <span className="text-xs text-[#B0B0B0]">{message.length}/2000</span>
            </div>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, 2000))}
              placeholder="Write your announcement here..."
              required
              rows={6}
              className={`${inputClass} resize-none`}
            />
          </div>

          {error && (
            <p className="text-sm text-[#E74C3C] bg-[rgba(231,76,60,0.08)] rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3 pt-1">
            <p className="text-xs text-[#7A7A7A] flex-1">
              Will notify all active employees via portal and email.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="px-5 py-2 rounded-full border border-[#E8E0D0] text-sm text-[#7A7A7A] hover:bg-[#F5F5F5] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={sending}
              className="px-5 py-2 rounded-full bg-[#1A1A1A] text-white text-sm font-semibold hover:bg-[#2B2B2B] transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <Megaphone size={15} />
              {sending ? "Sending..." : "Send to All"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AnnouncementsPage() {
  const { announcements, isLoading, mutate } = useAnnouncements();
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function handleSent(count: number) {
    setModalOpen(false);
    setToast(`Announcement sent to ${count} employee${count !== 1 ? "s" : ""}.`);
    mutate();
    setTimeout(() => setToast(null), 4000);
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      {toast && (
        <div className="fixed top-5 right-5 z-50 bg-[#1A1A1A] text-white text-sm font-medium px-5 py-3 rounded-xl shadow-lg flex items-center gap-2 animate-fade-in">
          <Megaphone size={16} className="text-[#F5D547]" />
          {toast}
        </div>
      )}

      {modalOpen && (
        <AnnouncementModal
          onClose={() => setModalOpen(false)}
          onSent={handleSent}
        />
      )}

      <div className="flex items-center justify-between">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Announcements</h1>
        <button
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-2 bg-[#1A1A1A] text-white px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] transition-colors"
        >
          <Plus size={16} />
          New Announcement
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0EAD8]">
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Title</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Message</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Sent by</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Recipients</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i} className="border-b border-[#F0EAD8]">
                    {[...Array(5)].map((__, j) => (
                      <td key={j} className="p-4">
                        <div className="h-4 bg-[#F0EAD8] rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : announcements.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-10 text-center text-[#7A7A7A]">
                    <Megaphone size={28} className="mx-auto mb-3 opacity-25" />
                    <p className="font-medium text-[#1A1A1A] mb-1">No announcements yet</p>
                    <p className="text-xs">Click "New Announcement" to broadcast a message to all employees.</p>
                  </td>
                </tr>
              ) : (
                announcements.map((a: any) => (
                  <tr
                    key={a.id}
                    className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors"
                  >
                    <td className="p-4 font-medium text-[#1A1A1A] max-w-[200px] truncate">
                      {a.title}
                    </td>
                    <td className="p-4 text-[#7A7A7A] max-w-[280px]">
                      <p className="line-clamp-2 leading-relaxed">{a.message}</p>
                    </td>
                    <td className="p-4 text-[#1A1A1A]">{a.sentBy?.name ?? "—"}</td>
                    <td className="p-4">
                      <span className="inline-flex items-center gap-1 bg-[rgba(245,213,71,0.18)] text-[#B8960C] rounded-full px-3 py-1 text-xs font-medium">
                        <Users size={11} />
                        {a.recipientCount}
                      </span>
                    </td>
                    <td className="p-4 text-[#7A7A7A] whitespace-nowrap">
                      {a.createdAt
                        ? new Date(a.createdAt).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })
                        : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
