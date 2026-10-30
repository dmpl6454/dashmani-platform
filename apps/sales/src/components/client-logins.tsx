"use client";
import { useState } from "react";
import useSWR from "swr";
import { apiFetch, fetcher } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate } from "@/lib/format";
import { Field, StatusPill } from "@/components/sales-ui";

// Portal logins: the people who sign in to client.digitalsukoon.com as this company. The
// owner is the client row's own email; staff (and the owner, under Team on the client portal)
// can add more. Each new login gets an emailed one-time link; the link is shown here too so it
// can be passed on if the email does not arrive.

interface Login {
  id: string;
  email: string;
  name: string;
  status: "invited" | "active" | "disabled";
  invitedBy: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  inviteExpiresAt: string | null;
  emailCampaigns: boolean;
  emailInvoices: boolean;
}
interface Logins {
  owner: { name: string; email: string; status: string };
  members: Login[];
  max: number;
}

const LABEL: Record<Login["status"], { label: string; tone: string }> = {
  active: { label: "Active", tone: "recorded" },
  invited: { label: "Invited", tone: "expired" },
  disabled: { label: "Switched off", tone: "closed" },
};

export function ClientLogins({ clientId, onToast }: { clientId: string; onToast: (t: { message: string; tone: "ok" | "err" }) => void }) {
  const key = `/sales/clients/${clientId}/logins`;
  const { data, error, mutate } = useSWR<Logins>(key, fetcher, { revalidateOnFocus: false });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string; emailed: boolean } | null>(null);

  async function run(id: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(id);
    try {
      await fn();
      await mutate();
      if (ok) onToast({ message: ok, tone: "ok" });
    } catch (e) {
      onToast({ message: errorSentence(e), tone: "err" });
    } finally {
      setBusy(null);
    }
  }

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    void run("add", async () => {
      const r = await apiFetch<{ inviteUrl: string; emailed: boolean; member: Login }>(key, { method: "POST", body: JSON.stringify({ name: name.trim(), email: email.trim() }) });
      setLink({ email: r.data.member.email, url: r.data.inviteUrl, emailed: r.data.emailed });
      setName("");
      setEmail("");
      setAdding(false);
    }, "Login added.");
  };

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-bold">Portal logins</h2>
        {data && data.members.length < data.max && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "Add"}</button>
        )}
      </div>
      {error && !data ? (
        <p className="text-sm text-danger">Couldn&apos;t load the logins. <button type="button" className="underline" onClick={() => mutate()}>Try again</button></p>
      ) : !data ? (
        <p className="text-sm text-ink-3">Loading…</p>
      ) : (
        <>
          <ul className="text-sm divide-y divide-rule">
            <li className="py-2 flex items-start justify-between gap-2 min-w-0">
              <span className="min-w-0"><span className="block font-semibold truncate">{data.owner.name}</span><span className="block text-xs text-ink-3 truncate">{data.owner.email}</span></span>
              <StatusPill status="sent" label="Owner" />
            </li>
            {data.members.map((m) => (
              <li key={m.id} className="py-2 grid grid-cols-1 gap-1.5 min-w-0">
                <div className="flex items-start justify-between gap-2 min-w-0">
                  <span className="min-w-0"><span className="block font-semibold truncate">{m.name}</span><span className="block text-xs text-ink-3 truncate">{m.email}</span></span>
                  <StatusPill status={LABEL[m.status].tone} label={LABEL[m.status].label} />
                </div>
                <span className="text-xs text-ink-4">
                  {m.status === "invited" ? `Invited ${fmtDate(m.createdAt)}` : `Last sign-in ${m.lastLoginAt ? fmtDate(m.lastLoginAt) : "never"}`}
                  {m.invitedBy ? ` · by ${m.invitedBy}` : ""}
                  {m.status === "active" ? ` · emails: ${[m.emailCampaigns && "campaigns", m.emailInvoices && "invoices"].filter(Boolean).join(", ") || "none"}` : ""}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {m.status === "invited" && (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => run(m.id, async () => {
                      const r = await apiFetch<{ inviteUrl: string; emailed: boolean }>(`${key}/${m.id}/resend`, { method: "POST" });
                      setLink({ email: m.email, url: r.data.inviteUrl, emailed: r.data.emailed });
                    }, "New invite link made.")}>New link</button>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null}
                    onClick={() => run(m.id, () => apiFetch(`${key}/${m.id}/${m.status === "disabled" ? "enable" : "disable"}`, { method: "POST" }), m.status === "disabled" ? "Login switched on." : "Login switched off — signed out everywhere.")}>
                    {m.status === "disabled" ? "Switch on" : "Switch off"}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm text-danger" disabled={busy !== null}
                    onClick={() => { if (window.confirm(`Remove ${m.email}? They can no longer sign in.`)) void run(m.id, () => apiFetch(`${key}/${m.id}`, { method: "DELETE" }), "Login removed."); }}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {data.members.length === 0 && !adding && <p className="text-xs text-ink-4 mt-1">Only the owner signs in today. Add colleagues so more people can follow campaigns and invoices.</p>}
          {link && (
            <div className={`mt-3 border p-2 text-xs grid grid-cols-1 gap-1.5 ${link.emailed ? "border-success" : "border-attention"}`}>
              <span>{link.emailed ? <>Invite emailed to <strong>{link.email}</strong>. If it doesn&apos;t arrive, send this link</> : <>The invite email to <strong>{link.email}</strong> could not be sent. Send this link yourself</>} (one use, 7 days):</span>
              <input readOnly className="input text-xs" value={link.url} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
            </div>
          )}
          {adding && (
            <form onSubmit={add} className="mt-3 grid grid-cols-1 gap-2">
              <Field label="Name"><input className="input" required minLength={2} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Email"><input className="input" type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              <button type="submit" className="btn btn-sm" disabled={busy !== null}>{busy === "add" ? "Sending…" : "Send invite"}</button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
