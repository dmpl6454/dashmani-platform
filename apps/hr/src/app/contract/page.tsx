"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR, { mutate } from "swr";
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

const cardClass =
  "bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5";
const btnClass =
  "bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

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
    const token =
      typeof window !== "undefined"
        ? localStorage.getItem("hrAccessToken")
        : null;
    const url = `${API_URL}/hr/contract/${contractToShow.id}/html`;

    fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => r.json())
      .then((data) => {
        const html = data.data?.html || data.data || "";
        const win = window.open("", "_blank");
        if (win) {
          win.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>Employment Contract</title>
              <style>
                body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; padding: 20px; color: #1A1A1A; }
                @media print { body { margin: 0; padding: 20px; } }
              </style>
            </head>
            <body>${html}</body>
            </html>
          `);
          win.document.close();
        }
      });
  }

  const isLoading = pendingLoading || currentLoading;
  const hasNoContract = !isLoading && !pending && !current && (pendingError || currentError || true);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10">
        <h1 className="text-4xl font-light text-[#1A1A1A] font-serif mb-8">
          Employment Contract
        </h1>
        <div className={cardClass}>
          <div className="space-y-4">
            <div className="h-6 bg-[#F5F3EF] rounded animate-pulse w-1/3" />
            <div className="h-4 bg-[#F5F3EF] rounded animate-pulse w-full" />
            <div className="h-4 bg-[#F5F3EF] rounded animate-pulse w-2/3" />
          </div>
        </div>
      </div>
    );
  }

  // Empty state
  if (hasNoContract && !contractToShow) {
    return (
      <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10">
        <h1 className="text-4xl font-light text-[#1A1A1A] font-serif mb-8">
          Employment Contract
        </h1>
        <div className={`${cardClass} text-center py-16`}>
          <FileText className="w-12 h-12 mx-auto mb-4 text-[#B0B0B0] opacity-40" />
          <p className="text-[#B0B0B0] text-sm">
            No employment contract found. Please contact HR.
          </p>
        </div>
      </div>
    );
  }

  // Pending contract - needs agreement
  if (pending && !agreed) {
    return (
      <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10">
        <h1 className="text-4xl font-light text-[#1A1A1A] font-serif mb-8">
          Employment Contract
        </h1>

        {success && (
          <div className="mb-6 px-4 py-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            {success}
          </div>
        )}
        {error && (
          <div className="mb-6 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-center gap-2">
            <XCircle className="w-4 h-4" />
            {error}
          </div>
        )}

        <div className="mb-4 px-4 py-3 rounded-lg bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" />
          Please review and agree to your employment contract below.
        </div>

        {/* Contract HTML Content */}
        <div className={`${cardClass} mb-6`}>
          {contractHtml ? (
            <div
              className="prose prose-sm max-w-none text-[#1A1A1A]"
              dangerouslySetInnerHTML={{ __html: contractHtml }}
            />
          ) : (
            <div className="space-y-3">
              <div className="h-4 bg-[#F5F3EF] rounded animate-pulse w-full" />
              <div className="h-4 bg-[#F5F3EF] rounded animate-pulse w-3/4" />
              <div className="h-4 bg-[#F5F3EF] rounded animate-pulse w-5/6" />
            </div>
          )}
        </div>

        {/* Agreement Checkbox and Button */}
        <div className={cardClass}>
          <label className="flex items-start gap-3 cursor-pointer mb-5">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-[#E8E0D0] text-[#F5D547] focus:ring-[#F5D547] accent-[#F5D547]"
            />
            <span className="text-sm text-[#1A1A1A]">
              I have read and agree to all the terms and conditions
            </span>
          </label>
          <button
            onClick={handleAgree}
            disabled={!checked || submitting}
            className={`${btnClass} ${!checked ? "opacity-50 cursor-not-allowed" : ""}`}
          >
            {submitting ? "Processing..." : "I Agree"}
          </button>
        </div>
      </div>
    );
  }

  // Current / Agreed contract view
  const contract = contractToShow!;
  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10">
      <h1 className="text-4xl font-light text-[#1A1A1A] font-serif mb-8">
        Employment Contract
      </h1>

      {success && (
        <div className="mb-6 px-4 py-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          {success}
        </div>
      )}

      <div className={cardClass}>
        <div className="flex items-center gap-3 mb-6">
          <FileText className="w-5 h-5 text-[#F5D547]" />
          <h2 className="text-lg font-semibold text-[#1A1A1A]">
            Contract Details
          </h2>
          {contract.agreedAt && (
            <span className="ml-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-800 border border-green-300">
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="p-4 rounded-xl bg-[#FEFCF7] border border-[#E8E0D0]">
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="w-4 h-4 text-[#B0B0B0]" />
              <span className="text-xs text-[#B0B0B0]">Designation</span>
            </div>
            <p className="text-sm font-semibold text-[#1A1A1A]">
              {contract.designation}
            </p>
          </div>

          <div className="p-4 rounded-xl bg-[#FEFCF7] border border-[#E8E0D0]">
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="w-4 h-4 text-[#B0B0B0]" />
              <span className="text-xs text-[#B0B0B0]">Department</span>
            </div>
            <p className="text-sm font-semibold text-[#1A1A1A]">
              {contract.department}
            </p>
          </div>

          <div className="p-4 rounded-xl bg-[#FEFCF7] border border-[#E8E0D0]">
            <span className="text-xs text-[#B0B0B0]">Salary</span>
            <p className="text-sm font-semibold text-[#1A1A1A]">
              {contract.salary
                ? `INR ${contract.salary.toLocaleString("en-IN")}`
                : "--"}
            </p>
          </div>

          <div className="p-4 rounded-xl bg-[#FEFCF7] border border-[#E8E0D0]">
            <span className="text-xs text-[#B0B0B0]">Start Date</span>
            <p className="text-sm font-semibold text-[#1A1A1A]">
              {new Date(contract.startDate).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </p>
          </div>
        </div>

        <div className="mt-6 pt-5 border-t border-[#E8E0D0]">
          <button onClick={handleDownload} className={btnClass}>
            <span className="flex items-center gap-2">
              <Download className="w-4 h-4" />
              Download Contract
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
