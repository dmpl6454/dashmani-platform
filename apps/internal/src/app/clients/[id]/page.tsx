"use client";

import Link from "next/link";
import { useClient } from "@/lib/hooks/use-clients";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatStatus } from "@dashmani/shared";
import {
  Building2, Mail, Phone, ChevronLeft, Pencil, Trash2,
  FolderOpen, Send, X, Check,
} from "lucide-react";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";

// Mockup palette.
const STATUS_COLOR: Record<string, string> = { ACTIVE: "var(--hx-00D7A0)", PAUSED: "var(--hx-6EB2FF)", INACTIVE: "var(--hx-738395)" };
const PROJECT_STATUS_COLOR: Record<string, string> = {
  ACTIVE: "var(--hx-00D7A0)",
  PAUSED: "var(--hx-FBBF24)",
  COMPLETED: "var(--hx-6EB2FF)",
  ARCHIVED: "var(--hx-738395)",
};
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
function StatusPill({ color, label }: { color: string; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 h-[26px] px-[11px] rounded-full text-[11.5px] font-semibold whitespace-nowrap border"
      style={{ background: rgba(color, 0.1), borderColor: rgba(color, 0.28), color }}
    >
      <i className="h-[5px] w-[5px] rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

const LABEL = "flex flex-col gap-[7px] text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase min-w-0";
const FIELD =
  "h-[38px] w-full px-3 rounded-[6px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[12.5px] tracking-normal normal-case font-normal outline-none focus:border-ds-gold placeholder:text-ds-t4 [color-scheme:dark] min-w-0";
const BTN_GHOST = "h-9 px-3.5 rounded-[6px] border border-ds-line2 text-ds-t2 text-[12px] font-semibold hover:text-ds-text hover:border-ds-line4 disabled:opacity-50";
const BTN_PILL = "inline-flex items-center gap-1.5 h-8 px-[13px] rounded-full border text-[12px] font-semibold whitespace-nowrap transition-colors disabled:opacity-55";
const CARD = "rounded-[12px] border border-[color:var(--hx-1D3444)] bg-ds-card shadow-[inset_0_1px_0_rgba(233,189,98,.06),0_12px_32px_rgba(0,0,0,.35)]";

// Next 14: read the route id with useParams(). React 18 has no use(), so use(params)
// crashed this page with "An unsupported type was passed to use()".
export default function ClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error, mutate } = useClient(id);
  const isError = !!error;
  const client = (data as any)?.data;
  usePageTitle(client?.companyName ?? "Client");

  const { user: currentUser } = useAuth();
  const router = useRouter();
  const callerRoles = (currentUser?.roles ?? []).map((r) => r.toLowerCase());
  const isAdmin = callerRoles.includes("super admin") || callerRoles.includes("admin");

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{ companyName: string; contactName: string; email: string; phone: string; status: string }>({ companyName: "", contactName: "", email: "", phone: "", status: "" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  function startEdit() {
    if (!client) return;
    setForm({
      companyName: client.companyName ?? "",
      contactName: client.contactName ?? "",
      email: client.email ?? "",
      phone: client.phone ?? "",
      status: client.status ?? "ACTIVE",
    });
    setSaveError("");
    setEditing(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError("");
    try {
      await apiFetch(`/clients/${id}`, {
        method: "PUT",
        body: JSON.stringify(form),
      });
      await mutate();
      setEditing(false);
    } catch (err: any) {
      setSaveError(err?.message || "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete client "${client?.companyName}"? This cannot be undone.`)) return;
    try {
      await apiFetch(`/admin/clients/${id}`, { method: "DELETE" });
      router.push("/clients");
    } catch (err: any) {
      alert(err?.message || "Failed to delete.");
    }
  }

  async function sendInvite() {
    if (!client?.email) return;
    setInviting(true);
    setInviteMsg(null);
    try {
      await apiFetch("/client/auth/invite-request", {
        method: "POST",
        body: JSON.stringify({ email: client.email }),
      });
      setInviteMsg({ type: "success", text: `Invite sent to ${client.email}` });
    } catch (err: any) {
      setInviteMsg({ type: "error", text: err?.message || "Failed to send invite." });
    } finally {
      setInviting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="pt-[26px] space-y-3.5" aria-hidden="true">
        <div className="h-3 w-16 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-[12px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError || !client) {
    return (
      <div className="py-20 px-5 text-center text-ds-t3 text-[13px]">
        <Building2 className="h-[30px] w-[30px] mx-auto mb-2.5 opacity-50" strokeWidth={1.5} />
        <p>Client not found.</p>
        <Link href="/clients" className="mt-2 inline-block text-[12.5px] font-semibold text-ds-gold hover:text-[color:var(--hx-F4D58C)]">
          ← Back to clients
        </Link>
      </div>
    );
  }

  const statusColor = STATUS_COLOR[client.status] ?? "var(--hx-738395)";

  return (
    <div className="pb-8 max-w-3xl">
      {/* Back + actions */}
      <section className="flex items-center justify-between gap-3 flex-wrap pt-[26px] pb-[18px]">
        <Link href="/clients" className="inline-flex items-center gap-1.5 text-[13px] text-ds-t2 hover:text-ds-text transition-colors">
          <ChevronLeft className="h-3.5 w-3.5" /> Clients
        </Link>
        <div className="flex items-center gap-2 flex-wrap">
          {client.email && (
            <button
              onClick={sendInvite}
              disabled={inviting}
              className={`${BTN_PILL} border-ds-line2 text-ds-t5 hover:border-[rgba(35,139,255,.55)] hover:text-[color:var(--hx-6EB2FF)]`}
            >
              <Send className="h-[13px] w-[13px]" /> {inviting ? "Sending…" : "Invite to Portal"}
            </button>
          )}
          {isAdmin && (
            <>
              <button
                onClick={startEdit}
                className={`${BTN_PILL} border-ds-line2 text-ds-t5 hover:border-[rgba(233,189,98,.55)] hover:text-ds-gold`}
              >
                <Pencil className="h-[13px] w-[13px]" /> Edit
              </button>
              <button
                onClick={handleDelete}
                className={`${BTN_PILL} border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] hover:border-[rgba(229,72,77,.6)] hover:bg-[rgba(229,72,77,.08)]`}
              >
                <Trash2 className="h-[13px] w-[13px]" /> Delete
              </button>
            </>
          )}
        </div>
      </section>

      {inviteMsg && (
        <div
          className={`flex items-center gap-2 mb-4 px-3 py-2.5 rounded-[6px] text-[12px] font-semibold border ${
            inviteMsg.type === "success"
              ? "bg-[rgba(0,215,160,.08)] border-[rgba(0,215,160,.3)] text-ds-teal"
              : "bg-[rgba(229,72,77,.08)] border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)]"
          }`}
        >
          {inviteMsg.type === "success" ? <Check className="h-4 w-4 shrink-0" /> : <X className="h-4 w-4 shrink-0" />}
          {inviteMsg.text}
        </div>
      )}

      {/* Client card */}
      {editing ? (
        <form onSubmit={handleSave} className={`${CARD} relative overflow-hidden p-6`}>
          <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px opacity-70 bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]" />
          <h2 className="text-[16px] font-semibold text-ds-text mb-5">Edit Client</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {(["companyName", "contactName", "email", "phone"] as const).map((field) => (
              <label key={field} className={LABEL}>
                <span>{field.replace(/([A-Z])/g, " $1")}</span>
                <input
                  type={field === "email" ? "email" : "text"}
                  value={form[field]}
                  onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                  required={field === "companyName"}
                  className={FIELD}
                />
              </label>
            ))}
            <label className={LABEL}>
              <span>Status</span>
              <select
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                className={`${FIELD} px-2.5 cursor-pointer`}
              >
                <option value="ACTIVE" className="bg-ds-card">Active</option>
                <option value="INACTIVE" className="bg-ds-card">Inactive</option>
                <option value="PAUSED" className="bg-ds-card">Paused</option>
              </select>
            </label>
          </div>
          {saveError && (
            <div className="mt-4 px-3 py-2.5 rounded-[6px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12px]">{saveError}</div>
          )}
          <div className="flex gap-2 mt-5">
            <button type="submit" disabled={saving} className="h-9 px-[18px] rounded-[6px] bg-ds-gold text-[color:var(--hx-060D14)] text-[12px] font-bold hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60">
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={BTN_GHOST}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className={`${CARD} p-6`}>
          <div className="flex items-start gap-4">
            <span className="h-14 w-14 rounded-[14px] bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.3)] text-ds-gold grid place-items-center shrink-0">
              <Building2 className="h-6 w-6" strokeWidth={1.7} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-[28px] font-bold tracking-[-.03em] text-ds-text leading-tight">{client.companyName}</h1>
                <StatusPill color={statusColor} label={formatStatus(client.status)} />
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-[13px] text-ds-t2">
                {client.contactName && <span className="font-semibold text-ds-text">{client.contactName}</span>}
                {client.email && (
                  <a href={`mailto:${client.email}`} className="flex items-center gap-1.5 hover:text-ds-gold transition-colors">
                    <Mail className="h-3.5 w-3.5" /> {client.email}
                  </a>
                )}
                {client.phone && (
                  <a href={`tel:${client.phone}`} className="flex items-center gap-1.5 hover:text-ds-gold transition-colors">
                    <Phone className="h-3.5 w-3.5" /> {client.phone}
                  </a>
                )}
              </div>
              <p className="text-[12px] text-ds-t3 mt-2">
                Client since {new Date(client.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Projects */}
      <section className={`${CARD} mt-4 overflow-hidden`}>
        <div className="flex items-center justify-between gap-3 h-[60px] px-6 border-b border-ds-line">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-[-.01em] text-ds-text">
            <FolderOpen className="h-4 w-4 text-ds-t3" /> Projects
          </h2>
          <Link
            href={`/projects/new?clientId=${id}`}
            className="text-[12.5px] font-semibold text-ds-gold hover:text-[color:var(--hx-F4D58C)] whitespace-nowrap"
          >
            + New project
          </Link>
        </div>
        {client.projects?.length === 0 ? (
          <div className="py-12 px-5 text-center text-ds-t3 text-[13px]">No projects yet.</div>
        ) : (
          <div>
            {(client.projects ?? []).map((p: any) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="group flex items-center justify-between gap-3 px-6 py-3.5 border-b border-[color:var(--hx-132430)] last:border-b-0 hover:bg-[color:var(--hx-0A1620)] transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-ds-text truncate group-hover:text-ds-gold transition-colors">{p.name}</p>
                  {p.description && <p className="text-[12px] text-ds-t3 truncate max-w-xs">{p.description}</p>}
                </div>
                <StatusPill color={PROJECT_STATUS_COLOR[p.status] ?? "var(--hx-738395)"} label={formatStatus(p.status)} />
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
