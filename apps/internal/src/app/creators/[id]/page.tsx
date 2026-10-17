"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronLeft, ExternalLink, Facebook, Instagram } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { useCreatorDetail, type AdminAssetView, type AdminCreatorDetail } from "@/lib/hooks/use-creators";
import { BTN_GHOST, BTN_GOLD, BTN_RED, CARD, INPUT, ErrorBar, PageHead, Pill, compact, fmtWhen } from "../../campaigns/_ds";
import { PayoutAccountCard } from "../_payout";
import { ConnectionPill, CreatorStatusPill } from "../_status";

type Action = "approve" | "reject" | "suspend" | "reinstate";

const ACTIONS: Record<Action, { label: string; title: string; text: string; noteRequired: boolean; noteLabel: string; danger: boolean }> = {
  approve: {
    label: "Approve",
    title: "Approve this creator?",
    text: "They are emailed that they are approved. Their pages stay switched off until you turn each one on below.",
    noteRequired: false,
    noteLabel: "Note to the creator (optional)",
    danger: false,
  },
  reject: {
    label: "Reject",
    title: "Reject this application?",
    text: "They are emailed your note and can fix it and submit again.",
    noteRequired: true,
    noteLabel: "Why (sent to the creator)",
    danger: true,
  },
  suspend: {
    label: "Suspend",
    title: "Suspend this creator?",
    text: "Every one of their pages is switched off at once. They can still sign in but change nothing. They are emailed your note.",
    noteRequired: true,
    noteLabel: "Why (sent to the creator)",
    danger: true,
  },
  reinstate: {
    label: "Reinstate",
    title: "Reinstate this creator?",
    text: "Their account becomes approved again. Their pages stay off until you turn each one back on.",
    noteRequired: false,
    noteLabel: "Note to the creator (optional)",
    danger: false,
  },
};

const DONE: Record<Action, string> = { approve: "Approved", reject: "Rejected", suspend: "Suspended", reinstate: "Reinstated" };

/**
 * The note after a bank change request was closed. "Processed" is the only one that says the payout account was
 * updated and that payouts stay paused for 72 hours; "closed without a change" says neither.
 */
function bankChangeInfo(kind: "processed" | "declined", emailSkipped: boolean, emailSent: boolean | undefined): string {
  if (kind === "declined") {
    if (emailSkipped) return "Request closed without a change. The creator's account is closed, so no email was sent. Nothing about their payout account changed, and no payout pause applies.";
    return emailSent === false
      ? "Request closed without a change — but the email to the creator could not be sent, so tell them another way. Nothing about their payout account changed, and no payout pause applies."
      : "Request closed without a change — the creator has been emailed that nothing changed. No payout pause applies.";
  }
  if (emailSkipped) return "Bank change marked processed. The creator's account is closed, so no email was sent. Their payouts stay paused for 72 hours.";
  return emailSent === false
    ? "Bank change marked processed — but the email to the creator could not be sent, so tell them another way. Their payouts stay paused for 72 hours."
    : "Bank change marked processed — the creator has been emailed. Their payouts stay paused for 72 hours.";
}

const ACTIONS_FOR: Record<string, Action[]> = {
  in_review: ["approve", "reject"],
  approved: ["suspend"],
  suspended: ["reinstate"],
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-2 border-b border-[#132430] last:border-0 text-[13px]">
      <div className="w-[150px] shrink-0 text-ds-t3">{label}</div>
      <div className="min-w-0 flex-1 text-ds-text break-words">{children}</div>
    </div>
  );
}

/** Days until an ISO date, as a short honest phrase. */
function expiry(iso: string | null) {
  if (!iso) return "—";
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  const when = fmtWhen(iso);
  if (days < 0) return <span className="text-[#FB7185]">Expired {when}</span>;
  if (days <= 7) return <span className="text-ds-gold">{when} (in {days} day{days === 1 ? "" : "s"})</span>;
  return <>{when} (in {days} days)</>;
}

