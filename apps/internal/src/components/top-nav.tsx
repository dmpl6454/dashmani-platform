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
import { bellListView, pipelineNotificationUrl, salesNotificationUrl } from "@dashmani/shared/src/pipeline/bell";

/* ── Compose-announcement modal (moved from dashboard — the only place it's used) ──
   Opened from the dark DsTopNav (the legacy TopNav was removed 2026-11-06), so it is drawn in the "ds" dark palette. It portals to <body>, outside the
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
