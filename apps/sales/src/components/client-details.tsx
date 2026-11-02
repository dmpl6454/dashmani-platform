"use client";
// The client page's "Details" card: company name, contact person and phone, editable by sales;
// the email — the owner's portal sign-in — changes through its own admin-only form.
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import type { ClientRow } from "@/lib/sales-types";
import { Field } from "@/components/sales-ui";

type Toast = { message: string; tone: "ok" | "err" };

export function ClientDetails({ client, onSaved, onToast }: { client: ClientRow; onSaved: () => Promise<unknown>; onToast: (t: Toast) => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "email">("view");
  const [form, setForm] = useState({ companyName: client.companyName, contactName: client.contactName, phone: client.phone ?? "" });
  const [email, setEmail] = useState(client.email);
  const [busy, setBusy] = useState(false);

  function open(next: "edit" | "email") {
    setForm({ companyName: client.companyName, contactName: client.contactName, phone: client.phone ?? "" });
    setEmail(client.email);
    setMode(next);
  }

  async function run(path: string, body: unknown, done: string) {
    setBusy(true);
    try {
      await apiFetch(path, { method: "PUT", body: JSON.stringify(body) });
      await onSaved();
      setMode("view");
      onToast({ message: done, tone: "ok" });
    } catch (err) {
      const e = err as { status?: number };
      onToast({ message: e.status === 403 && path.endsWith("/email") ? "Only a sales admin can change a client's sign-in email." : errorSentence(err), tone: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-bold">Details</h2>
        {mode === "view"
          ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => open("edit")}>Edit</button>
          : <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode("view")}>Cancel</button>}
      </div>
      {mode === "view" && (
        <dl className="text-sm grid gap-1">
          <div><dt className="text-ink-4 text-xs">Company</dt><dd>{client.companyName}</dd></div>
          <div><dt className="text-ink-4 text-xs">Contact person</dt><dd>{client.contactName}</dd></div>
          <div>
            <dt className="text-ink-4 text-xs">Email</dt>
            <dd className="flex items-center justify-between gap-2"><span className="break-all">{client.email}</span><button type="button" className="text-xs text-indigo-light hover:underline shrink-0" onClick={() => open("email")}>Change</button></dd>
          </div>
          <div><dt className="text-ink-4 text-xs">Phone</dt><dd>{client.phone || "—"}</dd></div>
        </dl>
      )}
      {mode === "edit" && (
        <form
          className="grid grid-cols-[minmax(0,1fr)] gap-3 text-sm"
          onSubmit={(e) => { e.preventDefault(); void run(`/sales/clients/${client.id}`, { companyName: form.companyName, contactName: form.contactName, phone: form.phone || null }, "Details saved."); }}
        >
          <Field label="Company"><input className="input" required minLength={2} value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} /></Field>
          <Field label="Contact person"><input className="input" required minLength={2} value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></Field>
          <Field label="Phone"><input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        </form>
      )}
      {mode === "email" && (
        <form
          className="grid grid-cols-[minmax(0,1fr)] gap-3 text-sm"
          onSubmit={(e) => { e.preventDefault(); void run(`/sales/clients/${client.id}/email`, { email }, "Email changed. The client's portal sign-in now uses the new address."); }}
        >
          <Field label="New email"><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <p className="text-xs text-ink-4">This is also the client owner's portal sign-in: they will sign in with the new address, and anyone signed in under the old one is signed out. Sales admins only.</p>
          <button type="submit" className="btn" disabled={busy || email.trim().toLowerCase() === client.email.toLowerCase()}>{busy ? "Saving…" : "Change email"}</button>
        </form>
      )}
    </section>
  );
}
