"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAnnouncements } from "@/lib/hooks/use-announcements";
import { ModalPortal } from "@/components/modal-portal";

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HUES = ["#238BFF", "#E9BD62", "#9B7EDE", "#00D7A0", "#FB7185", "#6EB2FF"];
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
};
const initials = (name: string) =>
  name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "?";
const fdY = (v: string) => {
  const d = new Date(v);
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
};

const MEGA = "M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13";
const GLOBE = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20";
const BLDG = "M4 22V3h11v19M15 9h5v13M8 7h3M8 11h3M8 15h3M2 22h20";
const USERS = "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8";
const CHECK = "M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4L12 14l-3-3";

function Icon({ d, className = "h-4 w-4", sw = 2 }: { d: string; className?: string; sw?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" className={`${className} shrink-0`} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const LABEL = "text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase";
const FIELD =
  "w-full h-[46px] px-4 rounded-[12px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13.5px] outline-none focus:border-[rgba(233,189,98,.6)] placeholder:text-ds-t4 [color-scheme:dark] min-w-0";
const GRID =
  "grid gap-x-[14px] items-center [grid-template-columns:minmax(160px,22fr)_minmax(180px,30fr)_minmax(130px,15fr)_minmax(104px,12fr)_minmax(76px,8fr)_minmax(96px,11fr)]";
const GHOST_BTN =
  "h-[42px] px-5 rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold whitespace-nowrap hover:text-ds-text hover:border-[#2A4658] disabled:opacity-60";
const GOLD_BTN =
  "inline-flex items-center gap-2 h-[42px] px-5 rounded-full bg-ds-gold text-[#060D14] text-[13px] font-bold whitespace-nowrap hover:bg-[#F4D58C] disabled:opacity-60";

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

  const { data: teamsData } = useSWR("/teams", (url: string) => apiFetch<any>(url));
  const teams: any[] = teamsData?.data ?? [];

  const selectedTeam = orgUnitId ? teams.find((t: any) => t.id === orgUnitId) : null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

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
    <ModalPortal>
      <div className="ds-root contents">
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(2,6,10,.72)]"
          onClick={() => !sending && onClose()}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={confirming ? "Confirm broadcast" : "New Announcement"}
            className="relative w-full max-w-[540px] max-h-[90vh] flex flex-col bg-ds-card border border-ds-line2 rounded-[18px] shadow-[0_24px_60px_rgba(0,0,0,.6)] overflow-hidden"
          >
            <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,#E9BD62_30%,#E9BD62_70%,transparent)]" />
            <div className="flex items-center justify-between px-6 py-[18px] border-b border-[#1A2C38]">
              <span className="flex items-center gap-2.5 text-[16px] font-semibold text-ds-text">
                <span className="text-ds-gold flex"><Icon d={MEGA} className="h-[17px] w-[17px]" sw={1.9} /></span>
                {confirming ? "Confirm broadcast" : "New Announcement"}
              </span>
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                aria-label="Close"
                className="h-[30px] w-[30px] rounded-[8px] grid place-items-center text-ds-t3 hover:bg-[#132430] hover:text-ds-text disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {confirming ? (
              <div className="px-6 py-[22px] flex flex-col gap-4 overflow-y-auto">
                <p className="text-[13.5px] leading-[1.55] text-ds-t2">
                  This will notify <b className="text-ds-text font-semibold">{audienceLabel}</b> via portal and email. You can&apos;t undo this.
                </p>
                <div className="p-[18px] rounded-[14px] bg-ds-inset border border-[#1A2C38] flex flex-col gap-2">
                  <span className={LABEL}>Preview</span>
                  <span className="text-[15px] font-semibold text-ds-text [overflow-wrap:anywhere]">{title}</span>
                  <span className="text-[13px] leading-[1.6] text-ds-t2 whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</span>
                  <span className="flex items-center gap-1.5 mt-1 pt-2.5 border-t border-[#1A2C38] text-[12px] text-ds-t3">
                    <Icon d={orgUnitId ? BLDG : GLOBE} className="h-3 w-3" />
                    {audienceLabel}
                  </span>
                </div>
                {error && (
                  <div className="px-3 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[#FB7185] text-[12.5px]">{error}</div>
                )}
                <div className="flex justify-end gap-2.5 flex-wrap">
                  <button type="button" onClick={() => setConfirming(false)} disabled={sending} className={GHOST_BTN}>
                    Back
                  </button>
                  <button type="button" onClick={doSend} disabled={sending} className={GOLD_BTN}>
                    <Icon d={MEGA} className="h-3.5 w-3.5" />
                    {sending ? "Sending…" : "Yes, send now"}
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="px-6 py-[22px] flex flex-col gap-[18px] overflow-y-auto">
                <label className="flex flex-col gap-[7px]">
                  <span className={LABEL}>Send to</span>
                  <select value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)} className={`${FIELD} cursor-pointer`}>
                    <option value="" className="bg-ds-card">Everyone (all active employees)</option>
                    {teams.map((t: any) => (
                      <option key={t.id} value={t.id} className="bg-ds-card">Team: {t.name}</option>
                    ))}
                  </select>
                  <span className="text-[12px] text-ds-t3">
                    {orgUnitId && selectedTeam
                      ? `Only members of "${selectedTeam.name}" will be notified.`
                      : "All active employees will be notified."}
                  </span>
                </label>

                <label className="flex flex-col gap-[7px]">
                  <span className="flex justify-between">
                    <span className={LABEL}>Title</span>
                    <span className="text-[11.5px] text-ds-t3 tabular-nums">{title.length}/120</span>
                  </span>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value.slice(0, 120))}
                    placeholder="e.g., Office closed on Monday"
                    required
                    className={FIELD}
                  />
                </label>

                <label className="flex flex-col gap-[7px]">
                  <span className="flex justify-between">
                    <span className={LABEL}>Message</span>
                    <span className="text-[11.5px] text-ds-t3 tabular-nums">{message.length}/2000</span>
                  </span>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value.slice(0, 2000))}
                    placeholder="Write your announcement here..."
                    required
                    rows={6}
                    className={`${FIELD} h-auto py-3.5 resize-none leading-[1.55]`}
                  />
                </label>

                {error && (
                  <div className="px-3 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[#FB7185] text-[12.5px]">{error}</div>
                )}

                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="flex-[1_1_160px] text-[12px] text-ds-t3">
                    {orgUnitId && selectedTeam
                      ? `Sends to "${selectedTeam.name}" members only.`
                      : "Sends to all active employees."}
                  </span>
                  <button type="button" onClick={onClose} className={GHOST_BTN}>
                    Cancel
                  </button>
                  <button type="submit" className={GOLD_BTN}>
                    <Icon d={MEGA} className="h-3.5 w-3.5" />
                    Review &amp; send
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}

