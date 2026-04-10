"use client";

import { useState, useRef, useCallback } from "react";
import { apiUpload } from "@/lib/api";
import { Upload, Download, FileSpreadsheet, AlertCircle, CheckCircle2, Info } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

interface ImportResult {
  total: number;
  created: number;
  skipped: number;
  errors: string[];
}

export default function AccountsImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((f: File) => {
    const validTypes = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv",
    ];
    const ext = f.name.split(".").pop()?.toLowerCase();
    if (!validTypes.includes(f.type) && !["xlsx", "xls", "csv"].includes(ext || "")) {
      alert("Please select an .xlsx, .xls, or .csv file");
      return;
    }
    setFile(f);
    setResult(null);
  }, []);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await apiUpload<any>("/admin/accounts/import", formData);
      setResult(res.data);
    } catch (e: any) {
      alert(e.message || "Import failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-6 crx-animate-fade max-w-3xl">
      <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Import Social Media Accounts</h1>

      {/* Instructions Card */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5">
        <div className="flex items-start gap-3">
          <Info size={20} className="text-[#F5D547] mt-0.5 shrink-0" />
          <div className="text-sm text-[#5A5A5A] space-y-2">
            <p className="font-medium text-[#1A1A1A]">Excel Format Instructions</p>
            <p>Upload an <strong>.xlsx</strong>, <strong>.xls</strong>, or <strong>.csv</strong> file with the following columns:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>platform</strong> - Social media platform (e.g., instagram, twitter, linkedin, facebook)</li>
              <li><strong>username</strong> - Account username or handle</li>
              <li><strong>url</strong> - Profile URL</li>
              <li><strong>clientId</strong> - Client ID to link the account to</li>
              <li><strong>notes</strong> - Optional notes</li>
            </ul>
            <a
              href={`${API_URL}/admin/accounts/import/template`}
              className="inline-flex items-center gap-1.5 text-[#1A1A1A] font-medium hover:text-[#F5D547] transition-colors mt-1"
            >
              <Download size={14} />
              Download Template
            </a>
          </div>
        </div>
      </div>

      {/* Upload Area */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
          }}
          onClick={() => fileRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all ${
            dragOver
              ? "border-[#F5D547] bg-[rgba(245,213,71,0.06)]"
              : "border-[#E8E0D0] hover:border-[#F5D547] hover:bg-[rgba(245,213,71,0.03)]"
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
            className="hidden"
          />
          <FileSpreadsheet size={36} className="mx-auto mb-3 text-[#B0B0B0]" />
          {file ? (
            <p className="text-sm text-[#1A1A1A] font-medium">{file.name}</p>
          ) : (
            <>
              <p className="text-sm text-[#1A1A1A] font-medium">Drop your file here or click to browse</p>
              <p className="text-xs text-[#B0B0B0] mt-1">Supports .xlsx, .xls, .csv</p>
            </>
          )}
        </div>

        <button
          onClick={handleUpload}
          disabled={!file || uploading}
          className="mt-4 bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all disabled:opacity-50 flex items-center gap-2"
        >
          <Upload size={16} />
          {uploading ? "Importing..." : "Upload & Import"}
        </button>
      </div>

      {/* Results */}
      {result && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5 space-y-4">
          <p className="font-medium text-[#1A1A1A]">Import Results</p>
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-xl bg-[rgba(107,203,119,0.08)] p-4 text-center">
              <p className="text-2xl font-semibold text-[#2E7D32]">{result.created}</p>
              <p className="text-xs text-[#7A7A7A] mt-1">Created</p>
            </div>
            <div className="rounded-xl bg-[rgba(245,213,71,0.1)] p-4 text-center">
              <p className="text-2xl font-semibold text-[#B8960C]">{result.skipped}</p>
              <p className="text-xs text-[#7A7A7A] mt-1">Skipped</p>
            </div>
            <div className="rounded-xl bg-[rgba(0,0,0,0.04)] p-4 text-center">
              <p className="text-2xl font-semibold text-[#1A1A1A]">{result.total}</p>
              <p className="text-xs text-[#7A7A7A] mt-1">Total Rows</p>
            </div>
          </div>
          {result.errors && result.errors.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-[#E74C3C] flex items-center gap-1.5">
                <AlertCircle size={14} /> Errors ({result.errors.length})
              </p>
              <ul className="text-xs text-[#7A7A7A] space-y-1 max-h-40 overflow-y-auto">
                {result.errors.map((err, i) => (
                  <li key={i} className="flex items-start gap-1.5 bg-[rgba(231,76,60,0.04)] rounded-lg px-3 py-2">
                    <AlertCircle size={12} className="text-[#E74C3C] mt-0.5 shrink-0" />
                    {err}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.errors.length === 0 && (
            <p className="text-sm text-[#2E7D32] flex items-center gap-1.5">
              <CheckCircle2 size={14} /> All rows imported successfully
            </p>
          )}
        </div>
      )}
    </div>
  );
}
