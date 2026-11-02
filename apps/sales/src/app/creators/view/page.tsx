"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import { BLOCK_REASON, CONNECTION_LABEL, CREATOR_STATUS_LABEL, useCreator, type CreatorAsset } from "@/lib/creators";
import { Empty, Field, LoadError, Loading, PageHead, StatusPill, Toast } from "@/components/sales-ui";

// One creator: profile, Facebook connection health, their pages, and the review decision.
// The rules (which state may move where, which page may be turned on) live in the API
// (creator-admin.service.ts, shared with the staff portal); this page only asks.

type Action = "approve" | "reject" | "suspend" | "reinstate";
const ACTIONS: Record<Action, { label: string; noteRequired: boolean; danger?: boolean; done: string }> = {
  approve: { label: "Approve", noteRequired: false, done: "Creator approved — we email them. Now turn on the pages to offer." },
  reject: { label: "Reject", noteRequired: true, danger: true, done: "Creator not approved — we email them the reason." },
  suspend: { label: "Suspend", noteRequired: true, danger: true, done: "Creator suspended — their pages are switched off." },
  reinstate: { label: "Reinstate", noteRequired: false, done: "Creator reinstated. Their pages stay off until you turn them on." },
};
const AVAILABLE: Record<string, Action[]> = { in_review: ["approve", "reject"], approved: ["suspend"], suspended: ["reinstate"] };

