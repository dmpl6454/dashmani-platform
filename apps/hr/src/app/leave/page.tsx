"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR, { mutate } from "swr";
import Link from "next/link";
import {
  CalendarDays,
  Send,
  Clock,
  CheckCircle2,
  XCircle,
  Palmtree,
  Thermometer,
  Award,
  ArrowLeft,
} from "lucide-react";

interface LeaveBalance {
  casual: { total: number; used: number; balance: number };
  sick: { total: number; used: number; balance: number };
  earned: { total: number; used: number; balance: number };
}

interface LeaveRequest {
  id: string;
  startDate: string;
  endDate: string;
  type: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
}

const inputClass =
  "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";
const selectClass =
  "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";
const cardClass =
  "bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5";
const btnClass =
  "bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all";

const fetcher = (url: string) => apiFetch<any>(url).then((r) => r.data);

const statusColors: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800 border-yellow-300",
  APPROVED: "bg-green-100 text-green-800 border-green-300",
  REJECTED: "bg-red-100 text-red-800 border-red-300",
};

export default function LeavePage() {
  const { data: balance } = useSWR<LeaveBalance>("/hr/leave-balance", fetcher);
  const { data: requests } = useSWR<LeaveRequest[]>(
    "/hr/leave-requests",
    fetcher
  );

  const [form, setForm] = useState({
    type: "CASUAL",
    startDate: "",
    endDate: "",
    reason: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      await apiFetch("/hr/leave-requests", {
        method: "POST",
        body: JSON.stringify({
          startDate: form.startDate,
          endDate: form.endDate,
          type: form.type,
          reason: form.reason,
        }),
      });
      setSuccess("Leave request submitted successfully!");
      setForm({ type: "CASUAL", startDate: "", endDate: "", reason: "" });
      mutate("/hr/leave-requests");
      mutate("/hr/leave-balance");
    } catch (err: any) {
      setError(err.message || "Failed to submit leave request");
    } finally {
      setSubmitting(false);
    }
  }

  const balanceCards = [
    {
      label: "Casual Leave",
      icon: <Palmtree className="w-5 h-5 text-[#F5D547]" />,
      data: balance?.casual,
      color: "border-l-[#F5D547]",
    },
    {
      label: "Sick Leave",
      icon: <Thermometer className="w-5 h-5 text-red-400" />,
      data: balance?.sick,
      color: "border-l-red-400",
    },
    {
      label: "Earned Leave",
      icon: <Award className="w-5 h-5 text-blue-400" />,
      data: balance?.earned,
      color: "border-l-blue-400",
    },
  ];

  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10">
      <div className="flex items-center gap-4 mb-8">
        <Link href="/dashboard" className="h-10 w-10 rounded-xl bg-white border border-[#E8E0D0] flex items-center justify-center hover:bg-[#FFF3C4] transition-colors">
          <ArrowLeft className="h-5 w-5 text-[#1A1A1A]" />
        </Link>
        <h1 className="text-4xl font-light text-[#1A1A1A] font-serif">Leave Requests</h1>
      </div>

      {/* Leave Balance Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
        {balanceCards.map((card) => (
          <div
            key={card.label}
            className={`${cardClass} border-l-4 ${card.color}`}
          >
            <div className="flex items-center gap-3 mb-4">
              {card.icon}
              <span className="font-semibold text-[#1A1A1A] text-sm">
                {card.label}
              </span>
            </div>
            {card.data ? (
              <div className="flex items-end gap-4">
                <div>
                  <p className="text-3xl font-light text-[#1A1A1A] font-serif">
                    {card.data.balance}
                  </p>
                  <p className="text-xs text-[#B0B0B0] mt-1">Available</p>
                </div>
                <div className="flex gap-3 text-xs text-[#B0B0B0] mb-1">
                  <span>Total: {card.data.total}</span>
                  <span>Used: {card.data.used}</span>
                </div>
              </div>
            ) : (
              <div className="h-10 bg-[#F5F3EF] rounded animate-pulse" />
            )}
          </div>
        ))}
      </div>

      {/* Request Leave Form */}
      <div className={`${cardClass} mb-10`}>
        <h2 className="text-lg font-semibold text-[#1A1A1A] mb-5 flex items-center gap-2">
          <Send className="w-4 h-4 text-[#F5D547]" />
          Request Leave
        </h2>

        {success && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            {success}
          </div>
        )}
        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-center gap-2">
            <XCircle className="w-4 h-4" />
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#1A1A1A] mb-1.5">
                Leave Type
              </label>
              <select
                className={selectClass}
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value })}
              >
                <option value="CASUAL">Casual</option>
                <option value="SICK">Sick</option>
                <option value="EARNED">Earned</option>
                <option value="UNPAID">Unpaid</option>
                <option value="WFH">Work from Home</option>
                <option value="COMP_OFF">Comp Off</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-[#1A1A1A] mb-1.5">
                Start Date
              </label>
              <input
                type="date"
                className={inputClass}
                value={form.startDate}
                onChange={(e) =>
                  setForm({ ...form, startDate: e.target.value })
                }
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#1A1A1A] mb-1.5">
                End Date
              </label>
              <input
                type="date"
                className={inputClass}
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#1A1A1A] mb-1.5">
              Reason
            </label>
            <textarea
              className={`${inputClass} min-h-[80px] resize-none`}
              placeholder="Describe the reason for your leave..."
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              required
            />
          </div>
          <div className="pt-2">
            <button type="submit" className={btnClass} disabled={submitting}>
              {submitting ? "Submitting..." : "Submit Request"}
            </button>
          </div>
        </form>
      </div>

      {/* Leave Requests List */}
      <div className={cardClass}>
        <h2 className="text-lg font-semibold text-[#1A1A1A] mb-5 flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-[#F5D547]" />
          Your Leave Requests
        </h2>

        {!requests ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-16 bg-[#F5F3EF] rounded-lg animate-pulse"
              />
            ))}
          </div>
        ) : requests.length === 0 ? (
          <div className="text-center py-10 text-[#B0B0B0]">
            <Clock className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No leave requests found</p>
          </div>
        ) : (
          <div className="space-y-3">
            {requests.map((req) => (
              <div
                key={req.id}
                className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-4 rounded-xl border border-[#E8E0D0] bg-[#FEFCF7]"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-[#1A1A1A]">
                      {req.type}
                    </span>
                    <span className="text-xs text-[#B0B0B0]">
                      {new Date(req.startDate).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}{" "}
                      &ndash;{" "}
                      {new Date(req.endDate).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>
                  </div>
                  <p className="text-sm text-[#666]">{req.reason}</p>
                </div>
                <span
                  className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border ${statusColors[req.status] || ""}`}
                >
                  {req.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
