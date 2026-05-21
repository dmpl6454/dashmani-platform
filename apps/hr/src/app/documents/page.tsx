"use client";
import { useState, useRef } from "react";
import { apiFetch, apiUpload } from "@/lib/api";
import useSWR from "swr";
import { Upload, FileText, File, Trash2, Check, X } from "lucide-react";
import { Topstrip } from "@/components/portal-shell";

interface HrDocument {
  id: string; documentType: string; fileName: string; fileSize: number;
  uploadedAt: string; status: "PENDING" | "APPROVED" | "REJECTED"; reviewNotes?: string | null;
}

const DOCUMENT_TYPES = [
  { value: "AADHAAR",              label: "Aadhaar Card" },
  { value: "PAN",                  label: "PAN Card" },
  { value: "PASSPORT",             label: "Passport" },
  { value: "DRIVING_LICENSE",      label: "Driving License" },
  { value: "VOTER_ID",             label: "Voter ID" },
  { value: "BANK_PASSBOOK",        label: "Bank Passbook" },
  { value: "EDUCATION_CERTIFICATE",label: "Education Certificate" },
  { value: "EXPERIENCE_LETTER",    label: "Experience Letter" },
  { value: "OTHER",                label: "Other" },
];

const statusCfg: Record<string, string> = {
  PENDING:  "bg-attention-bg text-attention border-attention/20",
  APPROVED: "bg-success-bg text-success border-success/20",
  REJECTED: "bg-danger-bg text-danger border-danger/20",
};

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

export default function DocumentsPage() {
  const { data, isLoading, mutate } = useSWR<any>("/hr/documents", apiFetch);
  const docs: HrDocument[] = data?.data ?? [];

  const [docType, setDocType] = useState(""); const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false); const [uploadError, setUploadError] = useState(""); const [uploadSuccess, setUploadSuccess] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleUpload() {
    if (!docType) { setUploadError("Please select a document type."); return; }
    if (!file) { setUploadError("Please select a file."); return; }
    setUploading(true); setUploadError(""); setUploadSuccess("");
    try {
      const fd = new FormData(); fd.append("file", file); fd.append("documentType", docType);
      await apiUpload("/hr/documents", fd);
      setUploadSuccess("Document uploaded!"); setDocType(""); setFile(null);
      if (fileRef.current) fileRef.current.value = ""; mutate();
    } catch (err: any) { setUploadError(err.message || "Upload failed."); }
    finally { setUploading(false); }
  }

  const getTypeLabel = (t: string) => DOCUMENT_TYPES.find(d => d.value === t)?.label ?? t;

  return (
    <>
      <Topstrip title="My Documents" sub={`${docs.length} documents`} />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px]">
        <div className="space-y-4 anim-fade-up d1">

          {/* Upload form */}
          <div className="v3-card p-5">
            <h3 className="text-[14px] font-bold text-ink mb-4 flex items-center gap-2"><Upload size={15} className="text-indigo" /> Upload Document</h3>
            <div className="grid grid-cols-3 gap-4 items-end">
              <div>
                <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Type</label>
                <select value={docType} onChange={e => setDocType(e.target.value)}
                  className="w-full h-10 pl-3 pr-8 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none appearance-none">
                  <option value="">Select type…</option>
                  {DOCUMENT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">File</label>
                <input ref={fileRef} type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                  onChange={e => setFile(e.target.files?.[0] ?? null)}
                  className="w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none file:border-0 file:bg-transparent file:text-[12px] file:text-ink-3" />
              </div>
              <button onClick={handleUpload} disabled={uploading}
                className="btn-3d inline-flex items-center justify-center gap-2 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink disabled:opacity-50">
                {uploading ? <><div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Uploading…</> : <><Upload size={14} />Upload</>}
              </button>
            </div>
            {file && (
              <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-3">
                <File size={13} /><span>{file.name} ({fmtSize(file.size)})</span>
                <button onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }} className="text-danger hover:text-danger/70"><Trash2 size={13} /></button>
              </div>
            )}
            {uploadError && <div className="mt-3 flex items-center gap-2 text-[12.5px] text-danger font-medium"><X size={13} strokeWidth={2.5} />{uploadError}</div>}
            {uploadSuccess && <div className="mt-3 flex items-center gap-2 text-[12.5px] text-success font-medium"><Check size={13} strokeWidth={2.5} />{uploadSuccess}</div>}
          </div>

          {/* Document list */}
          {isLoading ? (
            <div className="v3-card overflow-hidden">{[1,2,3].map(i => <div key={i} className="px-5 py-4 border-b border-ink/5"><div className="h-5 bg-muted rounded-lg animate-pulse w-48" /></div>)}</div>
          ) : docs.length === 0 ? (
            <div className="v3-card px-5 py-10 text-center">
              <FileText size={24} className="mx-auto mb-3 text-ink-4" />
              <p className="text-[13px] text-ink-3 font-medium">No documents uploaded yet</p>
            </div>
          ) : (
            <div className="v3-card overflow-hidden">
              {docs.map((doc, i) => {
                const sc = statusCfg[doc.status] || statusCfg.PENDING;
                return (
                  <div key={doc.id} style={i < docs.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}}>
                    <div className="px-5 py-4 flex items-center gap-4 v3-row">
                      <div className="h-9 w-9 rounded-xl bg-muted grid place-items-center text-ink-3 shrink-0"><FileText size={16} strokeWidth={2} /></div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[13.5px] font-semibold text-ink">{getTypeLabel(doc.documentType)}</p>
                        <p className="text-[11.5px] text-ink-3 mt-0.5 truncate">{doc.fileName} · {fmtSize(doc.fileSize)} · {new Date(doc.uploadedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</p>
                      </div>
                      <span className={`inline-flex h-6 px-2.5 rounded-full text-[11px] font-semibold items-center border shrink-0 ${sc}`}>{doc.status}</span>
                    </div>
                    {doc.status === "REJECTED" && doc.reviewNotes && (
                      <div className="px-5 pb-3 ml-[52px]">
                        <div className="v3-card-sm border border-danger/20 bg-danger-bg p-3 text-[12px] text-danger">
                          <span className="font-semibold">Review notes:</span> {doc.reviewNotes}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
