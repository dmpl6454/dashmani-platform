"use client";
import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { Check, X, Clock, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { BoxesLoader } from "@/components/boxes-loader";

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
        <BoxesLoader />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto pb-8 crx-animate-fade">
      <section className="pt-[22px] pb-[22px]">
        <Link href="/employees" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ds-t2 hover:text-ds-gold transition-colors">
          <ArrowLeft className="h-[13px] w-[13px]" strokeWidth={2} /> Employees
        </Link>
        <div className="mt-4">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Pending Approvals</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">
            {employees.length} employee{employees.length !== 1 ? "s" : ""} waiting for approval
          </p>
        </div>
      </section>

      {employees.length === 0 ? (
        <div className="py-14 px-5 text-center rounded-[16px] border border-dashed border-ds-line2 crx-animate-slide crx-delay-1">
          <Clock className="h-10 w-10 text-ds-t4 mx-auto mb-3" strokeWidth={1.6} />
          <p className="text-[13px] text-ds-t3">No pending employee registrations</p>
        </div>
      ) : (
        <div className="space-y-3">
          {employees.map((emp, i) => (
            <div
              key={emp.id}
              className={`rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.35)] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-colors hover:border-ds-line4 crx-animate-slide crx-delay-${Math.min(i + 1, 6)}`}
            >
              <div className="flex items-center gap-4 flex-1">
                <div
                  className="h-10 w-10 rounded-full border border-ds-line2 bg-[rgba(233,189,98,.1)] text-ds-gold flex items-center justify-center text-[13px] font-bold shrink-0"
                >
                  {emp.name?.[0]?.toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-[14.5px] font-semibold text-ds-text truncate">{emp.name}</p>
                  <p className="text-[12.5px] text-ds-t2 truncate">{emp.email}</p>
                  {emp.phone && <p className="text-[12.5px] text-ds-t3">{emp.phone}</p>}
                  <p className="text-[11px] text-ds-t3 mt-1">
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
                  className="inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-full bg-ds-teal text-[color:var(--hx-04130D)] text-[12px] font-bold whitespace-nowrap shrink-0 hover:bg-[color:var(--hx-33E2B5)] disabled:opacity-50 transition-colors"
                >
                  <Check className="h-3.5 w-3.5" strokeWidth={2.4} />
                  Approve
                </button>
                <button
                  onClick={() => handleReject(emp.id)}
                  disabled={actionLoading === emp.id}
                  className="inline-flex items-center justify-center gap-1.5 h-9 px-3.5 rounded-full border border-[rgba(229,72,77,.4)] text-[color:var(--hx-FB7185)] text-[12px] font-bold whitespace-nowrap shrink-0 hover:bg-[rgba(229,72,77,.1)] disabled:opacity-50 transition-colors"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2.4} />
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
