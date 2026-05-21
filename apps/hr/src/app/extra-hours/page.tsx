"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Timer, Plus, ChevronDown } from "lucide-react";
import { Topstrip } from "@/components/portal-shell";

const fieldCls = "w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none";
const statusCfg: Record<string, string> = {
  PENDING:  "bg-attention-bg text-attention border-attention/20",
  APPROVED: "bg-success-bg text-success border-success/20",
};

export default function ExtraHoursPage() {
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ date: "", hours: "", description: "" });

  const { data, mutate } = useSWR("/hr/extra-hours", apiFetch);
  const hours = (data as any)?.data ?? [];
  const totalApproved = hours.filter((h: any) => h.status === "APPROVED").reduce((s: number, h: any) => s + h.hours, 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setSubmitting(true);
    try {
      await apiFetch("/hr/extra-hours", { method: "POST", body: JSON.stringify({ date: form.date, hours: Number(form.hours), description: form.description }) });
      setForm({ date: "", hours: "", description: "" }); setShowForm(false); mutate();
    } catch (err: any) { alert(err.message); }
    finally { setSubmitting(false); }
  }

  return (
    <>
      <Topstrip title="Extra Hours" sub={`${totalApproved}h approved this quarter`} right={
        <button onClick={() => setShowForm(v => !v)}
          className="btn-3d inline-flex items-center gap-2 px-4 h-9 rounded-xl bg-ink text-white text-[12.5px] font-semibold border-2 border-ink">
          {showForm ? <ChevronDown size={14} className="rotate-180" /> : <Plus size={14} />}
          {showForm ? "Close" : "Log Hours"}
        </button>
      } />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[800px]">
        <div className="space-y-4 anim-fade-up d1">

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Approved Hours", value: `${totalApproved}h`, color: "text-success" },
              { label: "Pending",         value: hours.filter((h: any) => h.status === "PENDING").length, color: "text-attention" },
              { label: "Total Entries",   value: hours.length, color: "text-ink" },
            ].map(s => (
              <div key={s.label} className="v3-card p-4 text-center">
                <div className={`font-display text-[26px] font-semibold ${s.color}`}>{s.value}</div>
                <div className="text-[11.5px] text-ink-3 font-medium mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>

          {/* Log form */}
          {showForm && (
            <div className="v3-card p-5 anim-fade-up d1">
              <h3 className="text-[14px] font-bold text-ink mb-4">Log Extra Hours</h3>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div><label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Date</label><input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required className={fieldCls} /></div>
                  <div><label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Hours</label><input type="number" step="0.5" min="0.5" max="12" value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} required placeholder="e.g. 2.5" className={fieldCls} /></div>
                </div>
                <div><label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Reason</label>
                  <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} required placeholder="What did you work on?" className={fieldCls} />
                </div>
                <button type="submit" disabled={submitting} className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink disabled:opacity-50">
                  {submitting ? "Submitting…" : "Submit"}
                </button>
              </form>
            </div>
          )}

          {/* History */}
          <div className="v3-card overflow-hidden">
            <div className="px-5 h-12 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <h3 className="text-[14px] font-bold text-ink">History</h3>
              <span className="text-[12px] font-bold text-success">{totalApproved}h approved</span>
            </div>
            {hours.length === 0 ? (
              <div className="px-5 py-10 text-center"><Timer size={24} className="mx-auto mb-3 text-ink-4" /><p className="text-[13px] text-ink-3 font-medium">No extra hours logged yet</p></div>
            ) : (
              <ul>{hours.map((h: any, i: number) => {
                const sc = statusCfg[h.status] || statusCfg.PENDING;
                return (
                  <li key={h.id} style={i < hours.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}}>
                    <div className="px-5 py-3.5 flex items-center gap-4 v3-row">
                      <div className="h-9 w-9 rounded-xl bg-muted grid place-items-center font-bold text-[13px] text-ink-2 shrink-0">{h.hours}h</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-ink">{h.description || "—"}</p>
                        <p className="text-[11.5px] text-ink-3 mt-0.5">{new Date(h.date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</p>
                      </div>
                      <span className={`h-6 px-2.5 rounded-full text-[11px] font-semibold inline-flex items-center border shrink-0 ${sc}`}>{h.status}</span>
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
