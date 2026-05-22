"use client";

import { useState } from "react";
import useSWR from "swr";
import { Megaphone, Plus, Users, CheckCircle2, Globe, Building2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAnnouncements } from "@/lib/hooks/use-announcements";

const inputCls =
  "w-full border-2 border-ink/15 bg-surface rounded-xl px-4 py-2.5 text-sm text-ink placeholder:text-ink-4 transition-colors";

function AnnouncementModal({
  onClose,
  onSent,
}: {
  onClose: () => void;
  onSent: (count: number) => void;
}) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [orgUnitId, setOrgUnitId] = useState<string>("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: teamsData } = useSWR("/admin/teams", (url: string) => apiFetch<any>(url));
  const teams: any[] = teamsData?.data ?? [];

  const selectedTeam = orgUnitId ? teams.find((t: any) => t.id === orgUnitId) : null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim() || !message.trim()) {
      setError("Title and message are required.");
      return;
    }
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
      onSent(res?.data?.recipientCount ?? 0);
    } catch (err: any) {
      setError(err?.message || "Failed to send announcement.");
      setConfirming(false);
    } finally {
      setSending(false);
    }
  }

  const audienceLabel = selectedTeam ? `Team: ${selectedTeam.name}` : "All active employees";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" onClick={onClose}>
      <div className="v3-card shadow-pop w-full max-w-lg overflow-hidden pop-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b-2 border-ink/10">
          <h2 className="font-bold text-ink flex items-center gap-2">
            <Megaphone size={18} className="text-action-deep" />
            {confirming ? "Confirm broadcast" : "New Announcement"}
          </h2>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-muted transition-colors text-ink-4 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {confirming ? (
          <div className="p-6 space-y-4">
            <p className="text-sm text-ink-3">
              This will notify <strong>{audienceLabel}</strong> via portal and email. You can&apos;t undo this.
            </p>
            <div className="v3-card-inset p-4 space-y-2">
              <p className="text-xs font-bold text-ink-4 uppercase tracking-wider">Preview</p>
              <p className="text-sm font-semibold text-ink">{title}</p>
              <p className="text-sm text-ink-3 whitespace-pre-wrap leading-relaxed">{message}</p>
              <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-ink/10">
                {orgUnitId ? <Building2 size={12} className="text-ink-4" /> : <Globe size={12} className="text-ink-4" />}
                <span className="text-xs text-ink-4">{audienceLabel}</span>
              </div>
            </div>
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={sending}
                className="px-5 py-2 rounded-full border-2 border-ink/15 text-sm text-ink-3 hover:bg-muted transition-colors disabled:opacity-50"
              >
                Back
              </button>
              <button
                type="button"
                onClick={doSend}
                disabled={sending}
                className="px-5 py-2.5 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                <Megaphone size={15} />
                {sending ? "Sending…" : "Yes, send now"}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            <div>
              <label className="text-xs font-bold text-ink-4 uppercase tracking-wider mb-1.5 block">Send to</label>
              <div className="relative">
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
              </div>
              <p className="text-xs text-ink-4 mt-1">
                {orgUnitId && selectedTeam
                  ? `Only members of "${selectedTeam.name}" will be notified.`
                  : "All active employees will be notified."}
              </p>
            </div>

            <div>
              <div className="flex justify-between mb-1.5">
                <label className="text-xs font-bold text-ink-4 uppercase tracking-wider">Title</label>
                <span className="text-xs text-ink-4">{title.length}/120</span>
              </div>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value.slice(0, 120))}
                placeholder="e.g., Office closed on Monday"
                required
                className={inputCls}
              />
            </div>

            <div>
              <div className="flex justify-between mb-1.5">
                <label className="text-xs font-bold text-ink-4 uppercase tracking-wider">Message</label>
                <span className="text-xs text-ink-4">{message.length}/2000</span>
              </div>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, 2000))}
                placeholder="Write your announcement here..."
                required
                rows={6}
                className={`${inputCls} resize-none`}
              />
            </div>

            {error && (
              <p className="text-xs text-danger bg-danger/5 rounded-lg px-3 py-2">{error}</p>
            )}

            <div className="flex items-center gap-3 pt-1">
              <p className="text-xs text-ink-4 flex-1">
                {orgUnitId && selectedTeam
                  ? `Sends to "${selectedTeam.name}" members only.`
                  : "Sends to all active employees."}
              </p>
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2 rounded-full border-2 border-ink/15 text-sm text-ink-3 hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-5 py-2.5 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors flex items-center gap-2"
              >
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
    <div className="space-y-5 pop-in">
      {toast && (
        <div className="fixed top-5 right-5 z-50 v3-card shadow-pop px-5 py-3 flex items-center gap-2 toast-pop">
          <CheckCircle2 size={16} className="text-sage" />
          <span className="text-sm font-medium text-ink">{toast}</span>
        </div>
      )}

      {modalOpen && (
        <AnnouncementModal
          onClose={() => setModalOpen(false)}
          onSent={handleSent}
        />
      )}

      <div className="flex items-end justify-between">
        <div>
          <p className="text-xs font-bold text-ink-4 uppercase tracking-widest mb-1">Broadcast</p>
          <h1 className="font-display text-3xl font-semibold text-ink leading-tight">Announcements</h1>
          <p className="text-sm text-ink-3 mt-0.5">History of every broadcast sent to the team</p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="hidden sm:flex items-center gap-2 px-4 py-2.5 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors"
        >
          <Plus size={16} />
          New Announcement
        </button>
      </div>

      <div className="v3-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-ink/10 bg-muted/40">
                <th className="text-left px-4 py-3 text-ink-4 text-xs font-bold uppercase tracking-wider">Title</th>
                <th className="text-left px-4 py-3 text-ink-4 text-xs font-bold uppercase tracking-wider">Message</th>
                <th className="text-left px-4 py-3 text-ink-4 text-xs font-bold uppercase tracking-wider">Sent by</th>
                <th className="text-left px-4 py-3 text-ink-4 text-xs font-bold uppercase tracking-wider">Audience</th>
                <th className="text-left px-4 py-3 text-ink-4 text-xs font-bold uppercase tracking-wider">Recipients</th>
                <th className="text-left px-4 py-3 text-ink-4 text-xs font-bold uppercase tracking-wider">Date</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <tr key={i} className="border-b border-rule">
                    {[...Array(6)].map((__, j) => (
                      <td key={j} className="px-4 py-4">
                        <div className="h-4 bg-muted rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : announcements.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-10 text-center text-ink-4">
                    <Megaphone size={28} className="mx-auto mb-3 opacity-25" />
                    <p className="font-bold text-ink mb-1">No announcements yet</p>
                    <p className="text-xs">Click &quot;New Announcement&quot; to broadcast a message.</p>
                  </td>
                </tr>
              ) : (
                announcements.map((a: any) => (
                  <tr key={a.id} className="border-b border-rule last:border-0 v3-row">
                    <td className="px-4 py-4 font-semibold text-ink max-w-[200px] truncate">
                      {a.title}
                    </td>
                    <td className="px-4 py-4 text-ink-3 max-w-[280px]">
                      <p className="line-clamp-2 leading-relaxed">{a.message}</p>
                    </td>
                    <td className="px-4 py-4 text-ink">{a.sentBy?.name ?? "—"}</td>
                    <td className="px-4 py-4">
                      {a.orgUnit ? (
                        <span className="inline-flex items-center gap-1 bg-indigo/10 text-indigo rounded-full px-2.5 py-1 text-xs font-medium border border-indigo/20">
                          <Building2 size={10} />
                          {a.orgUnit.name}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 bg-muted text-ink-4 rounded-full px-2.5 py-1 text-xs font-medium">
                          <Globe size={10} />
                          Everyone
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <span className="inline-flex items-center gap-1 bg-action/20 text-action-deep rounded-full px-3 py-1 text-xs font-bold border border-action/30">
                        <Users size={11} />
                        {a.recipientCount}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-ink-4 whitespace-nowrap">
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
