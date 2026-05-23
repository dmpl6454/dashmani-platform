"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR, { mutate } from "swr";
import { Topstrip } from "@/components/portal-shell";
import {
  FileText,
  CheckCircle2,
  XCircle,
  Download,
  ShieldCheck,
  Building2,
  BadgeCheck,
} from "lucide-react";

interface Contract {
  id: string;
  designation: string;
  salary: number;
  department: string;
  startDate: string;
  agreedAt?: string | null;
  status: string;
}


const fetcher = (url: string) => apiFetch<any>(url).then((r) => r.data);

export default function ContractPage() {
  const {
    data: pending,
    error: pendingError,
    isLoading: pendingLoading,
  } = useSWR<Contract | null>("/hr/contract/pending", fetcher, {
    onError: () => {},
  });

  const {
    data: current,
    error: currentError,
    isLoading: currentLoading,
  } = useSWR<Contract | null>(
    !pending ? "/hr/contract" : null,
    fetcher,
    { onError: () => {} }
  );

  const contractToShow = pending || current;

  const {
    data: contractHtml,
  } = useSWR<string>(
    contractToShow?.id && pending
      ? `/hr/contract/${contractToShow.id}/html`
      : null,
    (url: string) =>
      apiFetch<any>(url).then((r) => r.data?.html || r.data || "")
  );

  const [agreed, setAgreed] = useState(false);
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  async function handleAgree() {
    if (!contractToShow?.id || !checked) return;
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      await apiFetch(`/hr/contract/${contractToShow.id}/agree`, {
        method: "POST",
      });
      setAgreed(true);
      setSuccess("Contract agreed successfully! Thank you.");
      mutate("/hr/contract/pending");
      mutate("/hr/contract");
    } catch (err: any) {
      setError(err.message || "Failed to agree to contract");
    } finally {
      setSubmitting(false);
    }
  }

  function handleDownload() {
    if (!contractToShow?.id) return;
    apiFetch<any>(`/hr/contract/${contractToShow.id}/html`).then((res) => {
      const html = res.data?.html || res.data || "";
      const win = window.open("", "_blank");
      if (win) {
        win.document.write(`<!DOCTYPE html><html><head><title>Employment Contract</title>
          <style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;padding:20px;color:#1A1A1A}@media print{body{margin:0;padding:20px}}</style>
        </head><body>${html}</body></html>`);
        win.document.close();
      }
    }).catch((e: any) => alert(e.message));
  }

  const isLoading = pendingLoading || currentLoading;
  const hasNoContract = !isLoading && !pending && !current && (pendingError || currentError || true);

  if (isLoading) {
    return (
      <>
        <Topstrip title="Employment Contract" sub="Review and manage your employment agreement" />
        <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px]">
          <div className="v3-card p-6 space-y-3">
            <div className="h-5 bg-muted rounded-xl animate-pulse w-1/3" />
            <div className="h-4 bg-muted rounded-xl animate-pulse w-full" />
            <div className="h-4 bg-muted rounded-xl animate-pulse w-2/3" />
          </div>
        </div>
      </>
    );
  }

  if (hasNoContract && !contractToShow) {
    return (
      <>
        <Topstrip title="Employment Contract" sub="Review and manage your employment agreement" />
        <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px]">
          <div className="v3-card p-12 text-center">
            <FileText className="w-9 h-9 mx-auto mb-3 text-ink-4" />
            <p className="text-[13px] text-ink-3 font-medium">
              No employment contract found. Please contact HR.
            </p>
          </div>
        </div>
      </>
    );
  }

  // Pending contract — needs agreement
  if (pending && !agreed) {
    return (
      <>
        <Topstrip title="Employment Contract" sub="Please review and sign your contract" />
        <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px] space-y-4">

          {success && (
            <div className="flex items-center gap-2 bg-success-bg border border-success/20 text-success px-4 py-3 rounded-xl text-[13px] font-medium">
              <CheckCircle2 className="w-4 h-4" />
              {success}
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 bg-danger-bg border border-danger/20 text-danger px-4 py-3 rounded-xl text-[13px] font-medium">
              <XCircle className="w-4 h-4" />
              {error}
            </div>
          )}

          <div className="flex items-center gap-2.5 bg-attention-bg border border-attention/20 text-attention px-4 py-3 rounded-xl text-[13px] font-medium">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            Please review your employment contract below and sign it.
          </div>

          {/* Contract HTML Content */}
          <div className="v3-card">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <FileText className="w-4 h-4 text-ink-3 mr-2" />
              <span className="text-[13px] font-semibold text-ink">Contract Document</span>
            </div>
            <div className="p-5">
              {contractHtml ? (
                <div
                  className="prose prose-sm max-w-none text-ink"
                  dangerouslySetInnerHTML={{ __html: contractHtml }}
                />
              ) : (
                <div className="space-y-3">
                  <div className="h-4 bg-muted rounded-xl animate-pulse w-full" />
                  <div className="h-4 bg-muted rounded-xl animate-pulse w-3/4" />
                  <div className="h-4 bg-muted rounded-xl animate-pulse w-5/6" />
                </div>
              )}
            </div>
          </div>

          {/* Agreement */}
          <div className="v3-card">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <span className="text-[13px] font-semibold text-ink">Sign Contract</span>
            </div>
            <div className="p-5">
              <label className="flex items-start gap-3 cursor-pointer mb-5">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-ink/20 accent-indigo"
                />
                <span className="text-[13px] text-ink leading-relaxed">
                  I have read and agree to all the terms and conditions of this employment contract.
                </span>
              </label>
              <button
                onClick={handleAgree}
                disabled={!checked || submitting}
                className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "Processing..." : "I Agree"}
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Current / Agreed contract view
  const contract = contractToShow!;
  return (
    <>
      <Topstrip title="Employment Contract" sub="Your current employment agreement" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px] space-y-4">

        {success && (
          <div className="flex items-center gap-2 bg-success-bg border border-success/20 text-success px-4 py-3 rounded-xl text-[13px] font-medium">
            <CheckCircle2 className="w-4 h-4" />
            {success}
          </div>
        )}

        <div className="v3-card">
          <div className="px-5 h-12 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-ink-3" />
              <span className="text-[13px] font-semibold text-ink">Contract Details</span>
            </div>
            {contract.agreedAt && (
              <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[11px] font-semibold bg-success-bg text-success border border-success/20">
                <BadgeCheck className="w-3.5 h-3.5" />
                Agreed on{" "}
                {new Date(contract.agreedAt).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </span>
            )}
          </div>

          <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="v3-card-inset p-4">
              <div className="flex items-center gap-1.5 mb-1">
                <Building2 className="w-3.5 h-3.5 text-ink-4" />
                <p className="text-[11.5px] font-bold text-ink-3 uppercase tracking-wider">Designation</p>
              </div>
              <p className="text-[14px] font-semibold text-ink">{contract.designation}</p>
            </div>

            <div className="v3-card-inset p-4">
              <div className="flex items-center gap-1.5 mb-1">
                <Building2 className="w-3.5 h-3.5 text-ink-4" />
                <p className="text-[11.5px] font-bold text-ink-3 uppercase tracking-wider">Department</p>
              </div>
              <p className="text-[14px] font-semibold text-ink">{contract.department}</p>
            </div>

            <div className="v3-card-inset p-4">
              <p className="text-[11.5px] font-bold text-ink-3 uppercase tracking-wider mb-1">Salary</p>
              <p className="text-[14px] font-semibold text-ink">
                {contract.salary
                  ? `INR ${contract.salary.toLocaleString("en-IN")}`
                  : "--"}
              </p>
            </div>

            <div className="v3-card-inset p-4">
              <p className="text-[11.5px] font-bold text-ink-3 uppercase tracking-wider mb-1">Start Date</p>
              <p className="text-[14px] font-semibold text-ink">
                {new Date(contract.startDate).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </p>
            </div>
          </div>

          <div className="px-5 pb-5">
            <button
              onClick={handleDownload}
              className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink"
            >
              <Download className="w-4 h-4" />
              Download Contract
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