function ConfirmDialog({
  action, busy, error, onCancel, onConfirm,
}: { action: Action; busy: boolean; error: string; onCancel: () => void; onConfirm: (note: string) => void }) {
  const a = ACTIONS[action];
  const [note, setNote] = useState("");
  const tooShort = a.noteRequired && note.trim().length < 3;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="creator-confirm-title" className={`${CARD} w-full max-w-[480px] p-5`}>
        <h2 id="creator-confirm-title" className="text-[16px] font-semibold text-ds-text">{a.title}</h2>
        <p className="mt-1.5 text-[13px] text-ds-t2">{a.text}</p>
        <label className="block mt-4">
          <span className="block text-[12px] text-ds-t3 mb-1.5">{a.noteLabel}</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            rows={4}
            autoFocus
            aria-invalid={a.noteRequired && note.length > 0 && tooShort}
            className={`${INPUT} h-auto py-2 resize-y`}
          />
          {a.noteRequired && <span className="block mt-1 text-[11.5px] text-ds-t4">Required — at least 3 characters.</span>}
        </label>
        {error && <div className="mt-3"><ErrorBar message={error} /></div>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={BTN_GHOST} onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            type="button"
            className={a.danger ? BTN_RED : BTN_GOLD}
            disabled={busy || tooShort}
            onClick={() => onConfirm(note.trim())}
          >
            {busy ? "Working…" : a.label}
          </button>
        </div>
      </div>
    </div>
  );
}

