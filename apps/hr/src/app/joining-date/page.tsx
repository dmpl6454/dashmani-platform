"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { CalendarCheck, Check, Clock, Send } from "lucide-react";
import { Topstrip } from "@/components/portal-shell";

export default function JoiningDatePage() {
  const { data, mutate, isLoading } = useSWR("/hr/joining-date", (url: string) => apiFetch<any>(url));
  const profile = data?.data;
  const currentDate = profile?.joiningDate ? new Date(profile.joiningDate).toISOString().slice(0, 10) : "";
  const approved = profile?.joiningDateApproved ?? false;

  const [date, setDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);

  const displayDate = date || currentDate;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!displayDate) return;
    setSubmitting(true); setSuccess(false);
    try {
      await apiFetch("/hr/joining-date", { method: "POST", body: JSON.stringify({ joiningDate: displayDate }) });
      mutate(); setSuccess(true); setTimeout(() => setSuccess(false), 4000);
    } catch (err: any) { alert(err.message || "Failed to submit"); }
    setSubmitting(false);
  }

  if (isLoading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo" /></div>;

  return (
    <>
      <Topstrip title="Joining Date" sub="Submit or update your date of joining" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[600px]">
        <div className="space-y-4 anim-fade-up d1">

          <div className="v3-card p-6">
            <div className="flex items-center gap-4 mb-5">
              <div className="h-12 w-12 rounded-xl bg-indigo-soft grid place-items-center">
                <CalendarCheck size={22} className="text-indigo" />
              </div>
              <div>
                <p className="text-[12px] text-ink-3 font-medium">Current Status</p>
                {currentDate ? (
                  <div className="flex items-center gap-2 mt-0.5">
                    <p className="text-[15px] font-bold text-ink">
                      {new Date(currentDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
                    </p>
                    {approved
                      ? <span className="inline-flex h-6 px-2.5 rounded-full text-[11px] font-semibold items-center border bg-success-bg text-success border-success/20"><Check size={10} strokeWidth={2.5} className="mr-1" />Approved</span>
                      : <span className="inline-flex h-6 px-2.5 rounded-full text-[11px] font-semibold items-center border bg-attention-bg text-attention border-attention/20"><Clock size={10} className="mr-1" />Pending Approval</span>
                    }
                  </div>
                ) : (
                  <p className="text-[14px] text-ink-4 mt-0.5">Not submitted yet</p>
                )}
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">
                  {currentDate ? "Update Joining Date" : "Select Joining Date"}
                </label>
                <input type="date" value={displayDate} onChange={e => setDate(e.target.value)} required
                  className="w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none" />
              </div>
              <button type="submit" disabled={submitting || !displayDate}
                className="btn-3d w-full inline-flex items-center justify-center gap-2 h-11 rounded-xl bg-ink text-white text-[13.5px] font-semibold border-2 border-ink disabled:opacity-50">
                {submitting ? <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" /> : <><Send size={15} />{currentDate ? "Update Joining Date" : "Submit Joining Date"}</>}
              </button>
              {success && (
                <div className="v3-card-sm border border-success/20 bg-success-bg p-3 flex items-center gap-2 text-[12.5px] text-success font-semibold">
                  <Check size={13} strokeWidth={2.5} />
                  {currentDate && !approved ? "Joining date updated. Pending admin approval." : "Joining date submitted!"}
                </div>
              )}
            </form>
          </div>

          <p className="text-[11.5px] text-ink-4 font-medium text-center">
            Your joining date will be reviewed and approved by the admin team.
          </p>
        </div>
      </div>
    </>
  );
}
