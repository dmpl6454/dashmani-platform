"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { CalendarCheck, CheckCircle2, Clock, Send } from "lucide-react";

export default function JoiningDatePage() {
  const { data, mutate, isLoading } = useSWR("/hr/joining-date", (url: string) => apiFetch<any>(url));
  const profile = data?.data;
  const currentDate = profile?.joiningDate ? new Date(profile.joiningDate).toISOString().slice(0, 10) : "";
  const approved = profile?.joiningDateApproved ?? false;

  const [date, setDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  // Sync fetched date to input
  const displayDate = date || currentDate;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!displayDate) return;
    setSubmitting(true);
    setSuccess(false);
    try {
      await apiFetch("/hr/joining-date", {
        method: "POST",
        body: JSON.stringify({ joiningDate: displayDate }),
      });
      mutate();
      setSuccess(true);
      setTimeout(() => setSuccess(false), 4000);
    } catch (err: any) {
      alert(err.message || "Failed to submit");
    }
    setSubmitting(false);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" />
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto space-y-6 crx-animate-fade">
      <div>
        <h1 className="font-serif text-3xl font-light text-[#1A1A1A]">Joining Date</h1>
        <p className="text-sm text-[#7A7A7A] mt-1">Submit or update your date of joining</p>
      </div>

      {/* Status Card */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-6">
        <div className="flex items-center gap-4 mb-5">
          <div className="h-12 w-12 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
            <CalendarCheck className="h-6 w-6 text-[#1A1A1A]" />
          </div>
          <div>
            <p className="text-sm text-[#7A7A7A]">Current Status</p>
            {currentDate ? (
              <div className="flex items-center gap-2">
                <p className="text-lg font-semibold text-[#1A1A1A]">
                  {new Date(currentDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
                </p>
                {approved ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                    <CheckCircle2 className="h-3 w-3" /> Approved
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-50 text-yellow-700 border border-yellow-200">
                    <Clock className="h-3 w-3" /> Pending Approval
                  </span>
                )}
              </div>
            ) : (
              <p className="text-lg text-[#B0B0B0]">Not submitted yet</p>
            )}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1.5">
              {currentDate ? "Update Joining Date" : "Select Joining Date"}
            </label>
            <input
              type="date"
              value={displayDate}
              onChange={(e) => setDate(e.target.value)}
              required
              className="w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={submitting || !displayDate}
            className="w-full flex items-center justify-center gap-2 bg-[#F5D547] text-[#1A1A1A] rounded-xl px-5 py-3 text-sm font-semibold shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_6px_24px_rgba(245,213,71,0.45)] hover:-translate-y-0.5 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
          >
            {submitting ? (
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-[#1A1A1A]" />
            ) : (
              <>
                <Send className="h-4 w-4" />
                {currentDate ? "Update Joining Date" : "Submit Joining Date"}
              </>
            )}
          </button>

          {success && (
            <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-lg px-4 py-2.5 text-sm">
              <CheckCircle2 className="h-4 w-4" />
              {currentDate && !approved ? "Joining date updated. Pending admin approval." : "Joining date submitted successfully!"}
            </div>
          )}
        </form>
      </div>

      <p className="text-xs text-[#B0B0B0] text-center">
        Your joining date will be reviewed and approved by the admin team.
      </p>
    </div>
  );
}