function AssetRow({
  a, creatorId, onChanged,
}: { a: AdminAssetView; creatorId: string; onChanged: (next: AdminAssetView) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const toggle = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await apiFetch<{ data: AdminAssetView }>(`/admin/creators/${creatorId}/assets/${a.id}`, {
        method: "PUT",
        body: JSON.stringify({ enabled: !a.enabled }),
      });
      onChanged(r.data);
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };
  const isIg = a.kind === "instagram_account";
  return (
    <tr className="border-b border-[#132430] last:border-0 align-top">
      <td className="px-5 py-3">
        <div className="flex items-center gap-3 min-w-0">
          {a.pictureUrl ? (
            <img src={a.pictureUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-9 w-9 rounded-full object-cover bg-ds-inset shrink-0" />
          ) : (
            <span className="h-9 w-9 rounded-full bg-ds-inset grid place-items-center text-ds-t3 shrink-0">
              {isIg ? <Instagram className="h-4 w-4" /> : <Facebook className="h-4 w-4" />}
            </span>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="font-semibold text-ds-text truncate max-w-[220px]" title={a.name}>{a.name}</span>
              {a.profileUrl && (
                <a href={a.profileUrl} target="_blank" rel="noopener noreferrer" className="text-ds-t3 hover:text-ds-text shrink-0" aria-label={`Open ${a.name} on ${isIg ? "Instagram" : "Facebook"}`}>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            <div className="text-[11.5px] text-ds-t3 truncate">{a.username ? `@${a.username} · ` : ""}{isIg ? "Instagram" : "Facebook Page"}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-3 text-right tabular-nums text-ds-text">{compact(a.followerCount)}</td>
      <td className="px-3 py-3 text-right tabular-nums text-ds-t2">{compact(a.views28d)}</td>
      <td className="px-3 py-3">
        {a.canPublish ? (
          <Pill label="Can publish" color="#00D7A0" />
        ) : (
          <div>
            <Pill label="Can't publish" color="#FB7185" />
            {a.publishProbeError && <div className="mt-1 text-[11.5px] text-ds-t3 max-w-[240px]">{a.publishProbeError}</div>}
          </div>
        )}
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-col gap-1 items-start">
          {a.networkDuplicate && (
            <span title={a.networkDuplicateOfName ? `On our network as “${a.networkDuplicateOfName}”` : "Already on our network"}>
              <Pill label="On our network" color="#238BFF" />
            </span>
          )}
          {a.disconnected && <Pill label="Disconnected" color="#4E5F70" />}
          {!a.networkDuplicate && !a.disconnected && <span className="text-ds-t4">—</span>}
        </div>
      </td>
      <td className="px-5 py-3">
        <button
          type="button"
          role="switch"
          aria-checked={a.enabled}
          aria-label={`${a.enabled ? "Turn off" : "Turn on"} ${a.name}`}
          disabled={busy}
          onClick={toggle}
          className={`relative inline-flex h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${a.enabled ? "bg-ds-teal" : "bg-ds-line2"}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${a.enabled ? "translate-x-[22px]" : "translate-x-0.5"}`} />
        </button>
        {err && <div role="alert" className="mt-1.5 text-[11.5px] text-[#FB7185] max-w-[220px]">{err}</div>}
      </td>
    </tr>
  );
}

export default function CreatorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, mutate, isValidating } = useCreatorDetail(id);
  usePageTitle(data?.creator.name ?? "Creator");
  const [pending, setPending] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogErr, setDialogErr] = useState("");
  const [info, setInfo] = useState("");
  /** The action worked but its email didn't go out: show the note in the warning tone. */
  const [infoWarn, setInfoWarn] = useState(false);

  if (error && !data) return <div className="pt-8"><ErrorBar message={error.message || "Couldn't load this creator."} /></div>;
  if (!data) return <div className="pt-8 text-ds-t3 text-[13px]">Loading…</div>;

  const { creator: c, connection: conn, assets } = data;
  const actions = ACTIONS_FOR[c.status] ?? [];
  const live = assets.filter((a) => !a.disconnected);
  const publishable = live.filter((a) => a.canPublish && !a.networkDuplicate).length;

  const run = async (action: Action, note: string) => {
    setBusy(true);
    setDialogErr("");
    try {
      const r = await apiFetch<{ data: AdminCreatorDetail }>(`/admin/creators/${c.id}/${action}`, {
        method: "POST",
        body: JSON.stringify(note ? { note } : {}),
      });
      const { emailSent, ...detail } = r.data;
      await mutate(detail, { revalidate: false });
      setPending(null);
      // An older API sends no flag: keep the old sentence rather than claim a failure.
      setInfoWarn(emailSent === false);
      setInfo(
        emailSent === false
          ? `${DONE[action]} — but the email to the creator could not be sent, so tell them another way.`
          : `${DONE[action]} — the creator has been emailed.`,
      );
    } catch (e) {
      setDialogErr(e instanceof Error && e.message ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  const onAssetChanged = (next: AdminAssetView) => {
    mutate((prev) => (prev ? { ...prev, assets: prev.assets.map((a) => (a.id === next.id ? next : a)) } : prev), { revalidate: false });
  };

  return (
    <div className="pb-10">
      <Link href="/creators" className="mt-6 inline-flex items-center gap-1 text-[12.5px] text-ds-t3 hover:text-ds-text"><ChevronLeft className="h-4 w-4" />All creators</Link>
      <PageHead
        title={c.name}
        sub={<>{c.email}{c.country ? ` · ${c.country}` : ""} · {live.length} page{live.length === 1 ? "" : "s"} · {publishable} publishable</>}
        right={<CreatorStatusPill status={c.status} />}
      />

      {info && (
        <div
          role={infoWarn ? "alert" : "status"}
          className={`mb-4 px-3.5 py-2.5 rounded-[8px] text-[12.5px] flex justify-between gap-3 ${
            infoWarn
              ? "bg-[rgba(233,189,98,.08)] border border-[rgba(233,189,98,.35)] text-ds-gold"
              : "bg-[rgba(0,215,160,.08)] border border-[rgba(0,215,160,.3)] text-ds-teal"
          }`}
        >
          <span>{info}</span>
          <button type="button" className="hover:text-ds-text" onClick={() => setInfo("")} aria-label="Dismiss">×</button>
        </div>
      )}

      {actions.length > 0 && (
        <section className={`${CARD} p-5 mb-4 flex flex-wrap items-center gap-3`}>
          <div className="flex-1 min-w-[220px] text-[13px] text-ds-t2">
            {c.status === "in_review" && "This creator asked to be reviewed. Check their pages below, then approve or reject."}
            {c.status === "approved" && "Approved. Suspend to switch off all their pages at once."}
            {c.status === "suspended" && "Suspended. Reinstating makes them approved again; their pages stay off."}
          </div>
          {actions.map((a) => (
            <button
              key={a}
              type="button"
              className={ACTIONS[a].danger ? BTN_RED : BTN_GOLD}
              onClick={() => { setDialogErr(""); setInfo(""); setPending(a); }}
            >
              {ACTIONS[a].label}
            </button>
          ))}
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2 mb-4">
        <section className={`${CARD} p-5`}>
          <h2 className="text-[15px] font-semibold text-ds-text mb-2">Profile</h2>
          <Row label="Email">{c.email} {c.emailVerified ? <span className="text-ds-teal text-[12px]">· verified</span> : <span className="text-ds-gold text-[12px]">· not verified</span>}</Row>
          <Row label="Country">{c.country ?? "—"}</Row>
          <Row label="Phone">{c.phone ?? "—"}</Row>
          <Row label="Terms">{c.termsAccepted ? "Accepted" : "Not accepted"}</Row>
          <Row label="Signed up">{fmtWhen(c.createdAt)}</Row>
          <Row label="Submitted">{fmtWhen(c.submittedAt)}</Row>
          <Row label="Last review">{c.reviewedAt ? <>{fmtWhen(c.reviewedAt)}{c.reviewedByName ? ` by ${c.reviewedByName}` : ""}</> : "—"}</Row>
          {c.reviewNote && <Row label="Review note"><span className="whitespace-pre-wrap">{c.reviewNote}</span></Row>}
          {c.closedAt && <Row label="Closed">{fmtWhen(c.closedAt)}</Row>}
        </section>

        <section className={`${CARD} p-5`}>
          <h2 className="text-[15px] font-semibold text-ds-text mb-2">Facebook connection</h2>
          {!conn ? (
            <p className="text-[13px] text-ds-t3">This creator hasn&apos;t connected Facebook yet.</p>
          ) : (
            <>
              <Row label="Status"><ConnectionPill status={conn.status} /></Row>
              <Row label="Facebook account">{conn.metaUserName ?? "—"}</Row>
              <Row label="Connected">{fmtWhen(conn.connectedAt)}</Row>
              <Row label="Token expires">{expiry(conn.tokenExpiresAt)}</Row>
              <Row label="Data access expires">{expiry(conn.dataAccessExpiresAt)}</Row>
              <Row label="Missing permissions">
                {conn.missingScopes.length === 0 ? <span className="text-ds-teal">None</span> : <span className="text-ds-gold">{conn.missingScopes.join(", ")}</span>}
              </Row>
              <Row label="Page discovery">{conn.discoveryState}</Row>
              {conn.lastError && <Row label="Last error"><span className="text-[#FB7185]">{conn.lastError}</span></Row>}
            </>
          )}
        </section>
      </div>

      <PayoutAccountCard
        creatorId={c.id}
        detail={data}
        refreshing={isValidating}
        refreshFailed={!!error}
        onRefresh={() => { void mutate(); }}
        onProcessed={(next, result) => {
          void mutate(next, { revalidate: false });
          // An older API sends no flag: say only what is known rather than claim a failure. A mail left out on purpose
          // (the creator's account is closed) is not a failure to send, so it is not drawn in the warning tone.
          const skipped = result.emailSkipped === "creator_closed";
          setInfoWarn(!skipped && result.emailSent === false);
          setInfo(bankChangeInfo(result.kind, skipped, result.emailSent));
        }}
      />

      <section className={`${CARD} overflow-hidden`}>
        <div className="px-5 pt-5 pb-3">
          <h2 className="text-[15px] font-semibold text-ds-text">Pages</h2>
          <p className="mt-1 text-[12.5px] text-ds-t3">
            A page can be turned on only when the creator is approved, it is connected, we can publish to it, and it isn&apos;t already on our network. Turning a page on does not offer it for booking yet.
          </p>
        </div>
        {assets.length === 0 ? (
          <div className="py-10 text-center text-ds-t3 text-[13px] border-t border-[#132430]">No pages connected.</div>
        ) : (
          <div className="overflow-x-auto border-t border-[#132430]">
            <table className="w-full text-[13px] min-w-[820px]">
              <thead>
                <tr className="text-left text-[11.5px] uppercase tracking-[.06em] text-ds-t3 border-b border-[#132430]">
                  <th className="px-5 py-3 font-semibold">Page</th>
                  <th className="px-3 py-3 font-semibold text-right">Followers</th>
                  <th className="px-3 py-3 font-semibold text-right">Views 28d</th>
                  <th className="px-3 py-3 font-semibold">Publishing</th>
                  <th className="px-3 py-3 font-semibold">Flags</th>
                  <th className="px-5 py-3 font-semibold">On</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => <AssetRow key={a.id} a={a} creatorId={c.id} onChanged={onAssetChanged} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {pending && (
        <ConfirmDialog
          action={pending}
          busy={busy}
          error={dialogErr}
          onCancel={() => setPending(null)}
          onConfirm={(note) => run(pending, note)}
        />
      )}
    </div>
  );
}
