"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR, { mutate } from "swr";
import { Home, Check, X } from "lucide-react";
import { Topstrip } from "@/components/portal-shell";

const fetcher = (url: string) => apiFetch<any>(url).then(r => r.data);
const statusCfg: Record<string, string> = {
  PENDING:  "bg-attention-bg text-attention border-attention/20",
  APPROVED: "bg-success-bg text-success border-success/20",
  REJECTED: "bg-danger-bg text-danger border-danger/20",
};
const fieldCls = "w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none";

export default function WfhPage() {
  const { data: requests } = useSWR("/hr/leave-requests?type=WFH", fetcher);
  const wfhRequests = requests || [];

  const [form, setForm] = useState({ startDate: "", endDate: "", reason: "" });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(""); const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setSubmitting(true); setError(""); setSuccess("");
    try {
      await apiFetch("/hr/leave-requests", { method: "POST", body: JSON.stringify({ startDate: form.startDate, endDate: form.endDate || form.startDate, type: "WFH", reason: form.reason }) });
      setSuccess("WFH request submitted!"); setForm({ startDate: "", endDate: "", reason: "" }); mutate("/hr/leave-requests?type=WFH");
    } catch (err: any) { setError(err.message || "Failed to submit"); }
    finally { setSubmitting(false); }
  }

  return (
    <>
      <Topstrip title="Work from Home" sub="Request remote working days" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[800px]">
        <div className="space-y-4 anim-fade-up d1">

          <div className="v3-card p-5">
            <h3 className="text-[14px] font-bold text-ink mb-4 flex items-center gap-2"><Home size={15} className="text-indigo" /> Request WFH Day</h3>
            {success && <div className="v3-card-sm border border-success/20 bg-success-bg p-3 flex items-center gap-2 mb-3"><Check size={14} strokeWidth={2.5} className="text-success shrink-0" /><p className="text-[12.5px] font-semibold text-success">{success}</p></div>}
            {error && <div className="v3-card-sm border border-danger/20 bg-danger-bg p-3 flex items-center gap-2 mb-3"><X size={14} strokeWidth={2.5} className="text-danger shrink-0" /><p className="text-[12.5px] font-semibold text-danger">{error}</p></div>}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Start Date *</label><input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} required className={fieldCls} /></div>
                <div><label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">End Date</label><input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} className={fieldCls} /></div>
              </div>
              <div><label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Reason *</label>
                <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} required placeholder="Why are you working from home?" className={fieldCls} />
              </div>
              <button type="submit" disabled={submitting} className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink disabled:opacity-50">
                {submitting ? "Submitting…" : "Submit WFH Request"}
              </button>
            </form>
          </div>

          <div className="v3-card overflow-hidden">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}><h3 className="text-[14px] font-bold text-ink">WFH History</h3></div>
            {wfhRequests.length === 0 ? (
              <div className="px-5 py-10 text-center"><Home size={24} className="mx-auto mb-3 text-ink-4" /><p className="text-[13px] text-ink-3 font-medium">No WFH requests yet</p></div>
            ) : (
              <ul>{wfhRequests.map((r: any, i: number) => {
                const sc = statusCfg[r.status] || statusCfg.PENDING;
                const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
                return (
                  <li key={r.id} style={i < wfhRequests.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}}>
                    <div className="px-5 py-3.5 flex items-center gap-4 v3-row flex-wrap">
                      <div className="h-9 w-9 rounded-xl bg-muted grid place-items-center shrink-0"><Home size={16} strokeWidth={2} className="text-ink-3" /></div>
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
