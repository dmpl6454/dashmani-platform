"use client";
import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAccount } from "@/lib/hooks/use-accounts";
import { Button } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";
import { Pencil, Trash2, Search } from "lucide-react";

export default function AccountDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { data, isLoading, mutate } = useAccount(id as string);
  const [employees, setEmployees] = useState<any[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [empSearch, setEmpSearch] = useState("");
  const [empOpen, setEmpOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    apiFetch("/employees?status=ACTIVE&limit=500").then((res: any) => {
      const list = (res.data || []).slice().sort((a: any, b: any) =>
        (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
      );
      setEmployees(list);
    });
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

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiFetch(`/accounts/${id}`, { method: "DELETE" });
      router.push("/accounts");
    } catch (err: any) {
      alert(err.message || "Failed to delete account");
      setDeleting(false);
      setShowDeleteConfirm(false);
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
        <div className="flex items-center gap-2">
          <button
            onClick={() => router.push(`/accounts/${id}/edit`)}
            className="flex items-center gap-1.5 border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[#F0EEFF] hover:border-[#5B4BF5]/30 hover:text-[#5B4BF5] px-4 py-2 text-sm font-medium transition-colors"
          >
            <Pencil className="h-4 w-4" /> Edit
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="flex items-center gap-1.5 border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-red-50 hover:border-red-200 hover:text-red-600 px-4 py-2 text-sm font-medium transition-colors"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
          <Button variant="outline" onClick={() => router.push("/accounts")} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">Back</Button>
        </div>
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
                  style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
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
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#B0B0B0] pointer-events-none" />
              <input
                type="text"
                value={empOpen ? empSearch : (employees.find((e: any) => e.id === selectedEmployee)?.name || empSearch)}
                onChange={(e) => { setEmpSearch(e.target.value); setEmpOpen(true); if (selectedEmployee) setSelectedEmployee(""); }}
                onFocus={() => { setEmpOpen(true); setEmpSearch(""); }}
                onBlur={() => setTimeout(() => setEmpOpen(false), 150)}
                placeholder={`Search ${employees.length} employees…`}
                className="w-full h-10 rounded-lg border border-[#E8E0D0] bg-white pl-9 pr-3 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
                autoComplete="off"
              />
              {empOpen && (() => {
                const available = employees.filter((emp: any) => !activeAssignments.some((a: any) => a.employee?.id === emp.id));
                const q = empSearch.trim().toLowerCase();
                const filtered = q ? available.filter((e: any) => (e.name || "").toLowerCase().includes(q) || (e.email || "").toLowerCase().includes(q)) : available;
                return (
                  <div className="absolute z-10 mt-1 w-full max-h-60 overflow-y-auto bg-white border border-[#E8E0D0] rounded-lg shadow-lg">
                    {filtered.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-[#7A7A7A]">{q ? `No employees match "${empSearch}"` : "All employees are already assigned"}</div>
                    ) : (
                      filtered.map((e: any) => (
                        <button
                          key={e.id}
                          type="button"
                          onMouseDown={(ev) => { ev.preventDefault(); setSelectedEmployee(e.id); setEmpSearch(""); setEmpOpen(false); }}
                          className={`w-full text-left px-4 py-2 text-sm hover:bg-[rgba(255,248,225,0.5)] transition-colors flex items-center justify-between ${selectedEmployee === e.id ? "bg-[#FFF3C4]" : ""}`}
                        >
                          <span className="text-[#1A1A1A]">{e.name}</span>
                          {e.email && <span className="text-xs text-[#B0B0B0] ml-2 truncate">{e.email}</span>}
                        </button>
                      ))
                    )}
                  </div>
                );
              })()}
            </div>
            <Button onClick={handleAssign} disabled={!selectedEmployee || assigning} className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">
              {assigning ? "..." : "Assign"}
            </Button>
          </div>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => !deleting && setShowDeleteConfirm(false)}>
          <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_8px_40px_rgba(0,0,0,0.12)] w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5">
              <div className="flex items-start gap-4">
                <div className="h-10 w-10 rounded-xl bg-red-50 flex items-center justify-center shrink-0">
                  <Trash2 className="h-5 w-5 text-red-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-medium text-[#1A1A1A]">Delete account?</h3>
                  <p className="text-sm text-[#7A7A7A] mt-1">
                    This will permanently delete <strong>{account.displayName}</strong> ({account.handle}). If the account has tasks, posts, or report links, you'll need to archive it instead.
                  </p>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-[#F0EAD8] flex items-center justify-end gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="px-4 py-2 text-sm text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 bg-red-600 text-white rounded-full text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

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
