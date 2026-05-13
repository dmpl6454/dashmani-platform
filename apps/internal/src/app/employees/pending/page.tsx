"use client";
import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { Check, X, Clock, ArrowLeft } from "lucide-react";
import Link from "next/link";

interface PendingEmployee {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  status: string;
  createdAt: string;
  profile?: { designation?: string | null } | null;
}

export default function PendingEmployeesPage() {
  const [employees, setEmployees] = useState<PendingEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadPending = useCallback(async () => {
    try {
      const res: any = await apiFetch("/admin/employees/pending");
      setEmployees(res.data || []);
    } catch (err) {
      console.error("Failed to load pending employees:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPending();
  }, [loadPending]);

  async function handleApprove(userId: string) {
    setActionLoading(userId);
    try {
      await apiFetch(`/admin/employees/${userId}/approve`, { method: "PUT" });
      setEmployees((prev) => prev.filter((e) => e.id !== userId));
    } catch (err: any) {
      alert(`Failed to approve: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReject(userId: string) {
    if (!confirm("Are you sure you want to reject this employee?")) return;
    setActionLoading(userId);
    try {
      await apiFetch(`/admin/employees/${userId}/reject`, { method: "PUT" });
      setEmployees((prev) => prev.filter((e) => e.id !== userId));
    } catch (err: any) {
      alert(`Failed to reject: ${err.message}`);
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 crx-animate-fade">
      <div className="flex items-center gap-3">
        <Link href="/employees" className="text-[#B0B0B0] hover:text-[#1A1A1A] transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Pending Approvals</h1>
          <p className="text-[#7A7A7A] mt-1">
            {employees.length} employee{employees.length !== 1 ? "s" : ""} waiting for approval
          </p>
        </div>
      </div>

      {employees.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-12 text-center crx-animate-slide crx-delay-1">
          <Clock className="h-12 w-12 text-[#B0B0B0] mx-auto mb-3" />
          <p className="text-[#7A7A7A]">No pending employee registrations</p>
        </div>
      ) : (
        <div className="space-y-3">
          {employees.map((emp, i) => (
            <div
              key={emp.id}
              className={`bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-5 flex items-center justify-between transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-${Math.min(i + 1, 6)}`}
            >
              <div className="flex items-center gap-4 flex-1">
                <div
                  className="h-10 w-10 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0"
                  style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
                >
                  {emp.name?.[0]?.toUpperCase()}
                </div>
                <div>
                  <p className="font-medium text-[#1A1A1A]">{emp.name}</p>
                  <p className="text-sm text-[#7A7A7A]">{emp.email}</p>
                  {emp.phone && <p className="text-sm text-[#B0B0B0]">{emp.phone}</p>}
                  <p className="text-xs text-[#B0B0B0] mt-1">
                    Registered: {new Date(emp.createdAt).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleApprove(emp.id)}
                  disabled={actionLoading === emp.id}
                  className="flex items-center gap-1.5 bg-[#6BCB77] text-white px-4 py-2 rounded-full text-sm font-medium hover:bg-[#5ab868] disabled:opacity-50 transition-colors"
                >
                  <Check className="h-4 w-4" />
                  Approve
                </button>
                <button
                  onClick={() => handleReject(emp.id)}
                  disabled={actionLoading === emp.id}
                  className="flex items-center gap-1.5 bg-[rgba(231,76,60,0.1)] text-[#E74C3C] px-4 py-2 rounded-full text-sm font-medium hover:bg-[rgba(231,76,60,0.18)] disabled:opacity-50 transition-colors"
                >
                  <X className="h-4 w-4" />
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
