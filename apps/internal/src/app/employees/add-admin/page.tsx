"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { stringSimilarity } from "@dashmani/shared";
import { ArrowLeft, UserPlus, Send, Eye, EyeOff, AlertTriangle } from "lucide-react";
import Link from "next/link";

type Role = { id: string; name: string; description?: string };
type Employee = { id: string; name: string; email: string };

const DUP_THRESHOLD = 0.85;

function findDuplicates(employees: Employee[], name: string, email: string): Employee[] {
  const emailLocal = email.split("@")[0].toLowerCase();
  return employees.filter((emp) => {
    const nameSim = name ? stringSimilarity(emp.name, name) : 0;
    const empLocal = emp.email.split("@")[0].toLowerCase();
    const emailSim = emailLocal ? stringSimilarity(empLocal, emailLocal) : 0;
    return nameSim >= DUP_THRESHOLD || emailSim >= DUP_THRESHOLD;
  });
}

export default function AddAdminPage() {
  const router = useRouter();
  const [roles, setRoles] = useState<Role[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [tab, setTab] = useState<"create" | "invite">("create");

  // Create form
  const [createForm, setCreateForm] = useState({ name: "", email: "", password: "", designation: "", salary: "" });
  const [createRoleIds, setCreateRoleIds] = useState<string[]>([]);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createSuccess, setCreateSuccess] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [createDups, setCreateDups] = useState<Employee[]>([]);
  const [createDupDismissed, setCreateDupDismissed] = useState(false);

  // Invite form
  const [inviteForm, setInviteForm] = useState({ email: "", designation: "" });
  const [inviteRoleIds, setInviteRoleIds] = useState<string[]>([]);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteSuccess, setInviteSuccess] = useState("");
  const [inviteDups, setInviteDups] = useState<Employee[]>([]);
  const [inviteDupDismissed, setInviteDupDismissed] = useState(false);

  useEffect(() => {
    apiFetch<any>("/roles").then((res) => setRoles(res.data || [])).catch(() => {});
    apiFetch<any>("/employees?limit=500").then((res) => setEmployees(res.data || [])).catch(() => {});
  }, []);

  function updateCreateForm(patch: Partial<typeof createForm>) {
    const next = { ...createForm, ...patch };
    setCreateForm(next);
    setCreateDupDismissed(false);
    setCreateDups(findDuplicates(employees, next.name, next.email));
  }

  function updateInviteForm(patch: Partial<typeof inviteForm>) {
    const next = { ...inviteForm, ...patch };
    setInviteForm(next);
    setInviteDupDismissed(false);
    setInviteDups(findDuplicates(employees, "", next.email));
  }

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
      setCreateDups([]);
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
      setInviteDups([]);
    } catch (err: any) {
      setInviteError(err.message || "Failed to send invite");
    } finally {
      setInviteLoading(false);
    }
  }

  const inputClass = "w-full h-12 px-[18px] rounded-[14px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[14px] outline-none focus:border-[rgba(233,189,98,.6)] min-w-0 transition-colors placeholder:text-ds-t4";
  const labelClass = "block text-[10.5px] font-bold tracking-[.14em] uppercase text-ds-t3 mb-2";
  const roleChip = (on: boolean) =>
    `inline-flex items-center h-[30px] px-3 rounded-[15px] border text-[12px] font-semibold whitespace-nowrap transition-colors ${
      on ? "border-ds-gold/55 bg-ds-gold/[.14] text-ds-gold" : "border-ds-line2 bg-ds-inset text-ds-t2 hover:text-ds-text hover:border-ds-line4"
    }`;
  const goldBtn = "inline-flex items-center gap-2 h-11 px-6 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13.5px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60 transition-colors";
  const cancelBtn = "inline-flex items-center h-11 px-6 rounded-full border border-ds-line2 text-[13.5px] font-semibold text-ds-t2 hover:border-ds-line4 hover:text-ds-text transition-colors";
  const errClass = "flex items-center gap-2 text-[13px] font-semibold text-[color:var(--hx-FB7185)] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] rounded-[12px] px-3.5 py-2.5";
  const okClass = "flex items-center gap-2 text-[13px] font-semibold text-ds-teal bg-ds-teal/[.08] border border-ds-teal/30 rounded-[12px] px-3.5 py-2.5";

  function DupWarning({ dups, onDismiss }: { dups: Employee[]; onDismiss: () => void }) {
    return (
      <div className="flex items-start gap-2 text-[13px] text-ds-gold2 bg-ds-gold/[.08] border border-ds-gold/30 rounded-[12px] px-3.5 py-2.5">
        <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1">
          <span className="font-medium">Possible duplicate: </span>
          {dups.map((d) => `${d.name} (${d.email})`).join(", ")}
          <span className="text-ds-t2 ml-1">— you can still proceed.</span>
        </div>
        <button type="button" onClick={onDismiss} className="text-ds-gold hover:text-ds-gold2 text-[12px] font-semibold shrink-0">Dismiss</button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto pb-8">
      <section className="pt-[22px] pb-[22px]">
        <Link href="/employees" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ds-t2 hover:text-ds-gold transition-colors">
          <ArrowLeft className="h-[13px] w-[13px]" strokeWidth={2} /> Employees
        </Link>
        <div className="mt-4">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Add Admin User</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">Create a new admin directly or send an email invite</p>
        </div>
      </section>

      {/* Tabs */}
      <div className="flex gap-0.5 p-0.5 rounded-[15px] bg-ds-inset border border-ds-line mb-5 w-fit" role="group" aria-label="Mode">
        {(["create", "invite"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={`h-[26px] px-3.5 rounded-[13px] text-[11px] font-semibold whitespace-nowrap transition-colors ${
              tab === t ? "bg-ds-blue text-white" : "text-ds-t2 hover:text-ds-text"
            }`}
          >
            {t === "create" ? "Direct Create" : "Send Invite"}
          </button>
        ))}
      </div>

      <div className="relative rounded-[20px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_14px_36px_rgba(0,0,0,.32)] overflow-hidden px-5 py-6 sm:px-[30px] sm:py-7">
        <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px opacity-60 bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]" />
        {tab === "create" ? (
          <form onSubmit={handleCreate} className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Full Name *</label>
                <input className={inputClass} required placeholder="Jane Doe" value={createForm.name} onChange={(e) => updateCreateForm({ name: e.target.value })} />
              </div>
              <div>
                <label className={labelClass}>Email *</label>
                <input type="email" className={inputClass} required placeholder="jane@digitalsukoon.com" value={createForm.email} onChange={(e) => updateCreateForm({ email: e.target.value })} />
              </div>
            </div>

            {createDups.length > 0 && !createDupDismissed && (
              <DupWarning dups={createDups} onDismiss={() => setCreateDupDismissed(true)} />
            )}

            <div>
              <label className={labelClass}>Password *</label>
              <div className="relative">
                <input type={showPass ? "text" : "password"} className={inputClass + " pr-12"} required placeholder="Set initial password" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} />
                <button type="button" onClick={() => setShowPass(!showPass)} aria-label={showPass ? "Hide password" : "Show password"} className="absolute right-2 top-1/2 -translate-y-1/2 h-[34px] w-[34px] rounded-[10px] text-ds-t3 grid place-items-center hover:text-ds-text">
                  {showPass ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Designation</label>
                <input className={inputClass} placeholder="e.g. Senior Manager" value={createForm.designation} onChange={(e) => setCreateForm({ ...createForm, designation: e.target.value })} />
              </div>
              <div>
                <label className={labelClass}>Monthly Salary (₹)</label>
                <input type="number" className={inputClass} placeholder="0" value={createForm.salary} onChange={(e) => setCreateForm({ ...createForm, salary: e.target.value })} />
              </div>
            </div>

            <div>
              <label className={labelClass}>Roles</label>
              <div className="flex flex-wrap gap-2">
                {roles.map((role) => (
                  <button key={role.id} type="button" onClick={() => toggleRole(role.id, createRoleIds, setCreateRoleIds)}
                    aria-pressed={createRoleIds.includes(role.id)}
                    className={roleChip(createRoleIds.includes(role.id))}
                  >
                    {role.name}
                  </button>
                ))}
              </div>
            </div>

            {createError && <div role="alert" className={errClass}>{createError}</div>}
            {createSuccess && <div role="status" className={okClass}>{createSuccess}</div>}

            <div className="flex flex-wrap gap-3 pt-5 border-t border-[color:var(--hx-1A2C38)]">
              <button type="submit" disabled={createLoading}
                className={goldBtn}
              >
                <UserPlus className="h-4 w-4" />
                {createLoading ? "Creating..." : "Create Admin User"}
              </button>
              <Link href="/employees" className={cancelBtn}>
                Cancel
              </Link>
            </div>
          </form>
        ) : (
          <form onSubmit={handleInvite} className="space-y-5">
            <p className="text-[13px] text-ds-t2">The recipient will receive an email with a signup link valid for 7 days.</p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Email Address *</label>
                <input type="email" className={inputClass} required placeholder="newadmin@digitalsukoon.com" value={inviteForm.email} onChange={(e) => updateInviteForm({ email: e.target.value })} />
              </div>
              <div>
                <label className={labelClass}>Designation</label>
                <input className={inputClass} placeholder="e.g. Content Manager" value={inviteForm.designation} onChange={(e) => setInviteForm({ ...inviteForm, designation: e.target.value })} />
              </div>
            </div>

            {inviteDups.length > 0 && !inviteDupDismissed && (
              <DupWarning dups={inviteDups} onDismiss={() => setInviteDupDismissed(true)} />
            )}

            <div>
              <label className={labelClass}>Roles</label>
              <div className="flex flex-wrap gap-2">
                {roles.map((role) => (
                  <button key={role.id} type="button" onClick={() => toggleRole(role.id, inviteRoleIds, setInviteRoleIds)}
                    aria-pressed={inviteRoleIds.includes(role.id)}
                    className={roleChip(inviteRoleIds.includes(role.id))}
                  >
                    {role.name}
                  </button>
                ))}
              </div>
            </div>

            {inviteError && <div role="alert" className={errClass}>{inviteError}</div>}
            {inviteSuccess && <div role="status" className={okClass}>{inviteSuccess}</div>}

            <div className="flex flex-wrap gap-3 pt-5 border-t border-[color:var(--hx-1A2C38)]">
              <button type="submit" disabled={inviteLoading}
                className={goldBtn}
              >
                <Send className="h-4 w-4" />
                {inviteLoading ? "Sending..." : "Send Invite Email"}
              </button>
              <Link href="/employees" className={cancelBtn}>
                Cancel
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