const compact = (n: number | null) => (n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** NOT_ENABLEABLE carries its reason code in `details`, which the API client would otherwise show raw. */
function sentence(err: unknown) {
  if (err instanceof ApiError && err.code === "NOT_ENABLEABLE") {
    const reason = err.details?.[0]?.message;
    return (reason && BLOCK_REASON[reason]) || "This page can't be turned on.";
  }
  return errorSentence(err);
}

function pageBlock(a: CreatorAsset, creatorStatus: string): string | null {
  if (a.networkDuplicate) return `Already on our network${a.networkDuplicateOfName ? ` (${a.networkDuplicateOfName})` : ""} — it can never be offered as a creator page.`;
  if (a.disconnected) return "Disconnected — the creator must reconnect it.";
  if (!a.canPublish) return `We can't publish to it through the API${a.publishProbeError ? `: ${a.publishProbeError}` : "."}`;
  if (creatorStatus !== "approved") return "Approve the creator first.";
  return null;
}

function CreatorView() {
  const id = useSearchParams().get("id");
  const { data, error, isLoading, mutate } = useCreator(id);
  const [pending, setPending] = useState<Action | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyAsset, setBusyAsset] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);

  if (!id) return <Empty title="No creator selected." action={<Link href="/creators" className="btn">Back to creators</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !data) return <Loading />;
  const { creator: c, connection: conn, assets } = data;

  async function decide(e: React.FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setBusy(true);
    try {
      await apiFetch(`/sales/creators/${id}/${pending}`, { method: "POST", body: JSON.stringify(note.trim() ? { note: note.trim() } : {}) });
      await mutate();
      setToast({ message: ACTIONS[pending].done, tone: "ok" });
      setPending(null);
      setNote("");
    } catch (err) {
      setToast({ message: sentence(err), tone: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(a: CreatorAsset) {
    setBusyAsset(a.id);
    try {
      await apiFetch(`/sales/creators/${id}/assets/${a.id}`, { method: "PUT", body: JSON.stringify({ enabled: !a.enabled }) });
      await mutate();
      setToast({ message: a.enabled ? `${a.name} turned off.` : `${a.name} turned on — it can now be offered.`, tone: "ok" });
    } catch (err) {
      await mutate();
      setToast({ message: sentence(err), tone: "err" });
    } finally {
      setBusyAsset(null);
    }
  }

  const live = assets.filter((a) => !a.disconnected);
  const gone = assets.filter((a) => a.disconnected);
  const actions = AVAILABLE[c.status] ?? [];

  return (
    <>
      <PageHead kicker={<Link href="/creators" className="hover:text-white">Creators</Link> as unknown as string} title={<>{c.name} <StatusPill status={c.status} label={CREATOR_STATUS_LABEL[c.status] ?? c.status} /></>}>
        {actions.map((a) => (
          <button key={a} type="button" className={`btn ${ACTIONS[a].danger ? "btn-light" : ""}`} onClick={() => { setPending(a); setNote(""); }}>{ACTIONS[a].label}</button>
        ))}
      </PageHead>

      {pending && (
        <form onSubmit={decide} className="card p-4 mb-4 grid grid-cols-[minmax(0,1fr)] gap-3 text-sm max-w-xl">
          <h2 className="font-bold">{ACTIONS[pending].label} {c.name}</h2>
          <Field label={ACTIONS[pending].noteRequired ? "Reason (emailed to the creator)" : "Note for the creator (optional, emailed)"}>
            <textarea className="input min-h-[90px]" required={ACTIONS[pending].noteRequired} minLength={ACTIONS[pending].noteRequired ? 3 : undefined} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          {pending === "suspend" && <p className="text-xs text-ink-4">Suspending switches all of their pages off.</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : ACTIONS[pending].label}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <section className="card p-4 text-sm grid gap-2 content-start">
          <h2 className="font-bold">Profile</h2>
          <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Email</div><span className="break-all">{c.email}</span>{c.emailVerified ? <span className="text-xs text-success"> · verified</span> : <span className="text-xs text-attention"> · not verified</span>}</div>
          {c.phone && <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Phone</div>{c.phone}</div>}
          <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Country</div>{c.country ?? "—"}</div>
          <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Signed up</div>{fmtDate(c.createdAt)}{c.submittedAt ? ` · submitted ${fmtDate(c.submittedAt)}` : " · not submitted yet"}</div>
          {c.reviewedAt && <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Last decision</div>{fmtDate(c.reviewedAt)}{c.reviewedByName ? ` by ${c.reviewedByName}` : ""}</div>}
          {c.reviewNote && <div><div className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Note</div><span className="whitespace-pre-line">{c.reviewNote}</span></div>}
        </section>
        <section className="card p-4 text-sm grid gap-2 content-start lg:col-span-2">
          <h2 className="font-bold">Facebook connection</h2>
          {!conn ? <p className="text-ink-3">Not connected — the creator hasn't connected Facebook yet.</p> : (
            <>
              <div>{CONNECTION_LABEL[conn.status] ?? conn.status}{conn.metaUserName ? ` · as ${conn.metaUserName}` : ""} · connected {fmtDate(conn.connectedAt)}</div>
              {conn.tokenExpiresAt && <div className="text-ink-3">Access expires {fmtDate(conn.tokenExpiresAt)}{conn.dataAccessExpiresAt ? ` · data access until ${fmtDate(conn.dataAccessExpiresAt)}` : ""}</div>}
              {conn.missingScopes.length > 0 && <div className="text-attention">Missing permissions: {conn.missingScopes.join(", ")}</div>}
              {conn.discoveryState === "running" && <div className="text-ink-3">Checking their pages…</div>}
              {conn.lastError && <div className="text-attention">{conn.lastError}</div>}
            </>
          )}
        </section>
      </div>

      <section className="card overflow-x-auto mb-4">
        <div className="p-4 pb-0"><h2 className="font-bold">Pages <span className="text-ink-4 font-normal text-sm">{live.length} connected{gone.length ? ` · ${gone.length} disconnected` : ""}</span></h2></div>
        {assets.length === 0 ? <p className="p-4 text-sm text-ink-3">No pages yet.</p> : (
          <table className="w-full text-sm min-w-[680px]">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left">
              <tr className="border-b-2 border-border"><th className="p-3">Page</th><th className="p-3 text-right">Followers</th><th className="p-3 text-right">Views 28d</th><th className="p-3">Can offer?</th><th className="p-3 text-right">Offered</th></tr>
            </thead>
            <tbody>
              {[...live, ...gone].map((a) => {
                const block = pageBlock(a, c.status);
                return (
                  <tr key={a.id} className={`border-b border-rule ${a.disconnected ? "text-ink-4" : ""}`}>
                    <td className="p-3 min-w-0">
                      <div className="font-bold">
                        {a.name}
                        {a.profileUrl && <a href={a.profileUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${a.name}`} className="inline-flex ml-1.5 align-middle text-ink-4 hover:text-indigo-light"><ExternalLink size={12} aria-hidden /></a>}
                      </div>
                      <div className="text-xs text-ink-4">{a.kind === "facebook_page" ? "Facebook Page" : "Instagram"}{a.username ? ` · @${a.username}` : ""}</div>
                    </td>
                    <td className="p-3 text-right tabular-nums">{compact(a.followerCount)}</td>
                    <td className="p-3 text-right tabular-nums">{compact(a.views28d)}</td>
                    <td className="p-3 text-xs">{block ? <span className={a.networkDuplicate ? "text-danger" : "text-attention"}>{block}</span> : <span className="text-success">Yes</span>}</td>
                    <td className="p-3 text-right">
                      {a.enabled || !block ? (
                        <button type="button" role="switch" aria-checked={a.enabled} aria-label={`Offer ${a.name}`} disabled={busyAsset === a.id} onClick={() => toggle(a)} className={`btn btn-sm ${a.enabled ? "" : "btn-ghost"}`}>
                          {busyAsset === a.id ? "…" : a.enabled ? "On" : "Off"}
                        </button>
                      ) : <span className="text-ink-4 text-xs">Off</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function CreatorViewPage() {
  return <Suspense fallback={<Loading />}><CreatorView /></Suspense>;
}
