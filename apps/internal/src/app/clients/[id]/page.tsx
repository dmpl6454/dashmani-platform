"use client";

import { use } from "react";
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
import { useRouter } from "next/navigation";

const statusBadge: Record<string, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-700",
  INACTIVE: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
  PAUSED: "bg-[#FFF3C4] text-[#B8960C]",
};

const projectStatusBadge: Record<string, string> = {
  ACTIVE: "bg-emerald-100 text-emerald-700",
  PAUSED: "bg-[#FFF3C4] text-[#B8960C]",
  COMPLETED: "bg-indigo-100 text-indigo-700",
  ARCHIVED: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
};

export default function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
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
      <div className="space-y-4 crx-animate-fade">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 bg-[#F5F0E8] rounded-2xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError || !client) {
    return (
      <div className="text-center py-20">
        <Building2 size={40} className="mx-auto mb-3 text-ink-4" />
        <p className="text-ink-3 font-medium">Client not found.</p>
        <Link href="/clients" className="text-indigo text-sm font-semibold hover:underline mt-2 inline-block">
          ← Back to clients
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 crx-animate-fade max-w-3xl">
      {/* Back + actions */}
      <div className="flex items-center justify-between">
        <Link href="/clients" className="flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink font-medium transition-colors">
          <ChevronLeft size={16} /> Clients
        </Link>
        <div className="flex items-center gap-2">
          {client.email && (
            <button
              onClick={sendInvite}
              disabled={inviting}
              className="flex items-center gap-1.5 text-sm border border-[#E8E0D0] rounded-full px-4 py-2 hover:bg-[rgba(245,213,71,0.1)] transition-colors font-medium"
            >
              <Send size={14} /> {inviting ? "Sending…" : "Invite to Portal"}
            </button>
          )}
          {isAdmin && (
            <>
              <button
                onClick={startEdit}
                className="flex items-center gap-1.5 text-sm border border-[#E8E0D0] rounded-full px-4 py-2 hover:bg-[rgba(245,213,71,0.1)] transition-colors font-medium"
              >
                <Pencil size={14} /> Edit
              </button>
              <button
                onClick={handleDelete}
                className="flex items-center gap-1.5 text-sm border border-red-100 text-red-500 rounded-full px-4 py-2 hover:bg-red-50 transition-colors font-medium"
              >
                <Trash2 size={14} /> Delete
              </button>
            </>
          )}
        </div>
      </div>

      {inviteMsg && (
        <div className={`flex items-center gap-2 text-sm rounded-xl px-4 py-2.5 ${inviteMsg.type === "success" ? "bg-emerald-50 border border-emerald-100 text-emerald-700" : "bg-red-50 border border-red-100 text-red-600"}`}>
          {inviteMsg.type === "success" ? <Check size={14} /> : <X size={14} />}
          {inviteMsg.text}
        </div>
      )}

      {/* Client card */}
      {editing ? (
        <form onSubmit={handleSave} className="v3-card p-6 space-y-4">
          <h2 className="font-semibold text-ink mb-2">Edit Client</h2>
          <div className="grid grid-cols-2 gap-4">
            {(["companyName", "contactName", "email", "phone"] as const).map((field) => (
              <div key={field}>
                <label className="block text-xs font-medium text-ink-3 mb-1 capitalize">{field.replace(/([A-Z])/g, " $1")}</label>
                <input
                  type={field === "email" ? "email" : "text"}
                  value={form[field]}
                  onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                  required={field === "companyName"}
                  className="w-full border-2 border-ink/15 bg-surface rounded-xl px-4 py-2.5 text-sm text-ink focus:outline-none focus:border-indigo transition-colors"
                />
              </div>
            ))}
            <div>
              <label className="block text-xs font-medium text-ink-3 mb-1">Status</label>
              <select
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                className="w-full border-2 border-ink/15 bg-surface rounded-xl px-4 py-2.5 text-sm text-ink focus:outline-none focus:border-indigo transition-colors"
              >
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
                <option value="PAUSED">Paused</option>
              </select>
            </div>
          </div>
          {saveError && <p className="text-danger text-sm font-medium">{saveError}</p>}
          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={saving} className="bg-ink text-white px-6 py-2.5 rounded-full text-sm font-semibold hover:bg-ink/80 disabled:opacity-50 transition-colors">
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="border border-[#E8E0D0] px-6 py-2.5 rounded-full text-sm font-semibold text-ink-3 hover:bg-[rgba(0,0,0,0.04)] transition-colors">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="v3-card p-6">
          <div className="flex items-start gap-4">
            <div className="h-14 w-14 rounded-2xl bg-[#FFF3C4] flex items-center justify-center shrink-0">
              <Building2 size={28} className="text-ink" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="font-serif text-3xl font-light text-ink">{client.companyName}</h1>
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge[client.status] ?? "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>
                  {formatStatus(client.status)}
                </span>
              </div>
              <div className="flex flex-wrap gap-4 mt-3 text-sm text-ink-3">
                {client.contactName && <span className="font-medium text-ink">{client.contactName}</span>}
                {client.email && (
                  <a href={`mailto:${client.email}`} className="flex items-center gap-1.5 hover:text-indigo transition-colors">
                    <Mail size={14} /> {client.email}
                  </a>
                )}
                {client.phone && (
                  <a href={`tel:${client.phone}`} className="flex items-center gap-1.5 hover:text-indigo transition-colors">
                    <Phone size={14} /> {client.phone}
                  </a>
                )}
              </div>
              <p className="text-xs text-ink-4 mt-2">
                Client since {new Date(client.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Projects */}
      <div className="v3-card p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-ink flex items-center gap-2">
            <FolderOpen size={16} className="text-ink-4" /> Projects
          </h2>
          <Link
            href={`/projects/new?clientId=${id}`}
            className="text-sm text-indigo font-semibold hover:underline"
          >
            + New project
          </Link>
        </div>
        {client.projects?.length === 0 ? (
          <p className="text-ink-4 text-sm text-center py-8">No projects yet.</p>
        ) : (
          <div className="space-y-2">
            {(client.projects ?? []).map((p: any) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="flex items-center justify-between p-3 rounded-xl border border-[#F0EAD8] hover:bg-[rgba(245,213,71,0.06)] transition-colors"
              >
                <div>
                  <p className="font-medium text-ink text-sm">{p.name}</p>
                  {p.description && <p className="text-xs text-ink-4 truncate max-w-xs">{p.description}</p>}
                </div>
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${projectStatusBadge[p.status] ?? "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>
                  {formatStatus(p.status)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
