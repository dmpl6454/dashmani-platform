"use client";
import { useState } from "react";
import Link from "next/link";
import { useClients } from "@/lib/hooks/use-clients";
import { Button, Input } from "@dashmani/ui";
import { formatStatus } from "@dashmani/shared";
import { Plus, Search, Building2, Send, X, Check, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export default function ClientsPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading, mutate } = useClients({ search });
  const clients = (data as any)?.data || [];
  const { user: currentUser } = useAuth();
  const callerRoles = (currentUser?.roles ?? []).map((r) => r.toLowerCase());
  const isAdminOrSuperAdmin = callerRoles.includes("super admin") || callerRoles.includes("admin");

  const [inviteTarget, setInviteTarget] = useState<{ id: string; email: string; name: string } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const statusBadge: Record<string, string> = {
    ACTIVE: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
    INACTIVE: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
    PAUSED: "bg-[#FFF3C4] text-[#1A1A1A]",
  };

  async function handleDeleteClient(id: string, name: string) {
    if (!confirm(`Delete client "${name}"? This cannot be undone.`)) return;
    try {
      await apiFetch(`/admin/clients/${id}`, { method: "DELETE" });
      mutate();
    } catch (err: any) { alert(err.message); }
  }

  async function sendInvite() {
    if (!inviteTarget) return;
    setInviting(true);
    setInviteMsg(null);
    try {
      await apiFetch<any>("/client/auth/invite-request", {
        method: "POST",
        body: JSON.stringify({ email: inviteTarget.email }),
      });
      setInviteMsg({ type: "success", text: `Invite sent to ${inviteTarget.email}` });
      setTimeout(() => { setInviteTarget(null); setInviteMsg(null); }, 2000);
    } catch (err: any) {
      setInviteMsg({ type: "error", text: err.message || "Failed to send invite" });
    } finally {
      setInviting(false);
    }
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Clients</h1>
        <Link href="/clients/new"><Button className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]"><Plus className="h-4 w-4 mr-2" /> New Client</Button></Link>
      </div>
      <div className="relative max-w-sm crx-animate-slide crx-delay-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#B0B0B0]" />
        <Input placeholder="Search clients..." className="pl-10 border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {isLoading ? (
        <p className="text-[#7A7A7A]">Loading...</p>
      ) : (
        <div className="grid gap-3">
          {clients.map((c: any, i: number) => (
            <div key={c.id} className={`bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-4 flex items-center justify-between transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-${Math.min(i + 2, 6)}`}>
              <Link href={`/clients/${c.id}`} className="flex items-center gap-3 flex-1 min-w-0">
                <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center shrink-0">
                  <Building2 className="h-5 w-5 text-[#1A1A1A]" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-[#1A1A1A] truncate">{c.companyName}</p>
                  <p className="text-xs text-[#7A7A7A] truncate">{c.contactName} · {c.email}</p>
                </div>
              </Link>
              <div className="flex items-center gap-3 shrink-0 ml-3">
                <span className="text-xs text-[#B0B0B0]">{c._count?.projects || 0} projects</span>
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge[c.status] || "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>
                  {formatStatus(c.status)}
                </span>
                {c.email && (
                  <button
                    onClick={() => { setInviteTarget({ id: c.id, email: c.email, name: c.companyName }); setInviteMsg(null); }}
                    className="flex items-center gap-1.5 text-xs text-[#7A7A7A] hover:text-[#1A1A1A] border border-[#F0EAD8] hover:border-[#E8D8B4] rounded-lg px-2.5 py-1.5 transition-all"
                    title="Invite to Client Portal"
                  >
                    <Send className="h-3 w-3" /> Invite
                  </button>
                )}
                {isAdminOrSuperAdmin && (
                  <button
                    onClick={() => handleDeleteClient(c.id, c.companyName)}
                    className="flex items-center gap-1.5 text-xs text-red-500 hover:text-red-700 border border-red-100 hover:border-red-200 rounded-lg px-2.5 py-1.5 transition-all"
                    title="Delete Client"
                  >
                    <Trash2 className="h-3 w-3" /> Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Invite confirmation modal */}
      {inviteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => !inviting && setInviteTarget(null)} />
          <div className="relative bg-white rounded-2xl shadow-2xl border border-[#E8E0D0] p-6 w-full max-w-sm z-10">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-[#1A1A1A]">Invite to Client Portal</h2>
              <button onClick={() => setInviteTarget(null)} disabled={inviting} className="text-[#B0B0B0] hover:text-[#1A1A1A]"><X className="h-5 w-5" /></button>
            </div>
            <p className="text-sm text-[#7A7A7A] mb-1">Send a portal invite to:</p>
            <p className="text-sm font-medium text-[#1A1A1A] mb-1">{inviteTarget.name}</p>
            <p className="text-sm text-[#7A7A7A] mb-5">{inviteTarget.email}</p>

            {inviteMsg && (
              <div className={`flex items-center gap-2 text-sm rounded-lg px-3 py-2 mb-4 ${inviteMsg.type === "success" ? "bg-emerald-50/60 border border-emerald-100 text-emerald-700" : "bg-red-50/60 border border-red-100 text-[#E74C3C]"}`}>
                {inviteMsg.type === "success" ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
                {inviteMsg.text}
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={sendInvite} disabled={inviting || inviteMsg?.type === "success"}
                className="flex items-center gap-2 bg-[#1A1A1A] text-white py-2.5 px-5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all"
              >
                <Send className="h-3.5 w-3.5" />
                {inviting ? "Sending..." : "Send Invite"}
              </button>
              <button onClick={() => setInviteTarget(null)} disabled={inviting} className="border border-[#F0EAD8] text-[#7A7A7A] py-2.5 px-5 rounded-full text-sm hover:border-[#E8D8B4] transition-all">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
