"use client";
import { useState } from "react";
import useSWR from "swr";
import { Topstrip } from "@/components/portal-topstrip";
import { Avatar, Button, PageError, Skeleton, Tag } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { apiFetch } from "@/lib/api";
import { Field, inputCls } from "@/app/campaigns/_ui";
import { useHydrated } from "@/lib/hooks/use-hydrated";

// Team: who signs in to this client account. Everyone on the account sees the list; only the
// owner (the account's own login) adds, re-invites, switches off or removes people. Each person
// has their own email and password and sees everything the account sees.

interface Member {
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
interface Team {
  companyName: string;
  owner: { name: string; email: string };
  members: Member[];
  max: number;
  /** "owner", or the member id of whoever is looking. */
  you: string;
}

const KEY = "/client/team";
const STATUS: Record<Member["status"], { label: string; tone: "neutral" | "attention" | "success" }> = {
  active: { label: "Active", tone: "success" },
  invited: { label: "Invited", tone: "attention" },
  disabled: { label: "Switched off", tone: "neutral" },
};

function when(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export default function TeamPage() {
  const { data, error, isLoading, mutate } = useSWR<Team>(KEY, async (u: string) => (await apiFetch<Team>(u)).data, { revalidateOnFocus: false });
  const hydrated = useHydrated();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const isOwner = data?.you === "owner";

  async function run(id: string, fn: () => Promise<unknown>) {
    setErr(null);
    setBusy(id);
    try {
      await fn();
      await mutate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setErr("Add the person's name.");
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setErr("Add a valid email address.");
    await run("invite", async () => {
      const r = await apiFetch<{ inviteUrl: string; emailed: boolean; member: Member }>(KEY, { method: "POST", body: JSON.stringify({ name: name.trim(), email: email.trim() }) });
      setLink({ email: r.data.member.email, url: r.data.inviteUrl, emailed: r.data.emailed });
      setCopied(false);
      setName("");
      setEmail("");
    });
  }

  const resend = (m: Member) =>
    run(m.id, async () => {
      const r = await apiFetch<{ inviteUrl: string; emailed: boolean }>(`${KEY}/${m.id}/resend`, { method: "POST" });
      setLink({ email: m.email, url: r.data.inviteUrl, emailed: r.data.emailed });
      setCopied(false);
    });
  const toggle = (m: Member) => run(m.id, () => apiFetch(`${KEY}/${m.id}/${m.status === "disabled" ? "enable" : "disable"}`, { method: "POST" }));
  const setEmailChoice = (m: Member, field: "emailCampaigns" | "emailInvoices", on: boolean) =>
    run(`${m.id}:${field}`, () => apiFetch(`${KEY}/me/email`, { method: "PUT", body: JSON.stringify({ [field]: on }) }));

  const remove = (m: Member) => {
    if (!window.confirm(`Remove ${m.name} (${m.email})? They will be signed out and can no longer sign in.`)) return;
    void run(m.id, () => apiFetch(`${KEY}/${m.id}`, { method: "DELETE" }));
  };

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <Topstrip title="Team" sub={data ? `${data.members.length + 1} ${data.members.length === 0 ? "person" : "people"} on ${data.companyName}` : "Who signs in to this account"} />
      <div className="px-4 sm:px-6 py-4 max-w-3xl grid grid-cols-1 gap-4">
        {error && !data ? (
          <div>
            <PageError message="The team couldn't be loaded." />
            <div className="text-center"><button type="button" className="underline text-[13px] text-indigo-light" onClick={() => mutate()}>Try again</button></div>
          </div>
        ) : isLoading && !data ? (
          <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16" />)}</div>
        ) : data ? (
          <>
            <p className="text-[13px] text-ink-3">
              Everyone here signs in with their own email and password and sees everything on this account — campaigns, approvals, files and invoices. Campaign and invoice emails go to the owner and to everyone who keeps them switched on.
              {isOwner ? " You can add up to " + data.max + " people." : ` Only ${data.owner.name}, the account owner, can add or remove people.`}
            </p>

            <ul className="grid grid-cols-1 border-2 border-border divide-y-2 divide-border" aria-label="People on this account">
              <li className="flex items-center gap-3 px-4 py-3 min-w-0">
                <Avatar initial={data.owner.name.charAt(0).toUpperCase()} size="sm" />
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-bold truncate">{data.owner.name}{isOwner && <span className="text-ink-3 font-normal"> (you)</span>}</div>
                  <div className="text-[12.5px] text-ink-3 truncate">{data.owner.email}</div>
                </div>
                <Tag>Owner</Tag>
              </li>
              {data.members.map((m) => (
                <li key={m.id} className="px-4 py-3 grid grid-cols-1 gap-2 min-w-0">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar initial={m.name.charAt(0).toUpperCase()} size="sm" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-bold truncate">{m.name}{data.you === m.id && <span className="text-ink-3 font-normal"> (you)</span>}</div>
                      <div className="text-[12.5px] text-ink-3 truncate">{m.email}</div>
                    </div>
                    <Tag tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Tag>
                  </div>
                  <div className="text-[11.5px] text-ink-4 pl-10">
                    {m.status === "invited"
                      ? `Invited ${when(m.createdAt)}${m.inviteExpiresAt ? ` · link ${new Date(m.inviteExpiresAt) < new Date() ? "expired" : `valid until ${when(m.inviteExpiresAt)}`}` : ""}`
                      : `Last signed in ${when(m.lastLoginAt)}`}
                    {m.invitedBy ? ` · added by ${m.invitedBy}` : ""}
                  </div>
                  {data.you === m.id ? (
                    <div className="pl-10 grid grid-cols-1 gap-1.5 text-[12.5px]" role="group" aria-label="Your emails">
                      <span className="text-ink-3">Email me:</span>
                      {(
                        [
                          ["emailCampaigns", "Campaign updates (approved, changes needed, posts live)"],
                          ["emailInvoices", "Invoices"],
                        ] as const
                      ).map(([field, label]) => (
                        <label key={field} className="inline-flex items-center gap-2 cursor-pointer">
                          <input type="checkbox" checked={m[field]} disabled={busy !== null} onChange={(e) => setEmailChoice(m, field, e.target.checked)} />
                          <span>{label}</span>
                        </label>
                      ))}
                    </div>
                  ) : m.status === "active" ? (
                    <div className="pl-10 text-[11.5px] text-ink-4">
                      Gets {[m.emailCampaigns && "campaign updates", m.emailInvoices && "invoices"].filter(Boolean).join(" and ") || "no emails"}
                    </div>
                  ) : null}
                  {isOwner && (
                    <div className="flex flex-wrap gap-2 pl-10">
                      {m.status === "invited" && <Button size="sm" disabled={busy !== null} onClick={() => resend(m)}>New invite link</Button>}
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => toggle(m)}>{m.status === "disabled" ? "Switch on" : "Switch off"}</Button>
                      <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => remove(m)}>Remove</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {link && (
              <div role="status" className={`border-2 px-4 py-3 grid grid-cols-1 gap-2 ${link.emailed ? "border-success/40 bg-success-bg" : "border-attention/40 bg-attention-bg"}`}>
                <p className="text-[13px]">
                  {link.emailed
                    ? <>We emailed an invite to <strong>{link.email}</strong>. If it doesn&apos;t arrive, send them this link</>
                    : <>We couldn&apos;t email the invite to <strong>{link.email}</strong>. Send them this link yourself</>}
                  {" "}— it works once and expires in 7 days.
                </p>
                <div className="flex gap-2 min-w-0">
                  <input readOnly value={link.url} className={`${inputCls} flex-1 min-w-0 text-[12px]`} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
                  <Button size="sm" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
                </div>
              </div>
            )}

            {err && <div role="alert" className="border-2 border-danger/50 text-danger px-4 py-2.5 text-[13px]">{err}</div>}

            {isOwner && data.members.length < data.max && (
              <form onSubmit={invite} noValidate className="border-2 border-border px-4 py-4 grid grid-cols-1 gap-3">
                <h2 className="text-[15px] font-extrabold flex items-center gap-2"><Icon.Plus size={16} /> Add a person</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Name" htmlFor="tm-name">
                    <input id="tm-name" className={inputCls} value={name} maxLength={200} autoComplete="off" onChange={(e) => { setName(e.target.value); setErr(null); }} />
                  </Field>
                  <Field label="Work email" htmlFor="tm-email">
                    <input id="tm-email" type="email" className={inputCls} value={email} maxLength={254} autoComplete="off" onChange={(e) => { setEmail(e.target.value); setErr(null); }} />
                  </Field>
                </div>
                <div><Button type="submit" variant="primary" disabled={!hydrated || busy !== null}>{busy === "invite" ? "Sending…" : "Send invite"}</Button></div>
              </form>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
