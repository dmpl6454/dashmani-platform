"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR, { mutate } from "swr";
import { Gift, Check, X } from "lucide-react";
import { Topstrip } from "@/components/portal-shell";

const fetcher = (url: string) => apiFetch<any>(url).then(r => r.data);
const statusCfg: Record<string, string> = {
  PENDING:  "bg-attention-bg text-attention border-attention/20",
  APPROVED: "bg-success-bg text-success border-success/20",
  REJECTED: "bg-danger-bg text-danger border-danger/20",
};
const fieldCls = "w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none";

export default function CompOffPage() {
  const { data: requests } = useSWR("/hr/leave-requests", fetcher);
  const compOffRequests = (requests || []).filter((r: any) => r.type === "COMP_OFF");

  const [form, setForm] = useState({ startDate: "", endDate: "", reason: "" });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(""); const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setSubmitting(true); setError(""); setSuccess("");
    try {
      await apiFetch("/hr/leave-requests", { method: "POST", body: JSON.stringify({ startDate: form.startDate, endDate: form.endDate || form.startDate, type: "COMP_OFF", reason: form.reason }) });
      setSuccess("Comp off request submitted!"); setForm({ startDate: "", endDate: "", reason: "" }); mutate("/hr/leave-requests");
    } catch (err: any) { setError(err.message || "Failed to submit"); }
    finally { setSubmitting(false); }
  }

  return (
    <>
      <Topstrip title="Comp Off" sub="Compensatory leave requests" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[800px]">
        <div className="space-y-4 anim-fade-up d1">

          <div className="v3-card p-5">
            <h3 className="text-[14px] font-bold text-ink mb-4 flex items-center gap-2"><Gift size={15} className="text-indigo" /> Request Comp Off</h3>
            {success && <div className="v3-card-sm border border-success/20 bg-success-bg p-3 flex items-center gap-2 mb-3"><Check size={14} strokeWidth={2.5} className="text-success shrink-0" /><p className="text-[12.5px] font-semibold text-success">{success}</p></div>}
            {error && <div className="v3-card-sm border border-danger/20 bg-danger-bg p-3 flex items-center gap-2 mb-3"><X size={14} strokeWidth={2.5} className="text-danger shrink-0" /><p className="text-[12.5px] font-semibold text-danger">{error}</p></div>}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Comp Off Date *</label><input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} required className={fieldCls} /></div>
                <div><label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">End Date</label><input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} className={fieldCls} /></div>
              </div>
              <div><label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Reason *</label>
                <textarea value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} required rows={2}
                  className="w-full px-3 py-2.5 text-[13.5px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none resize-none placeholder:text-ink-4"
                  placeholder="Mention the date you worked extra (e.g. Worked Sunday for project launch)" />
              </div>
              <button type="submit" disabled={submitting} className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink disabled:opacity-50">
                {submitting ? "Submitting…" : "Submit Request"}
              </button>
            </form>
          </div>

          <div className="v3-card overflow-hidden">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}><h3 className="text-[14px] font-bold text-ink">Comp Off History</h3></div>
            {compOffRequests.length === 0 ? (
              <div className="px-5 py-10 text-center"><Gift size={24} className="mx-auto mb-3 text-ink-4" /><p className="text-[13px] text-ink-3 font-medium">No comp off requests yet</p></div>
            ) : (
              <ul>{compOffRequests.map((r: any, i: number) => {
                const sc = statusCfg[r.status] || statusCfg.PENDING;
                const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
                return (
                  <li key={r.id} style={i < compOffRequests.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}}>
                    <div className="px-5 py-3.5 flex items-center gap-4 v3-row flex-wrap">
                      <div className="h-9 w-9 rounded-xl bg-muted grid place-items-center shrink-0"><Gift size={16} strokeWidth={2} className="text-ink-3" /></div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13.5px] font-semibold text-ink">{fmtDate(r.startDate)}{r.startDate !== r.endDate ? ` → ${fmtDate(r.endDate)}` : ""}</p>
                        <p className="text-[11.5px] text-ink-3 mt-0.5">"{r.reason}"</p>
                      </div>
                      <span className={`inline-flex h-6 px-2.5 rounded-full text-[11px] font-semibold items-center border shrink-0 ${sc}`}>{r.status}</span>
                    </div>
                  </li>
                );
              })}</ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
