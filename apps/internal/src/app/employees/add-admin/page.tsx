"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { ArrowLeft, UserPlus, Send, Eye, EyeOff } from "lucide-react";
import Link from "next/link";

type Role = { id: string; name: string; description?: string };

export default function AddAdminPage() {
  const router = useRouter();
  const [roles, setRoles] = useState<Role[]>([]);
  const [tab, setTab] = useState<"create" | "invite">("create");

  // Create form
  const [createForm, setCreateForm] = useState({ name: "", email: "", password: "", designation: "", salary: "" });
  const [createRoleIds, setCreateRoleIds] = useState<string[]>([]);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");
  const [showPass, setShowPass] = useState(false);

  // Invite form
  const [inviteForm, setInviteForm] = useState({ email: "", designation: "" });
  const [inviteRoleIds, setInviteRoleIds] = useState<string[]>([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteSuccess, setInviteSuccess] = useState("");

  useEffect(() => {
    apiFetch<any>("/roles").then((res) => setRoles(res.data || [])).catch(() => {});
  }, []);

  function toggleRole(id: string, arr: string[], setArr: (v: string[]) => void) {
    setArr(arr.includes(id) ? arr.filter((r) => r !== id) : [...arr, id]);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError("");
    setCreateSuccess("");
    setCreateLoading(true);
    try {
      await apiFetch<any>("/admin/users/create", {
        method: "POST",
        body: JSON.stringify({
          name: createForm.name,
          email: createForm.email,
          password: createForm.password,
          roleIds: createRoleIds,
          designation: createForm.designation || undefined,
          salary: createForm.salary ? Number(createForm.salary) : undefined,
        }),
      });
      setCreateSuccess(`Admin user "${createForm.name}" created successfully.`);
      setCreateForm({ name: "", email: "", password: "", designation: "", salary: "" });
      setCreateRoleIds([]);
    } catch (err: any) {
      setCreateError(err.message || "Failed to create admin user");
    } finally {
      setCreateLoading(false);
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError("");
    setInviteSuccess("");
    setInviteLoading(true);
    try {
      await apiFetch<any>("/admin/users/invite", {
        method: "POST",
        body: JSON.stringify({
          email: inviteForm.email,
          roleIds: inviteRoleIds,
          designation: inviteForm.designation || undefined,
        }),
      });
      setInviteSuccess(`Invite sent to ${inviteForm.email}.`);
      setInviteForm({ email: "", designation: "" });
      setInviteRoleIds([]);
    } catch (err: any) {
      setInviteError(err.message || "Failed to send invite");
    } finally {
      setInviteLoading(false);
    }
  }

  const inputClass = "w-full rounded-xl border border-[#F0EAD8] bg-[#FFF8E1]/60 px-4 py-3 text-sm outline-none focus:border-[#F5D547] focus:ring-2 focus:ring-[#F5D547]/20 transition-all placeholder:text-[#B0B0B0]";

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/employees" className="p-2 rounded-lg hover:bg-white/60 transition-colors">
          <ArrowLeft className="h-5 w-5 text-[#7A7A7A]" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold text-[#1A1A1A]">Add Admin User</h1>
          <p className="text-sm text-[#7A7A7A] mt-0.5">Create a new admin directly or send an email invite</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/60 rounded-xl p-1 border border-white/50 mb-6 w-fit">
        {(["create", "invite"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t ? "bg-[#F5D547] text-[#1A1A1A] shadow-sm" : "text-[#7A7A7A] hover:text-[#1A1A1A]"
            }`}
          >
            {t === "create" ? "Direct Create" : "Send Invite"}
          </button>
        ))}
      </div>

      <div className="bg-white/60 backdrop-blur-xl rounded-2xl border border-white/50 shadow-[0_8px_40px_rgba(0,0,0,0.06)] p-7">
        {tab === "create" ? (
          <form onSubmit={handleCreate} className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Full Name *</label>
                <input className={inputClass} required placeholder="Jane Doe" value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Email *</label>
                <input type="email" className={inputClass} required placeholder="jane@digitalsukoon.com" value={createForm.email} onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} />
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Password *</label>
              <div className="relative">
                <input type={showPass ? "text" : "password"} className={inputClass + " pr-10"} required placeholder="Set initial password" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} />
                <button type="button" onClick={() => setShowPass(!showPass)} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#B0B0B0] hover:text-[#7A7A7A]">
                  {showPass ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Designation</label>
                <input className={inputClass} placeholder="e.g. Senior Manager" value={createForm.designation} onChange={(e) => setCreateForm({ ...createForm, designation: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Monthly Salary (₹)</label>
                <input type="number" className={inputClass} placeholder="0" value={createForm.salary} onChange={(e) => setCreateForm({ ...createForm, salary: e.target.value })} />
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#7A7A7A] mb-2 font-medium">Roles</label>
              <div className="flex flex-wrap gap-2">
                {roles.map((role) => (
                  <button key={role.id} type="button" onClick={() => toggleRole(role.id, createRoleIds, setCreateRoleIds)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                      createRoleIds.includes(role.id)
                        ? "bg-[#F5D547] border-[#F5D547] text-[#1A1A1A]"
                        : "bg-white/60 border-[#F0EAD8] text-[#7A7A7A] hover:border-[#F5D547]"
                    }`}
                  >
                    {role.name}
                  </button>
                ))}
              </div>
            </div>

            {createError && <div className="flex items-center gap-2 text-sm text-[#E74C3C] bg-red-50/60 border border-red-100 rounded-lg px-3 py-2">{createError}</div>}
            {createSuccess && <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50/60 border border-emerald-100 rounded-lg px-3 py-2">{createSuccess}</div>}

            <div className="flex gap-3 pt-2">
              <button type="submit" disabled={createLoading}
                className="flex items-center gap-2 px-6 py-3 rounded-full bg-[#F5D547] text-[#1A1A1A] text-sm font-semibold shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_8px_32px_rgba(245,213,71,0.45)] hover:-translate-y-0.5 disabled:opacity-50 transition-all"
              >
                <UserPlus className="h-4 w-4" />
                {createLoading ? "Creating..." : "Create Admin User"}
              </button>
              <Link href="/employees" className="px-6 py-3 rounded-full border border-[#F0EAD8] text-sm text-[#7A7A7A] hover:border-[#E8D8B4] transition-colors">
                Cancel
              </Link>
            </div>
          </form>
        ) : (
          <form onSubmit={handleInvite} className="space-y-5">
            <p className="text-sm text-[#7A7A7A]">The recipient will receive an email with a signup link valid for 7 days.</p>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Email Address *</label>
                <input type="email" className={inputClass} required placeholder="newadmin@digitalsukoon.com" value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })} />
              </div>
              <div>
                <label className="block text-xs text-[#7A7A7A] mb-1.5 font-medium">Designation</label>
                <input className={inputClass} placeholder="e.g. Content Manager" value={inviteForm.designation} onChange={(e) => setInviteForm({ ...inviteForm, designation: e.target.value })} />
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#7A7A7A] mb-2 font-medium">Roles</label>
              <div className="flex flex-wrap gap-2">
                {roles.map((role) => (
                  <button key={role.id} type="button" onClick={() => toggleRole(role.id, inviteRoleIds, setInviteRoleIds)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                      inviteRoleIds.includes(role.id)
                        ? "bg-[#F5D547] border-[#F5D547] text-[#1A1A1A]"
                        : "bg-white/60 border-[#F0EAD8] text-[#7A7A7A] hover:border-[#F5D547]"
                    }`}
                  >
                    {role.name}
                  </button>
                ))}
              </div>
            </div>

            {inviteError && <div className="flex items-center gap-2 text-sm text-[#E74C3C] bg-red-50/60 border border-red-100 rounded-lg px-3 py-2">{inviteError}</div>}
            {inviteSuccess && <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50/60 border border-emerald-100 rounded-lg px-3 py-2">{inviteSuccess}</div>}

            <div className="flex gap-3 pt-2">
              <button type="submit" disabled={inviteLoading}
                className="flex items-center gap-2 px-6 py-3 rounded-full bg-[#F5D547] text-[#1A1A1A] text-sm font-semibold shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_8px_32px_rgba(245,213,71,0.45)] hover:-translate-y-0.5 disabled:opacity-50 transition-all"
              >
                <Send className="h-4 w-4" />
                {inviteLoading ? "Sending..." : "Send Invite Email"}
              </button>
              <Link href="/employees" className="px-6 py-3 rounded-full border border-[#F0EAD8] text-sm text-[#7A7A7A] hover:border-[#E8D8B4] transition-colors">
                Cancel
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
