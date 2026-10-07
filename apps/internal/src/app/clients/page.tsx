"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useClients } from "@/lib/hooks/use-clients";
import { formatStatus, pluralize } from "@dashmani/shared";
import { Plus, Search, Building2, Send, X, Check, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ModalPortal } from "@/components/modal-portal";

// Mockup palette.
const STATUS_COLOR: Record<string, string> = { ACTIVE: "#00D7A0", PAUSED: "#6EB2FF", INACTIVE: "#738395" };
const HUES = ["#238BFF", "#E9BD62", "#9B7EDE", "#00D7A0", "#FB7185", "#6EB2FF"];
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
};
const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const initials = (name: string) =>
  (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

const FIELDS: { key: "companyName" | "contactName" | "email" | "password" | "phone"; label: string; type: string; req: boolean; ph: string; ac: string }[] = [
  { key: "companyName", label: "Company Name", type: "text", req: true, ph: "Company / brand name", ac: "organization" },
  { key: "contactName", label: "Contact Name", type: "text", req: true, ph: "Primary contact", ac: "name" },
  { key: "email", label: "Email", type: "email", req: true, ph: "name@company.com", ac: "email" },
  { key: "password", label: "Password", type: "password", req: true, ph: "Set a portal password", ac: "new-password" },
  { key: "phone", label: "Phone", type: "text", req: false, ph: "+91 …", ac: "tel" },
];
const EMPTY_FORM = { companyName: "", contactName: "", email: "", password: "", phone: "" };

const BTN_GHOST = "h-9 px-3.5 rounded-[6px] border border-ds-line2 text-ds-t2 text-[12px] font-semibold hover:text-ds-text hover:border-ds-line4 disabled:opacity-50";

export default function ClientsPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading, error, mutate } = useClients({ search });
  const clients = (data as any)?.data || [];
  const { user: currentUser } = useAuth();
  const callerRoles = (currentUser?.roles ?? []).map((r) => r.toLowerCase());
  const isAdminOrSuperAdmin = callerRoles.includes("super admin") || callerRoles.includes("admin");

  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [inviteTarget, setInviteTarget] = useState<{ id: string; email: string; name: string } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [newOpen, setNewOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");
  const [creating, setCreating] = useState(false);

  const totalProjects = clients.reduce((s: number, c: any) => s + (c._count?.projects || 0), 0);

  useEffect(() => {
    const anyOpen = newOpen || !!inviteTarget || !!deleteTarget;
    if (!anyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (deleteTarget && !deleting) setDeleteTarget(null);
      else if (inviteTarget && !inviting) setInviteTarget(null);
      else if (newOpen && !creating) setNewOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newOpen, inviteTarget, deleteTarget, deleting, inviting, creating]);

  async function confirmDeleteClient() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await apiFetch(`/admin/clients/${deleteTarget.id}`, { method: "DELETE" });
      mutate();
      setDeleteTarget(null);
    } catch (err: any) {
      setDeleteError(err.message || "Failed to delete client");
    } finally {
      setDeleting(false);
    }
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

  async function createClient(e: React.FormEvent) {
    e.preventDefault();
    const missing = FIELDS.filter((f) => f.req && !form[f.key].trim());
    if (missing.length) {
      setFormError(`${missing.map((f) => f.label).join(", ")} required`);
      return;
    }
    setCreating(true);
    setFormError("");
    try {
      await apiFetch("/clients", { method: "POST", body: JSON.stringify(form) });
      mutate();
      setNewOpen(false);
      setForm(EMPTY_FORM);
    } catch (err: any) {
      setFormError(err.message || "Failed to create client");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[26px] pb-5">
        <div className="flex-[1_1_320px] min-w-0">
          <div className="text-[10px] tracking-[.2em] uppercase text-ds-gold font-semibold">Business</div>
          <h1 className="mt-2 text-[28px] font-semibold tracking-[-.02em] text-ds-text">Clients</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">
            {isLoading && !data ? "Loading…" : `${pluralize(clients.length, "client")}${(data as any)?.meta?.has_more ? "+" : ""} · ${pluralize(totalProjects, "project")}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setForm(EMPTY_FORM); setFormError(""); setNewOpen(true); }}
          className="inline-flex items-center gap-[7px] h-10 px-5 rounded-full bg-ds-gold text-[#060D14] text-[13px] font-bold whitespace-nowrap hover:bg-[#F4D58C]"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.4} /> New Client
        </button>
      </section>

      {/* Search */}
      <section className="flex items-center gap-2.5 flex-wrap">
        <label className="flex items-center gap-2 h-[42px] px-4 rounded-full bg-ds-inset border border-ds-line2 text-ds-t3 flex-[0_1_480px] min-w-[220px] max-w-full">
          <Search className="h-[13px] w-[13px] shrink-0" />
          <input
            placeholder="Search clients..."
            aria-label="Search clients"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-ds-text text-[16px] sm:text-[12px] placeholder:text-ds-t3"
          />
        </label>
        {!isLoading && (
          <span className="ml-auto text-[11px] text-ds-t3 whitespace-nowrap">
            {search.trim() ? `${pluralize(clients.length, "client")} found` : `Showing ${pluralize(clients.length, "client")}`}
          </span>
        )}
      </section>

      {/* List */}
      <section className="flex flex-col gap-2.5 mt-4">
        {isLoading && !data ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-[78px] rounded-[12px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
          ))
        ) : error ? (
          <div className="py-12 px-5 rounded-[12px] border border-dashed border-ds-line2 text-center text-ds-t3 text-[12.5px]">
            Clients couldn&apos;t be loaded just now. Refresh to try again.
          </div>
        ) : clients.length === 0 ? (
          <div className="py-12 px-5 rounded-[12px] border border-dashed border-ds-line2 text-center text-ds-t3 text-[12.5px]">
            No clients found
          </div>
        ) : (
          clients.map((c: any) => {
            const color = STATUS_COLOR[c.status] ?? "#738395";
            const n = c._count?.projects || 0;
            return (
              <div
                key={c.id}
                className="relative flex items-center gap-4 flex-wrap px-5 py-4 rounded-[12px] bg-ds-card border border-ds-line overflow-hidden transition-colors hover:border-[#2A4658] hover:bg-[#0A1620]"
              >
                <Link href={`/clients/${c.id}`} className="group flex items-center gap-3.5 flex-[1_1_280px] min-w-0 text-ds-text">
                  <span className="h-[46px] w-[46px] rounded-[12px] bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.3)] text-ds-gold grid place-items-center shrink-0">
                    <Building2 className="h-5 w-5" strokeWidth={1.7} />
                  </span>
                  <span className="min-w-0 leading-[1.4]">
                    <span className="block text-[15px] font-semibold tracking-[-.01em] truncate group-hover:text-ds-gold transition-colors">{c.companyName}</span>
                    <span className="block text-[12px] text-ds-t2 truncate">
                      {c.contactName || "—"} <span className="text-[#33506A]">·</span> {c.email || "No email on file"}
                    </span>
                  </span>
                </Link>
                <div className="flex items-center gap-2.5 flex-wrap ml-auto">
                  <span className="text-[12px] text-ds-t3 whitespace-nowrap">{pluralize(n, "project")}</span>
                  <span
                    className="inline-flex items-center gap-1.5 h-[26px] px-[11px] rounded-full text-[11.5px] font-semibold whitespace-nowrap border"
                    style={{ background: rgba(color, 0.1), borderColor: rgba(color, 0.28), color }}
                  >
                    <i className="h-[5px] w-[5px] rounded-full" style={{ background: color }} />
                    {formatStatus(c.status)}
                  </span>
                  {c.email && (
                    <button
                      type="button"
                      onClick={() => { setInviteTarget({ id: c.id, email: c.email, name: c.companyName }); setInviteMsg(null); }}
                      title="Invite to Client Portal"
                      className="inline-flex items-center gap-1.5 h-8 px-[13px] rounded-full border border-ds-line2 text-ds-t5 text-[12px] font-semibold whitespace-nowrap hover:border-[rgba(35,139,255,.55)] hover:text-[#6EB2FF]"
                    >
                      <Send className="h-[13px] w-[13px]" /> Invite
                    </button>
                  )}
                  {isAdminOrSuperAdmin && (
                    <button
                      type="button"
                      onClick={() => { setDeleteTarget({ id: c.id, name: c.companyName }); setDeleteError(""); }}
                      title="Delete Client"
                      className="inline-flex items-center gap-1.5 h-8 px-[13px] rounded-full border border-[rgba(229,72,77,.3)] text-[#FB7185] text-[12px] font-semibold whitespace-nowrap hover:border-[rgba(229,72,77,.6)] hover:bg-[rgba(229,72,77,.08)]"
                    >
                      <Trash2 className="h-[13px] w-[13px]" /> Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </section>

      {/* New client — slide panel */}
      {newOpen && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-50 flex bg-[rgba(2,6,10,.65)]" onClick={() => !creating && setNewOpen(false)}>
              <div className="flex-1" />
              <form
                onSubmit={createClient}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Add New Client"
                className="w-full max-w-[420px] h-full bg-ds-card border-l border-ds-line2 flex flex-col shadow-[-20px_0_50px_rgba(0,0,0,.5)]"
              >
                <div className="flex items-center justify-between h-[57px] px-[22px] border-b border-ds-line shrink-0">
                  <span className="text-[14px] font-semibold text-ds-text">Add New Client</span>
                  <button type="button" onClick={() => setNewOpen(false)} disabled={creating} aria-label="Close" className="text-ds-t3 hover:text-ds-text">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-[22px] flex flex-col gap-4">
                  {formError && (
                    <div className="px-3 py-2.5 rounded-[6px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[#FB7185] text-[12px]">{formError}</div>
                  )}
                  {FIELDS.map((f) => (
                    <label key={f.key} className="flex flex-col gap-[7px] text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase">
                      <span>
                        {f.label}
                        {f.req && <span className="text-ds-gold ml-[3px]">*</span>}
                      </span>
                      <input
                        type={f.type}
                        value={form[f.key]}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                        placeholder={f.ph}
                        autoComplete={f.ac}
                        required={f.req}
                        className="h-[38px] px-3 rounded-[6px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[12.5px] tracking-normal normal-case font-normal outline-none focus:border-ds-gold placeholder:text-ds-t4"
                      />
                    </label>
                  ))}
                </div>
                <div className="flex justify-end gap-2 px-[22px] py-4 border-t border-ds-line shrink-0">
                  <button type="button" onClick={() => setNewOpen(false)} disabled={creating} className={BTN_GHOST}>Cancel</button>
                  <button type="submit" disabled={creating} className="h-9 px-[18px] rounded-[6px] bg-ds-gold text-[#060D14] text-[12px] font-bold hover:bg-[#F4D58C] disabled:opacity-60">
                    {creating ? "Creating..." : "Create Client"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* Invite modal */}
      {inviteTarget && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(2,6,10,.7)]" onClick={() => !inviting && setInviteTarget(null)}>
              <div
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Invite to Client Portal"
                className="relative w-full max-w-[400px] bg-ds-card border border-ds-line2 rounded-[12px] p-6 shadow-[0_20px_50px_rgba(0,0,0,.6)] overflow-hidden"
              >
                <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,#238BFF_30%,#238BFF_70%,transparent)]" />
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-semibold text-ds-text">Invite to Client Portal</span>
                  <button type="button" onClick={() => setInviteTarget(null)} disabled={inviting} aria-label="Close" className="text-ds-t3 hover:text-ds-text">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="text-[12px] text-ds-t3 mt-3.5">Send a portal invite to:</div>
                {(() => {
                  const hue = HUES[hash(inviteTarget.name || "") % HUES.length];
                  return (
                    <div className="flex items-center gap-3 mt-2.5 p-3 rounded-[8px] bg-ds-inset border border-ds-line">
                      <span
                        className="h-9 w-9 rounded-[9px] grid place-items-center text-[12px] font-bold shrink-0 border"
                        style={{ background: rgba(hue, 0.12), borderColor: rgba(hue, 0.3), color: hue }}
                      >
                        {initials(inviteTarget.name)}
                      </span>
                      <div className="min-w-0 leading-[1.35]">
                        <div className="text-[13px] font-semibold text-ds-text truncate">{inviteTarget.name}</div>
                        <div className="text-[11.5px] text-ds-t2 truncate">{inviteTarget.email}</div>
                      </div>
                    </div>
                  );
                })()}
                {inviteMsg && (
                  <div
                    className={`flex items-center gap-2 mt-3.5 px-3 py-2.5 rounded-[6px] text-[12px] font-semibold border ${
                      inviteMsg.type === "success"
                        ? "bg-[rgba(0,215,160,.08)] border-[rgba(0,215,160,.3)] text-ds-teal"
                        : "bg-[rgba(229,72,77,.08)] border-[rgba(229,72,77,.3)] text-[#FB7185]"
                    }`}
                  >
                    {inviteMsg.type === "success" ? <Check className="h-4 w-4 shrink-0" /> : <X className="h-4 w-4 shrink-0" />}
                    {inviteMsg.text}
                  </div>
                )}
                <div className="flex gap-2 mt-5">
                  <button
                    type="button"
                    onClick={sendInvite}
                    disabled={inviting || inviteMsg?.type === "success"}
                    className="inline-flex items-center gap-[7px] h-9 px-[18px] rounded-[6px] bg-ds-blue text-white text-[12px] font-bold disabled:opacity-55"
                  >
                    <Send className="h-[13px] w-[13px]" />
                    {inviting ? "Sending..." : "Send Invite"}
                  </button>
                  <button type="button" onClick={() => setInviteTarget(null)} disabled={inviting} className={BTN_GHOST}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <ModalPortal>
          <div className="ds-root contents">
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(2,6,10,.7)]" onClick={() => !deleting && setDeleteTarget(null)}>
              <div
                onClick={(e) => e.stopPropagation()}
                role="alertdialog"
                aria-modal="true"
                aria-label={`Delete ${deleteTarget.name}`}
                className="w-full max-w-[380px] bg-ds-card border border-ds-line2 rounded-[12px] p-6 shadow-[0_20px_50px_rgba(0,0,0,.6)]"
              >
                <div className="h-[38px] w-[38px] rounded-[10px] bg-[rgba(229,72,77,.12)] text-[#FB7185] grid place-items-center">
                  <Trash2 className="h-[17px] w-[17px]" />
                </div>
                <div className="text-[15px] font-semibold text-ds-text mt-3.5">Delete “{deleteTarget.name}”?</div>
                <div className="text-[12.5px] text-ds-t2 mt-1.5">This cannot be undone.</div>
                {deleteError && (
                  <div className="mt-3.5 px-3 py-2.5 rounded-[6px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[#FB7185] text-[12px]">{deleteError}</div>
                )}
                <div className="flex justify-end gap-2 mt-[22px]">
                  <button type="button" onClick={() => setDeleteTarget(null)} disabled={deleting} className={BTN_GHOST}>Cancel</button>
                  <button
                    type="button"
                    onClick={confirmDeleteClient}
                    disabled={deleting}
                    className="h-9 px-4 rounded-[6px] bg-[#E5484D] text-white text-[12px] font-bold disabled:opacity-60"
                  >
                    {deleting ? "Deleting..." : "Delete"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
}
