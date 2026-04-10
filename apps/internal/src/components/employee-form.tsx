"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Card, CardHeader, CardTitle, CardContent } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

interface EmployeeFormProps {
  employee?: any;
  roles: any[];
}

export function EmployeeForm({ employee, roles }: EmployeeFormProps) {
  const router = useRouter();
  const isEdit = !!employee;
  const [form, setForm] = useState({
    name: employee?.name || "",
    email: employee?.email || "",
    password: "",
    phone: employee?.phone || "",
    roleIds: employee?.roles?.map((r: any) => r.id) || [],
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (isEdit) {
        const updateData = { name: form.name, phone: form.phone, roleIds: form.roleIds };
        await apiFetch(`/employees/${employee.id}`, {
          method: "PUT",
          body: JSON.stringify(updateData),
        });
      } else {
        await apiFetch("/employees", {
          method: "POST",
          body: JSON.stringify(form),
        });
      }
      router.push("/employees");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function toggleRole(roleId: string) {
    setForm((prev) => ({
      ...prev,
      roleIds: prev.roleIds.includes(roleId)
        ? prev.roleIds.filter((id: string) => id !== roleId)
        : [...prev.roleIds, roleId],
    }));
  }

  return (
    <Card className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
      <CardHeader>
        <CardTitle className="font-serif text-[#1A1A1A]">{isEdit ? "Edit Employee" : "Add New Employee"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Input label="Full Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
          {!isEdit && <Input label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />}
          {!isEdit && <Input label="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />}
          <Input label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />

          <div className="space-y-2">
            <label className="text-sm font-medium text-[#1A1A1A]">Roles</label>
            <div className="flex flex-wrap gap-2">
              {roles.map((role: any) => (
                <button
                  key={role.id}
                  type="button"
                  onClick={() => toggleRole(role.id)}
                  className={`px-3 py-1 rounded-full text-sm border transition-colors ${
                    form.roleIds.includes(role.id)
                      ? "bg-[#1A1A1A] text-white border-[#1A1A1A]"
                      : "bg-white text-[#7A7A7A] border-[#E8E0D0] hover:border-[#F5D547]"
                  }`}
                >
                  {role.name}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <Button type="submit" disabled={loading} className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">
              {loading ? "Saving..." : isEdit ? "Update Employee" : "Create Employee"}
            </Button>
            <Button type="button" variant="outline" onClick={() => router.back()} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[#FEFCF7]">
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