export default function AnnouncementsPage() {
  const { announcements, isLoading, isError, mutate } = useAnnouncements();
  const [modalOpen, setModalOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function handleSent(count: number) {
    setModalOpen(false);
    setToast(`Announcement sent to ${count} employee${count !== 1 ? "s" : ""}.`);
    mutate();
    setTimeout(() => setToast(null), 4000);
  }

  return (
    <div className="pb-8">
      {toast && (
        <div
          role="status"
          className="fixed top-5 right-5 left-5 sm:left-auto z-[60] flex items-center gap-2.5 px-[18px] py-[13px] rounded-[14px] bg-ds-inset border border-[rgba(0,215,160,.4)] shadow-[0_14px_36px_rgba(0,0,0,.5)] text-[13px] font-medium text-ds-text"
        >
          <span className="text-ds-teal flex"><Icon d={CHECK} /></span>
          {toast}
        </div>
      )}

      {modalOpen && <AnnouncementModal onClose={() => setModalOpen(false)} onSent={handleSent} />}

      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_320px] min-w-0">
          <div className="text-[11px] font-semibold tracking-[.16em] uppercase text-ds-gold">Broadcast</div>
          <h1 className="mt-1.5 text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Announcements</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">History of every broadcast sent to the team</p>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-2 h-[46px] px-[22px] rounded-full bg-ds-gold text-[#060D14] text-[14px] font-bold whitespace-nowrap hover:bg-[#F4D58C]"
        >
          <Icon d="M12 5v14M5 12h14" className="h-[15px] w-[15px]" sw={2.4} />
          New Announcement
        </button>
      </section>

      {/* Table */}
      <section className="rounded-[16px] border border-[#2A4658] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)]">
        <div className="overflow-x-auto [color-scheme:dark]">
          <div className="min-w-[820px]">
            <div className={`${GRID} h-[52px] px-5 bg-ds-inset border-b border-ds-line2 text-[11px] font-semibold tracking-[.08em] uppercase text-ds-t3 whitespace-nowrap`}>
              <span>Title</span><span>Message</span><span>Sent by</span><span>Audience</span><span>Recipients</span><span>Date</span>
            </div>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`${GRID} h-[84px] px-5 border-b border-[#132430]`}>
                  {Array.from({ length: 6 }).map((__, j) => (
                    <div key={j} className="h-3.5 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                  ))}
                </div>
              ))
            ) : isError ? (
              <div className="py-14 px-5 text-center text-ds-t3 text-[13px]">Announcements couldn&apos;t be loaded just now. Refresh to try again.</div>
            ) : announcements.length === 0 ? (
              <div className="py-14 px-5 flex flex-col items-center gap-2.5 text-ds-t3 text-[12.5px] text-center">
                <Icon d={MEGA} className="h-[30px] w-[30px]" sw={1.5} />
                <span className="text-[14px] font-semibold text-ds-text">No announcements yet</span>
                Click &quot;New Announcement&quot; to broadcast a message.
              </div>
            ) : (
              announcements.map((a: any) => {
                const by: string | null = a.sentBy?.name ?? null;
                const hue = by ? HUES[hash(by) % HUES.length] : "#738395";
                const team = !!a.orgUnit;
                const auColor = team ? "#9B7EDE" : "#A7B3C2";
                return (
                  <div key={a.id} className={`${GRID} min-h-[84px] py-3 px-5 border-b border-[#132430] last:border-b-0 text-[13.5px] hover:bg-[#0A1620] transition-colors`}>
                    <span title={a.title} className="font-semibold text-ds-text leading-[1.4] line-clamp-2 [overflow-wrap:anywhere]">
                      {a.title}
                    </span>
                    <span title={a.message} className="text-ds-t2 text-[13px] leading-[1.55] line-clamp-2 [overflow-wrap:anywhere]">
                      {a.message}
                    </span>
                    <span className="flex items-center gap-2.5 min-w-0">
                      {by ? (
                        <>
                          <span
                            className="h-[30px] w-[30px] rounded-full grid place-items-center text-[11px] font-bold shrink-0"
                            style={{ background: rgba(hue, 0.16), color: hue }}
                          >
                            {initials(by)}
                          </span>
                          <span className="text-[#E3E8EE] leading-[1.3] min-w-0 truncate">{by}</span>
                        </>
                      ) : (
                        <span className="text-[#4A6275]">—</span>
                      )}
                    </span>
                    <span className="flex items-center min-w-0">
                      <span
                        className="inline-flex items-center gap-1.5 h-7 px-[11px] rounded-full border text-[12px] font-semibold whitespace-nowrap max-w-full overflow-hidden"
                        style={
                          team
                            ? { background: rgba(auColor, 0.12), borderColor: rgba(auColor, 0.35), color: auColor }
                            : { background: "#0F1F2B", borderColor: "#223543", color: auColor }
                        }
                        title={team ? a.orgUnit.name : "Everyone"}
                      >
                        <Icon d={team ? BLDG : GLOBE} className="h-3 w-3" />
                        <span className="truncate">{team ? a.orgUnit.name : "Everyone"}</span>
                      </span>
                    </span>
                    <span className="flex items-center">
                      <span className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-[rgba(233,189,98,.12)] border border-[rgba(233,189,98,.35)] text-ds-gold text-[12px] font-bold tabular-nums">
                        <Icon d={USERS} className="h-3 w-3" />
                        {a.recipientCount ?? "—"}
                      </span>
                    </span>
                    <span className="text-ds-t2 whitespace-nowrap tabular-nums">{a.createdAt ? fdY(a.createdAt) : "—"}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
