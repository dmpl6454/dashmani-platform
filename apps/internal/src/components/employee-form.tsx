"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Card, CardHeader, CardTitle, CardContent } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

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
    <Card className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-border">
      <CardHeader>
        <CardTitle className="font-serif text-ink">{isEdit ? "Edit Employee" : "Add New Employee"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Input label="Full Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />
          {!isEdit && <Input label="Email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />}
          {!isEdit && <Input label="Password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />}
          <Input label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Designation"
              value={form.designation}
              onChange={(e) => setForm({ ...form, designation: e.target.value })}
              className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action"
            />
            <Input
              label="Join Date"
              type="date"
              value={form.joinDate}
              onChange={(e) => setForm({ ...form, joinDate: e.target.value })}
              className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action"
            />
            <Input
              label="Salary (₹)"
              type="number"
              value={form.salary}
              onChange={(e) => setForm({ ...form, salary: e.target.value })}
              className="border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action"
            />
            <div className="space-y-1">
              <label className="text-sm font-medium text-ink">Team</label>
              <select
                value={form.orgUnitId}
                onChange={(e) => setForm({ ...form, orgUnitId: e.target.value })}
                className="flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:ring-2 focus:ring-action focus:border-action outline-none"
              >
                <option value="">No team</option>
                {teams.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            {isEdit && (
              <div className="space-y-1">
                <label className="text-sm font-medium text-ink">Status</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                  className="flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:ring-2 focus:ring-action focus:border-action outline-none"
                >
                  <option value="ACTIVE">Active</option>
                  <option value="ONBOARDING">Onboarding</option>
                  <option value="INACTIVE">Inactive</option>
                </select>
              </div>
            )}
          </div>

          {!isEdit && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-ink">Roles</label>
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
                    className={`px-3 py-1 rounded-full text-sm border transition-colors ${
                      active
                        ? isLast
                          ? "bg-action text-[#06121B] border-[#33506A] opacity-60 cursor-not-allowed"
                          : "bg-action text-[#06121B] border-[#33506A]"
                        : "bg-surface text-ink-3 border-border hover:border-action"
                    }`}
                  >
                    {role.name}
                  </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={loading} className="bg-action text-[#06121B] rounded-full hover:bg-[#243645]">
              {loading ? "Saving..." : isEdit ? "Update Employee" : "Create Employee"}
            </Button>
            {!isEdit && (
              <Button type="button" variant="outline" onClick={() => router.back()} className="border border-border rounded-full text-ink hover:bg-surface">
                Cancel
              </Button>
            )}
            {saved && (
              <span className="text-xs text-emerald-600 font-medium">✓ Saved</span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
