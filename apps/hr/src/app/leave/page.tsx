"use client";
import { useState, useRef } from "react";
import { apiFetch, apiUpload } from "@/lib/api";
import useSWR, { mutate } from "swr";
import { Check, X, Calendar, Paperclip } from "lucide-react";
import { Topstrip } from "@/components/portal-shell";

interface LeaveBalance { casual: { total: number; used: number; balance: number }; sick: { total: number; used: number; balance: number }; earned: { total: number; used: number; balance: number }; }
interface LeaveRequest { id: string; startDate: string; endDate: string; type: string; reason: string; status: "PENDING" | "APPROVED" | "REJECTED"; createdAt: string; attachmentUrl?: string; attachmentName?: string; }

const fetcher = (url: string) => apiFetch<any>(url).then(r => r.data);

const statusCfg: Record<string, string> = {
  PENDING:  "bg-attention-bg text-attention border-attention/20",
  APPROVED: "bg-success-bg text-success border-success/20",
  REJECTED: "bg-danger-bg text-danger border-danger/20",
};

const fieldCls = "w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none";
const selectCls = fieldCls + " appearance-none pr-8";

export default function LeavePage() {
  const { data: balance } = useSWR<LeaveBalance>("/hr/leave-balance", fetcher);
  const { data: requests } = useSWR<LeaveRequest[]>("/hr/leave-requests", fetcher);

  const [form, setForm] = useState({ type: "CASUAL", startDate: "", endDate: "", reason: "" });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  // Attachment state (SICK leave)
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
  const [uploadedAttachment, setUploadedAttachment] = useState<{ url: string; name: string; mime: string; size: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const isSick = form.type === "SICK";

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachmentFile(file);
    setUploading(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("attachment", file);
      const res = await apiUpload<any>("/hr/leave/upload-attachment", fd);
      setUploadedAttachment(res?.data ?? res);
    } catch (err: any) {
      setError(err.message || "File upload failed");
      setAttachmentFile(null);
    } finally {
      setUploading(false);
    }
  }

  function clearAttachment() {
    setAttachmentFile(null);
    setUploadedAttachment(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setSuccess("");

    // Require attachment for SICK leave
    if (isSick && !uploadedAttachment) {
      setError("Please upload a medical certificate for sick leave.");
      return;
    }

    setSubmitting(true);
    try {
      const body: any = {
        startDate: form.startDate,
        endDate: form.endDate,
        type: form.type,
        reason: form.reason,
      };
      if (uploadedAttachment) {
        body.attachmentUrl = uploadedAttachment.url;
        body.attachmentName = uploadedAttachment.name;
        body.attachmentMime = uploadedAttachment.mime;
        body.attachmentSize = uploadedAttachment.size;
      }
      await apiFetch("/hr/leave-requests", { method: "POST", body: JSON.stringify(body) });
      setSuccess("Leave request submitted!");
      setForm({ type: "CASUAL", startDate: "", endDate: "", reason: "" });
      clearAttachment();
      mutate("/hr/leave-requests");
      mutate("/hr/leave-balance");
    } catch (err: any) {
      setError(err.message || "Failed to submit");
    } finally {
      setSubmitting(false); }
  }

  const balanceCards = [
    { label: "Casual Leave",  data: balance?.casual,  color: "text-indigo",    bg: "bg-indigo-soft" },
    { label: "Sick Leave",    data: balance?.sick,    color: "text-danger",    bg: "bg-danger-bg"   },
    { label: "Earned Leave",  data: balance?.earned,  color: "text-success",   bg: "bg-success-bg"  },
  ];

  return (
    <>
      <Topstrip title="Leave Request" sub="Manage your time off" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px]">
        <div className="space-y-5 anim-fade-up d1">

          {/* Balance cards */}
          <div className="grid grid-cols-3 gap-4">
            {balanceCards.map(c => (
              <div key={c.label} className="v3-card p-5">
                <div className={`h-9 w-9 rounded-xl grid place-items-center mb-3 ${c.bg} ${c.color}`}>
                  <Calendar size={16} strokeWidth={2} />
                </div>
                {c.data ? (
                  <>
                    <div className={`font-num text-[32px] font-semibold leading-none ${c.color}`}>{c.data.balance}</div>
                    <div className="text-[12.5px] font-semibold text-ink mt-1">{c.label}</div>
                    <div className="flex gap-3 mt-1 text-[11px] text-ink-3 font-medium">
                      <span>Total: {c.data.total}</span><span>Used: {c.data.used}</span>
                    </div>
                    <div className="mt-2.5 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-current" style={{ width: `${(c.data.balance / c.data.total) * 100}%`, color: "inherit" }} />
                    </div>
                  </>
                ) : <div className="h-10 bg-muted rounded-lg animate-pulse" />}
              </div>
            ))}
          </div>

          {/* Request form */}
          <div className="v3-card overflow-hidden">
            <div className="px-5 h-12 flex items-center gap-2" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <Calendar size={15} strokeWidth={2} className="text-indigo" />
              <h3 className="text-[14px] font-bold text-ink">Request Leave</h3>
            </div>
            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              {success && (
                <div className="v3-card-sm border border-success/20 bg-success-bg p-3 flex items-center gap-2">
                  <Check size={14} strokeWidth={2.5} className="text-success shrink-0" />
                  <p className="text-[12.5px] font-semibold text-success">{success}</p>
                </div>
              )}
              {error && (
                <div className="v3-card-sm border border-danger/20 bg-danger-bg p-3 flex items-center gap-2">
                  <X size={14} strokeWidth={2.5} className="text-danger shrink-0" />
                  <p className="text-[12.5px] font-semibold text-danger">{error}</p>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="min-w-0">
                  <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Type</label>
                  <select
                    value={form.type}
                    onChange={e => {
                      setForm(f => ({ ...f, type: e.target.value }));
                      clearAttachment();
                    }}
                    className={selectCls}
                  >
                    {["CASUAL","SICK","EARNED","UNPAID","WFH","COMP_OFF"].map(t => <option key={t} value={t}>{t.replace("_", " ")}</option>)}
                  </select>
                </div>
                <div className="min-w-0">
                  <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">From</label>
                  <input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} required className={fieldCls} />
                </div>
                <div className="min-w-0">
                  <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">To</label>
                  <input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} required className={fieldCls} />
                </div>
              </div>
              <div>
                <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Reason</label>
                <textarea value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} required rows={2}
                  className="w-full px-3 py-2.5 text-[13.5px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none resize-none placeholder:text-ink-4"
                  placeholder="Describe the reason for your leave…" />
              </div>

              {/* Medical certificate — required for SICK leave */}
              {isSick && (
                <div className="v3-card-sm border-2 border-dashed border-ink/15 rounded-xl p-4 space-y-2">
                  <label className="block text-[11.5px] font-bold text-ink-3 uppercase tracking-wider">
                    Medical Certificate <span className="text-danger">*</span>
                  </label>
                  <p className="text-[11px] text-ink-4">Required for sick leave. Upload a PDF or image (max 10 MB).</p>
                  {uploadedAttachment ? (
                    <div className="flex items-center gap-2 bg-success-bg border border-success/20 rounded-lg px-3 py-2">
                      <Check size={13} className="text-success shrink-0" />
                      <span className="text-[12px] font-medium text-success flex-1 truncate">{uploadedAttachment.name}</span>
                      <button type="button" onClick={clearAttachment} className="text-ink-4 hover:text-danger transition-colors">
                        <X size={13} />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      disabled={uploading}
                      className="inline-flex items-center gap-2 px-4 h-9 rounded-xl border-2 border-ink/15 text-[12.5px] font-semibold text-ink-3 hover:border-indigo hover:text-ink transition-colors disabled:opacity-50"
                    >
                      <Paperclip size={13} />
                      {uploading ? "Uploading…" : "Choose file"}
                    </button>
                  )}
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png"
                    hidden
                    onChange={handleFileChange}
                  />
                </div>
              )}

              <button type="submit" disabled={submitting || uploading}
                className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink disabled:opacity-50">
                {submitting ? "Submitting…" : "Submit Request"}
              </button>
            </form>
          </div>

          {/* History */}
          <div className="v3-card overflow-hidden">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <h3 className="text-[14px] font-bold text-ink">Your Leave Requests</h3>
            </div>
            {!requests ? (
              <div className="p-5 space-y-2">{[1,2,3].map(i => <div key={i} className="h-12 bg-muted rounded-lg animate-pulse" />)}</div>
            ) : requests.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <Calendar size={24} className="mx-auto mb-3 text-ink-4" />
                <p className="text-[13px] text-ink-3 font-medium">No leave requests found</p>
              </div>
            ) : (
              <ul>
                {requests.map((r, i) => {
                  const sc = statusCfg[r.status] || statusCfg.PENDING;
                  const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
                  return (
                    <li key={r.id} style={i < requests.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}}>
                      <div className="px-5 py-3.5 flex items-center gap-4 v3-row flex-wrap">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[13.5px] font-semibold text-ink">{r.type.replace("_", " ")}</span>
                            <span className="text-[11.5px] text-ink-3 font-medium">{fmtDate(r.startDate)} → {fmtDate(r.endDate)}</span>
                          </div>
                          <p className="text-[12px] text-ink-3 mt-0.5 font-medium">&quot;{r.reason}&quot;</p>
                          {r.attachmentName && (
                            <p className="text-[11px] text-ink-4 mt-0.5 flex items-center gap-1">
                              <Paperclip size={10} />
                              {r.attachmentName}
                            </p>
                          )}
                        </div>
                        <span className={`inline-flex h-6 px-2.5 rounded-full text-[11px] font-semibold items-center border shrink-0 ${sc}`}>{r.status}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

        </div>
      </div>
    </>
  );
}
