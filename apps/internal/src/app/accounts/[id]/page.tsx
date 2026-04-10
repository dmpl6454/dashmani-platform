"use client";
import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAccount } from "@/lib/hooks/use-accounts";
import { Button } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

export default function AccountDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { data, isLoading, mutate } = useAccount(id as string);
  const [employees, setEmployees] = useState<any[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [assigning, setAssigning] = useState(false);

  useEffect(() => {
    apiFetch("/employees?limit=100").then((res: any) => setEmployees(res.data || []));
  }, []);

  if (isLoading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" /></div>;
  const account = (data as any)?.data;
  if (!account) return <div className="text-[#7A7A7A] text-center py-8">Account not found</div>;

  const activeAssignments = account.assignments?.filter((a: any) => !a.unassignedAt) || [];
  const pastAssignments = account.assignments?.filter((a: any) => a.unassignedAt) || [];

  const statusBadge: Record<string, string> = {
    ACTIVE: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
    PAUSED: "bg-[#FFF3C4] text-[#1A1A1A]",
    ARCHIVED: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
  };

  async function handleAssign() {
    if (!selectedEmployee) return;
    setAssigning(true);
    try {
      await apiFetch(`/accounts/${id}/assign`, { method: "POST", body: JSON.stringify({ employeeId: selectedEmployee }) });
      setSelectedEmployee("");
      mutate();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setAssigning(false);
    }
  }

  async function handleUnassign(employeeId: string) {
    try {
      await apiFetch(`/accounts/${id}/assign/${employeeId}`, { method: "DELETE" });
      mutate();
    } catch (err: any) {
      alert(err.message);
    }
  }

  return (
    <div className="max-w-3xl space-y-6 crx-animate-fade">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">{account.displayName}</h1>
          <p className="text-[#7A7A7A] mt-1">{account.handle} on {account.platform?.name}</p>
          <div className="flex gap-2 mt-3">
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge[account.status] || "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>{account.status}</span>
            <span className="rounded-full px-3 py-1 text-xs font-medium bg-[#FFF3C4] text-[#1A1A1A]">{account.followerCount?.toLocaleString()} followers</span>
          </div>
        </div>
        <Button variant="outline" onClick={() => router.push("/accounts")} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">Back</Button>
      </div>

      {account.clientName && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-6 crx-animate-slide crx-delay-1">
          <span className="text-sm text-[#7A7A7A]">Client:</span>{" "}
          <span className="font-medium text-[#1A1A1A]">{account.clientName}</span>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-2">
        <div className="px-6 py-4 border-b border-[#F0EAD8]">
          <h3 className="text-base font-serif text-[#1A1A1A] font-medium">Active Assignments ({activeAssignments.length})</h3>
        </div>
        <div className="p-6 space-y-3">
          {activeAssignments.map((a: any) => (
            <div key={a.id} className="flex items-center justify-between border-b border-[#F0EAD8] pb-2 last:border-0">
              <div className="flex items-center gap-3">
                <div
                  className="h-7 w-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
                  style={{ background: "linear-gradient(135deg, #E8D5B7, #B8956A)" }}
                >
                  {a.employee?.name?.[0]?.toUpperCase()}
                </div>
                <div>
                  <span className="font-medium text-sm text-[#1A1A1A]">{a.employee?.name}</span>
                  <span className="text-xs text-[#B0B0B0] ml-2">since {new Date(a.assignedAt).toLocaleDateString()}</span>
                  {a.reason && <p className="text-xs text-[#7A7A7A]">{a.reason}</p>}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => handleUnassign(a.employee.id)} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">Remove</Button>
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <select
              className="flex-1 h-10 rounded-lg border border-[#E8E0D0] bg-white px-3 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
              value={selectedEmployee}
              onChange={(e) => setSelectedEmployee(e.target.value)}
            >
              <option value="">Select employee to assign</option>
              {employees
                .filter((emp: any) => !activeAssignments.some((a: any) => a.employee?.id === emp.id))
                .map((emp: any) => (
                  <option key={emp.id} value={emp.id}>{emp.name}</option>
                ))}
            </select>
            <Button onClick={handleAssign} disabled={!selectedEmployee || assigning} className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">
              {assigning ? "..." : "Assign"}
            </Button>
          </div>
        </div>
      </div>

      {pastAssignments.length > 0 && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-3">
          <div className="px-6 py-4 border-b border-[#F0EAD8]">
            <h3 className="text-base font-serif text-[#1A1A1A] font-medium">Assignment History</h3>
          </div>
          <div className="p-6">
            {pastAssignments.map((a: any) => (
              <div key={a.id} className="text-sm border-b border-[#F0EAD8] pb-2 mb-2 last:border-0">
                <span className="font-medium text-[#1A1A1A]">{a.employee?.name}</span>
                <span className="text-[#7A7A7A] ml-2">
                  {new Date(a.assignedAt).toLocaleDateString()} &mdash; {new Date(a.unassignedAt).toLocaleDateString()}
                </span>
                {a.assigner && <span className="text-xs text-[#B0B0B0] ml-2">by {a.assigner.name}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
