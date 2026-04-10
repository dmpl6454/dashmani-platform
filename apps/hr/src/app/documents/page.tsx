"use client";

import { useState, useRef } from "react";
import { apiFetch, apiUpload } from "@/lib/api";
import useSWR from "swr";
import {
  Upload,
  FileText,
  CheckCircle2,
  Clock,
  XCircle,
  File,
  Trash2,
} from "lucide-react";

interface Document {
  id: string;
  documentType: string;
  fileName: string;
  fileSize: number;
  uploadedAt: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reviewNotes?: string | null;
  downloadUrl?: string;
}

const DOCUMENT_TYPES = [
  { value: "AADHAAR", label: "Aadhaar Card" },
  { value: "PAN", label: "PAN Card" },
  { value: "PASSPORT", label: "Passport" },
  { value: "DRIVING_LICENSE", label: "Driving License" },
  { value: "VOTER_ID", label: "Voter ID" },
  { value: "BANK_PASSBOOK", label: "Bank Passbook" },
  { value: "EDUCATION_CERTIFICATE", label: "Education Certificate" },
  { value: "EXPERIENCE_LETTER", label: "Experience Letter" },
  { value: "OTHER", label: "Other" },
];

const statusConfig: Record<
  string,
  { label: string; bg: string; text: string; icon: typeof CheckCircle2 }
> = {
  PENDING: {
    label: "Pending Review",
    bg: "bg-yellow-50",
    text: "text-yellow-700",
    icon: Clock,
  },
  APPROVED: {
    label: "Approved",
    bg: "bg-green-50",
    text: "text-green-700",
    icon: CheckCircle2,
  },
  REJECTED: {
    label: "Rejected",
    bg: "bg-red-50",
    text: "text-red-700",
    icon: XCircle,
  },
};

const inputClass =
  "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";
const selectClass =
  "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function getTypeLabel(type: string): string {
  return DOCUMENT_TYPES.find((t) => t.value === type)?.label ?? type;
}

export default function DocumentsPage() {
  const {
    data: documents,
    error,
    isLoading,
    mutate,
  } = useSWR<Document[]>("/hr/documents", apiFetch);

  const [documentType, setDocumentType] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadSuccess, setUploadSuccess] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async () => {
    if (!documentType) {
      setUploadError("Please select a document type.");
      return;
    }
    if (!selectedFile) {
      setUploadError("Please select a file to upload.");
      return;
    }

    setUploading(true);
    setUploadError("");
    setUploadSuccess("");

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("documentType", documentType);

      await apiUpload("/hr/documents", formData);

      setUploadSuccess("Document uploaded successfully!");
      setDocumentType("");
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      mutate();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Upload failed. Please try again.";
      setUploadError(message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-light text-[#1A1A1A] font-serif">
          My Documents
        </h1>
        <p className="text-sm text-[#888] mt-1">
          Upload and manage your identity and employment documents
        </p>
      </div>

      {/* Upload Form */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5 mb-8">
        <h2 className="text-lg font-semibold text-[#1A1A1A] mb-4 flex items-center gap-2">
          <Upload className="w-5 h-5 text-[#C4B89C]" />
          Upload Document
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          {/* Document Type */}
          <div>
            <label className="block text-xs font-medium text-[#888] uppercase tracking-wider mb-1.5">
              Document Type
            </label>
            <select
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value)}
              className={selectClass}
            >
              <option value="">Select type...</option>
              {DOCUMENT_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
          </div>

          {/* File Input */}
          <div>
            <label className="block text-xs font-medium text-[#888] uppercase tracking-wider mb-1.5">
              File
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
              onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              className={inputClass}
            />
          </div>

          {/* Upload Button */}
          <div>
            <button
              onClick={handleUpload}
              disabled={uploading}
              className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 w-full justify-center"
            >
              {uploading ? (
                <>
                  <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Upload
                </>
              )}
            </button>
          </div>
        </div>

        {/* Selected file info */}
        {selectedFile && (
          <div className="mt-3 flex items-center gap-2 text-xs text-[#888]">
            <File className="w-3.5 h-3.5" />
            <span>
              {selectedFile.name} ({formatFileSize(selectedFile.size)})
            </span>
            <button
              onClick={() => {
                setSelectedFile(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
              }}
              className="text-red-400 hover:text-red-600 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Messages */}
        {uploadError && (
          <p className="mt-3 text-sm text-red-600 flex items-center gap-1.5">
            <XCircle className="w-4 h-4" />
            {uploadError}
          </p>
        )}
        {uploadSuccess && (
          <p className="mt-3 text-sm text-green-600 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4" />
            {uploadSuccess}
          </p>
        )}
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 border-2 border-[#F5D547] border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-2xl p-5 text-sm">
          Failed to load documents. Please try again later.
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && (!documents || documents.length === 0) && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-12 text-center">
          <div className="mx-auto w-16 h-16 bg-[#FEFCF7] rounded-full flex items-center justify-center mb-4">
            <FileText className="w-8 h-8 text-[#C4B89C]" />
          </div>
          <h3 className="text-lg font-semibold text-[#1A1A1A] mb-1">
            No documents uploaded
          </h3>
          <p className="text-sm text-[#888]">
            Upload your identity and employment documents using the form above.
          </p>
        </div>
      )}

      {/* Documents List */}
      {documents && documents.length > 0 && (
        <div className="space-y-3">
          {documents.map((doc) => {
            const status = statusConfig[doc.status] ?? statusConfig.PENDING;
            const StatusIcon = status.icon;

            return (
              <div
                key={doc.id}
                className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <div className="w-10 h-10 rounded-xl bg-[#FEFCF7] border border-[#E8E0D0] flex items-center justify-center shrink-0">
                      <FileText className="w-5 h-5 text-[#C4B89C]" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-[#1A1A1A] text-sm">
                        {getTypeLabel(doc.documentType)}
                      </p>
                      <p className="text-xs text-[#888] mt-0.5 truncate">
                        {doc.fileName}
                      </p>
                      <div className="flex items-center gap-3 mt-1.5 text-xs text-[#AAA]">
                        <span>{formatFileSize(doc.fileSize)}</span>
                        <span className="w-1 h-1 bg-[#DDD] rounded-full" />
                        <span>{formatDate(doc.uploadedAt)}</span>
                      </div>
                    </div>
                  </div>

                  <span
                    className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium shrink-0 ${status.bg} ${status.text}`}
                  >
                    <StatusIcon className="w-3.5 h-3.5" />
                    {status.label}
                  </span>
                </div>

                {/* Rejection Notes */}
                {doc.status === "REJECTED" && doc.reviewNotes && (
                  <div className="mt-3 bg-red-50 border border-red-100 rounded-lg p-3 text-xs text-red-700">
                    <span className="font-semibold">Review Notes:</span>{" "}
                    {doc.reviewNotes}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
