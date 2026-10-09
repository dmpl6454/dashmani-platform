"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";

// Premium dark ("ds") styling — same field/button idiom as /devices and /settings.
const LABEL = "block text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3 mb-[7px]";
const FIELD =
  "h-[42px] w-full px-3 rounded-[10px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] outline-none focus:border-ds-gold placeholder:text-ds-t4 [color-scheme:dark] min-w-0 transition-colors";
const GOLD_BTN =
  "inline-flex items-center justify-center gap-2 h-10 px-5 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13px] font-bold whitespace-nowrap transition-colors hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60";
const GHOST_BTN =
  "inline-flex items-center justify-center gap-2 h-10 px-5 rounded-full border border-ds-line2 bg-ds-card text-ds-t5 text-[13px] font-semibold whitespace-nowrap transition-colors hover:border-ds-line4 hover:text-ds-text";

function Field({ id, label, className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement> & { id: string; label: string }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className={LABEL}>{label}</label>
      <input id={id} className={`${FIELD} ${className}`} {...props} />
    </div>
  );
}

interface EmployeeFormProps {
  employee?: any;
  roles: any[];
  profile?: any;
  onSaved?: () => void;
}

export function EmployeeForm({ employee, roles, profile, onSaved }: EmployeeFormProps) {
  const router = useRouter();
  const isEdit = !!employee;
  const [teams, setTeams] = useState<any[]>([]);
  const [form, setForm] = useState({
    name: employee?.name || "",
    email: employee?.email || "",
    password: "",
    phone: employee?.phone || "",
    roleIds: employee?.roles?.map((r: any) => r.role?.id ?? r.id) || [],
    status: employee?.status || "ONBOARDING",
    orgUnitId: employee?.orgUnit?.id || "",
    designation: profile?.designation || employee?.profile?.designation || "",
    joinDate: profile?.joiningDate
      ? new Date(profile.joiningDate).toISOString().split("T")[0]
      : employee?.profile?.joiningDate
        ? employee.profile.joiningDate.split("T")[0]
        : "",
    salary: profile?.salary != null
      ? String(profile.salary)
      : employee?.profile?.salary != null
        ? String(employee.profile.salary)
        : "",
  });

  // Re-sync form when profile data arrives (async fetch)
  useEffect(() => {
    if (!profile) return;
    setForm((prev) => ({
      ...prev,
      designation: profile.designation || prev.designation,
      joinDate: profile.joiningDate
        ? new Date(profile.joiningDate).toISOString().split("T")[0]
        : prev.joinDate,
      salary: profile.salary != null ? String(profile.salary) : prev.salary,
    }));
  }, [profile]);

  useEffect(() => {
    apiFetch("/teams").then((res: any) => setTeams(res.data || []));
  }, []);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (isEdit) {
        const updateData: any = {
          name: form.name,
          phone: form.phone,
          status: form.status,
          ...(form.roleIds.length > 0 ? { roleIds: form.roleIds } : {}),
          orgUnitId: form.orgUnitId || null,
        };
        await apiFetch(`/employees/${employee.id}`, {
          method: "PUT",
          body: JSON.stringify(updateData),
        });
        // Also persist designation / joinDate / salary to EmployeeProfile
        if (form.designation || form.joinDate || form.salary) {
          await apiFetch(`/admin/employees/${employee.id}/profile-data`, {
            method: "PUT",
            body: JSON.stringify({
              designation: form.designation || undefined,
              joinDate: form.joinDate || undefined,
              salary: form.salary ? parseFloat(form.salary) : undefined,
            }),
          });
        }
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
        onSaved?.();
      } else {
        const payload: any = {
          name: form.name,
          email: form.email,
          password: form.password,
          phone: form.phone || undefined,
          roleIds: form.roleIds,
          orgUnitId: form.orgUnitId || undefined,
          designation: form.designation || undefined,
          joinDate: form.joinDate || undefined,
          salary: form.salary ? parseFloat(form.salary) : undefined,
        };
        await apiFetch("/employees", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        router.push("/employees");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function toggleRole(roleId: string) {
    setForm((prev) => {
      const isSelected = prev.roleIds.includes(roleId);
      if (isSelected && prev.roleIds.length === 1) return prev; // block removing the last role
      return {
        ...prev,
        roleIds: isSelected
          ? prev.roleIds.filter((id: string) => id !== roleId)
          : [...prev.roleIds, roleId],
      };
    });
  }

  return (
    <div className="rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.35)] p-5 sm:p-6">
      <h2 className="m-0 mb-5 text-[18px] font-semibold tracking-[-.02em] text-ds-text">{isEdit ? "Edit Employee" : "Add New Employee"}</h2>
      <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
        {error && (
          <p role="alert" className="px-3.5 py-2.5 rounded-[10px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12.5px]">{error}</p>
        )}
        <Field id="emp-name" label="Full Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        {!isEdit && <Field id="emp-email" label="Email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />}
        {!isEdit && <Field id="emp-password" label="Password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />}
        <Field id="emp-phone" label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            id="emp-designation"
            label="Designation"
            value={form.designation}
            onChange={(e) => setForm({ ...form, designation: e.target.value })}
          />
          <Field
            id="emp-joindate"
            label="Join Date"
            type="date"
            value={form.joinDate}
            onChange={(e) => setForm({ ...form, joinDate: e.target.value })}
          />
          <Field
            id="emp-salary"
            label="Salary (₹)"
            type="number"
            value={form.salary}
            onChange={(e) => setForm({ ...form, salary: e.target.value })}
          />
          <div className="min-w-0">
            <label htmlFor="emp-team" className={LABEL}>Team</label>
            <select
              id="emp-team"
              value={form.orgUnitId}
              onChange={(e) => setForm({ ...form, orgUnitId: e.target.value })}
              className={`${FIELD} cursor-pointer`}
            >
              <option value="">No team</option>
              {teams.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          {isEdit && (
            <div className="min-w-0">
              <label htmlFor="emp-status" className={LABEL}>Status</label>
              <select
                id="emp-status"
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                className={`${FIELD} cursor-pointer`}
              >
                <option value="ACTIVE">Active</option>
                <option value="ONBOARDING">Onboarding</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </div>
          )}
        </div>

        {!isEdit && (
          <div>
            <span className={LABEL}>Roles</span>
            <div className="flex flex-wrap gap-2">
              {roles.map((role: any) => {
                const active = form.roleIds.includes(role.id);
                const isLast = active && form.roleIds.length === 1;
                return (
                <button
                  key={role.id}
                  type="button"
                  onClick={() => toggleRole(role.id)}
                  title={isLast ? "Cannot remove the only role" : undefined}
                  aria-pressed={active}
                  className={`inline-flex items-center h-[30px] px-3 rounded-full text-[12px] font-semibold border transition-colors ${
                    active
                      ? isLast
                        ? "border-ds-gold/55 bg-ds-gold/[.14] text-ds-gold opacity-60 cursor-not-allowed"
                        : "border-ds-gold/55 bg-ds-gold/[.14] text-ds-gold"
                      : "border-ds-line2 bg-ds-inset text-ds-t2 hover:text-ds-text hover:border-ds-line4"
                  }`}
                >
                  {role.name}
                </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2.5 flex-wrap pt-4 border-t border-[color:var(--hx-1A2C38)]">
          <button type="submit" disabled={loading} className={GOLD_BTN}>
            {loading ? "Saving..." : isEdit ? "Update Employee" : "Create Employee"}
          </button>
          {!isEdit && (
            <button type="button" onClick={() => router.back()} className={GHOST_BTN}>
              Cancel
            </button>
          )}
          {saved && (
            <span role="status" className="text-[12px] text-ds-teal font-semibold">✓ Saved</span>
          )}
        </div>
      </form>
    </div>
  );
}
