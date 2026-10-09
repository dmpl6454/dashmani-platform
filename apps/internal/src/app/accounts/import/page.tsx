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
    <div className="space-y-3.5 pb-6 crx-animate-fade max-w-3xl">
      <section className="pt-[26px] pb-1.5">
        <p className="text-[10px] tracking-[.2em] uppercase text-ds-gold font-semibold">Social Media</p>
        <h1 className="mt-2 text-[26px] font-semibold tracking-[-.02em] text-ds-text">Import Social Media Accounts</h1>
      </section>

      {/* Instructions Card */}
      <div className="rounded-[10px] bg-ds-card border border-ds-line p-5">
        <div className="flex items-start gap-3">
          <Info size={20} className="text-ds-gold mt-0.5 shrink-0" />
          <div className="text-[12.5px] text-ds-t2 space-y-2 [&_strong]:text-ds-t5 [&_strong]:font-semibold">
            <p className="text-[14px] font-semibold text-ds-text">Excel Format Instructions</p>
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
              className="inline-flex items-center gap-1.5 h-[30px] px-3 rounded-[6px] border border-ds-line2 bg-ds-inset text-ds-t5 text-[12px] font-semibold hover:border-ds-gold/55 hover:text-ds-gold transition-colors mt-1"
            >
              <Download size={14} />
              Download Template
            </a>
          </div>
        </div>
      </div>

      {/* Upload Area */}
      <div className="rounded-[10px] bg-ds-card border border-ds-line p-5">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
          }}
          onClick={() => fileRef.current?.click()}
          className={`border-2 border-dashed rounded-[10px] p-10 text-center cursor-pointer transition-all ${
            dragOver
              ? "border-ds-gold bg-ds-gold/[.06]"
              : "border-ds-line2 bg-ds-inset hover:border-ds-gold/55 hover:bg-ds-gold/[.03]"
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => { if (e.target.files?.[0]) handleFile(e.target.files[0]); }}
            className="hidden"
          />
          <FileSpreadsheet size={36} className="mx-auto mb-3 text-ds-t3" />
          {file ? (
            <p className="text-[13px] text-ds-text font-semibold">{file.name}</p>
          ) : (
            <>
              <p className="text-[13px] text-ds-text font-semibold">Drop your file here or click to browse</p>
              <p className="text-[11.5px] text-ds-t3 mt-1">Supports .xlsx, .xls, .csv</p>
            </>
          )}
        </div>

        <button
          onClick={handleUpload}
          disabled={!file || uploading}
          className="mt-4 h-9 px-[18px] rounded-[6px] bg-ds-gold text-ds-bg text-[12px] font-bold inline-flex items-center gap-1.5 transition-colors hover:bg-ds-gold2 disabled:opacity-50"
        >
          <Upload size={16} />
          {uploading ? "Importing..." : "Upload & Import"}
        </button>
      </div>

      {/* Results */}
      {result && (
        <div className="rounded-[10px] bg-ds-card border border-ds-line p-5 space-y-4">
          <p className="text-[14px] font-semibold text-ds-text">Import Results</p>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-[8px] border border-ds-teal/25 bg-ds-teal/[.08] p-4 text-center">
              <p className="text-[26px] font-semibold tracking-[-.02em] leading-none text-ds-teal">{result.created}</p>
              <p className="text-[11px] text-ds-t3 mt-1.5">Created</p>
            </div>
            <div className="rounded-[8px] border border-ds-gold/25 bg-ds-gold/[.08] p-4 text-center">
              <p className="text-[26px] font-semibold tracking-[-.02em] leading-none text-ds-gold">{result.skipped}</p>
              <p className="text-[11px] text-ds-t3 mt-1.5">Skipped</p>
            </div>
            <div className="rounded-[8px] border border-ds-line2 bg-ds-inset p-4 text-center">
              <p className="text-[26px] font-semibold tracking-[-.02em] leading-none text-ds-text">{result.total}</p>
              <p className="text-[11px] text-ds-t3 mt-1.5">Total Rows</p>
            </div>
          </div>
          {result.errors && result.errors.length > 0 && (
            <div className="space-y-2">
              <p className="text-[12.5px] font-semibold text-ds-redsoft flex items-center gap-1.5">
                <AlertCircle size={14} /> Errors ({result.errors.length})
              </p>
              <ul className="text-[11.5px] text-ds-t2 space-y-1 max-h-40 overflow-y-auto">
                {result.errors.map((err, i) => (
                  <li key={i} className="flex items-start gap-1.5 bg-ds-red/[.08] border border-ds-red/20 rounded-[6px] px-3 py-2">
                    <AlertCircle size={12} className="text-ds-redsoft mt-0.5 shrink-0" />
                    {err}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.errors.length === 0 && (
            <p className="text-[12.5px] text-ds-teal flex items-center gap-1.5">
              <CheckCircle2 size={14} /> All rows imported successfully
            </p>
          )}
        </div>
      )}
    </div>
  );
}
