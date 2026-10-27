"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { ChevronLeft, Plus } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { BTN_GOLD, BTN_RED, CARD, ErrorBar, PageHead, Pill, fmtWhen } from "../_ds";

// Phase 3: YouTube channels connected for campaign auto-upload. Admins connect a channel with
// Google; approved campaign items on that channel are then uploaded automatically while
// CAMPAIGN_YOUTUBE_PUBLISH_ENABLED=1. Tokens never reach this page.

type Connection = {
  id: string;
  channelId: string;
  channelTitle: string;
  googleEmail: string | null;
  status: "active" | "needs_reauth" | "revoked";
  lastError: string | null;
  connectedBy: string | null;
  createdAt: string;
  updatedAt: string;
  account: { id: string; name: string; onRateCard: boolean } | null;
};
type Payload = {
  configured: boolean;
  missing: string[];
  publishEnabled: boolean;
  dailyUploads: number;
  privacy: string;
  redirectUri: string;
  connections: Connection[];
};

const STATUS: Record<Connection["status"], { label: string; color: string }> = {
  active: { label: "Connected", color: "#00D7A0" },
  needs_reauth: { label: "Reconnect needed", color: "#E9BD62" },
  revoked: { label: "Disconnected", color: "#4E5F70" },
};

const ERRORS: Record<string, string> = {
  expired: "The connect link expired or wasn't started here. Try again.",
  denied: "Google sign-in was cancelled.",
  google: "Google returned an error. Try again.",
  no_code: "Google didn't return a sign-in code. Try again.",
  exchange_failed: "Google didn't accept the sign-in. Try again.",
  upload_not_granted: "The upload permission wasn't granted. Connect again and allow uploading.",
  no_channel: "That Google account has no YouTube channel.",
  no_refresh_token: "Google returned no offline access. Remove this app's access in the Google account's security settings, then connect again.",
  not_configured: "YouTube connect isn't set up on the server.",
};

export default function YoutubeConnectionsPage() {
  usePageTitle("YouTube channels");
  const { data, error, mutate } = useSWR<Payload>("/admin/youtube/connections", (u: string) => apiFetch<{ data: Payload }>(u).then((r) => r.data), { revalidateOnFocus: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  // The OAuth callback lands here with ?connected=<title> or ?error=<code>; show it once.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const c = q.get("connected");
    const e = q.get("error");
    if (c) setOk(`Connected “${c}”.`);
    if (e) setErr(ERRORS[e] ?? "Connecting the channel failed. Try again.");
    if (c || e) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const connect = async () => {
    setErr("");
    setBusy("connect");
    try {
      const r = await apiFetch<{ data: { url: string } }>("/admin/youtube/oauth/start", { method: "POST" });
      window.location.href = r.data.url;
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not start connecting.");
      setBusy(null);
    }
  };

  const disconnect = async (c: Connection) => {
    if (!window.confirm(`Disconnect “${c.channelTitle}”? Approved posts on it will go to "To post" for someone to post by hand.`)) return;
    setErr("");
    setBusy(c.id);
    try {
      await apiFetch(`/admin/youtube/connections/${c.id}`, { method: "DELETE" });
      await mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not disconnect.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pb-24">
      <Link href="/campaigns" className="mt-6 inline-flex items-center gap-1 text-[12.5px] text-ds-t3 hover:text-ds-text"><ChevronLeft className="h-4 w-4" />Campaign bookings</Link>
      <PageHead
        title="YouTube channels"
        sub="Channels connected here get approved campaign Shorts and videos uploaded automatically. Everything else stays in “To post” for our team."
        right={
          <button type="button" className={BTN_GOLD} onClick={connect} disabled={!data?.configured || busy !== null}>
            <Plus className="h-4 w-4" /> Connect a YouTube channel
          </button>
        }
      />

      <div className="space-y-3 mb-4">
        {err && <ErrorBar message={err} onClose={() => setErr("")} />}
        {ok && (
          <div role="status" className="px-3.5 py-2.5 rounded-[8px] bg-[rgba(0,215,160,.08)] border border-[rgba(0,215,160,.3)] text-[#00D7A0] text-[12.5px]">{ok}</div>
        )}
        {error && <ErrorBar message="Couldn't load the YouTube channels. Refresh to try again." />}
      </div>

      {data && (
        <section className={`${CARD} p-5 mb-4 text-[13px] text-ds-t2 space-y-2`}>
          <div className="flex flex-wrap gap-2 items-center">
            <Pill label={data.publishEnabled ? "Auto-upload on" : "Auto-upload off"} color={data.publishEnabled ? "#00D7A0" : "#738395"} />
            <span>Up to {data.dailyUploads} upload{data.dailyUploads === 1 ? "" : "s"} a day · posted as {data.privacy}</span>
          </div>
          {!data.configured && (
            <p className="text-ds-gold">Not set up on the server yet. Missing: {data.missing.join(", ")}.</p>
          )}
          {!data.publishEnabled && (
            <p>Uploading stays off until <code className="text-ds-text">CAMPAIGN_YOUTUBE_PUBLISH_ENABLED=1</code> is set on the server. You can connect channels before that.</p>
          )}
          <p>
            Google&apos;s limits for an app it hasn&apos;t verified: only up to 100 Google accounts can connect, and every uploaded video stays
            <strong className="text-ds-text"> private</strong> until the Google project passes YouTube&apos;s API audit. While that is the case, uploads go to
            “To post” with the video link so someone can make it public and paste the link.
          </p>
          <p className="text-ds-t3 break-all">Google redirect URI: {data.redirectUri}</p>
        </section>
      )}

      <section className={CARD}>
        {!data && !error && <div className="px-5 py-6 text-[13px] text-ds-t3">Loading…</div>}
        {data && data.connections.length === 0 && (
          <div className="px-5 py-6 text-[13px] text-ds-t3">No YouTube channel is connected yet.</div>
        )}
        {data?.connections.map((c, i) => {
          const s = STATUS[c.status] ?? STATUS.revoked;
          return (
            <div key={c.id} className={`flex flex-col md:flex-row md:items-center gap-2 md:gap-4 px-5 py-4 ${i < data.connections.length - 1 ? "border-b border-[#132430]" : ""}`}>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-ds-text truncate">{c.channelTitle}</div>
                <div className="text-[12px] text-ds-t3 truncate">
                  {c.channelId}
                  {c.googleEmail ? ` · ${c.googleEmail}` : ""}
                  {c.connectedBy ? ` · connected by ${c.connectedBy}` : ""} · {fmtWhen(c.updatedAt)}
                </div>
                <div className="text-[12px] mt-0.5 text-ds-t2">
                  {c.account
                    ? `Campaign account: ${c.account.name}${c.account.onRateCard ? "" : " (no price on the rate card yet)"}`
                    : "Not matched to a campaign account yet — the channel needs to be on the Accounts list."}
                </div>
                {c.lastError && c.status !== "active" && <div className="text-[12px] mt-0.5 text-ds-gold">{c.lastError}</div>}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <Pill label={s.label} color={s.color} />
                {c.status === "needs_reauth" && (
                  <button type="button" className={BTN_GOLD} onClick={connect} disabled={!data.configured || busy !== null}>Reconnect</button>
                )}
                {c.status !== "revoked" && (
                  <button type="button" className={BTN_RED} onClick={() => disconnect(c)} disabled={busy !== null}>Disconnect</button>
                )}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}
