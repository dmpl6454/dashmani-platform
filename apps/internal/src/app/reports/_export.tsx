"use client";
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { apiFetchBlob, downloadBlob } from "@/lib/api";

/**
 * "Extract to Spreadsheet" button. Downloads a two-sheet .xlsx (Channel Summary
 * + Day-wise Breakdown) for the given window. Honors the page's selected pill —
 * pass the same startDate/endDate the page is filtering by. Server-generated,
 * so the heavy lifting and the data-accuracy guarantees live in the API.
 */
export function ExportButton({
  startDate,
  endDate,
  variant = "light",
}: {
  startDate: string;
  endDate: string;
  variant?: "light" | "dark";
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      const { blob, filename } = await apiFetchBlob(
        `/admin/reports/export.xlsx?${params.toString()}`,
      );
      downloadBlob(blob, filename || `reports-export-${startDate}_${endDate}.xlsx`);
    } catch (e: any) {
      setError(e?.message || "Export failed");
    } finally {
      setLoading(false);
    }
  }

  const base =
    "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-shadow disabled:opacity-60 disabled:cursor-not-allowed";
  const skin =
    variant === "dark"
      ? "bg-[#1A1A1A] text-white shadow-[0_4px_16px_rgba(0,0,0,0.18)] hover:shadow-[0_6px_24px_rgba(0,0,0,0.22)]"
      : "bg-white border border-[#E8E0D0] text-[#1A1A1A] hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)]";

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleExport}
        disabled={loading}
        aria-live="polite"
        className={`${base} ${skin}`}
        title="Download an Excel workbook of channel summary + day-wise link breakdown for the selected window"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4 text-emerald-600" />
        )}
        {loading ? "Extracting…" : "Extract to Sheet"}
      </button>
      {error && <span className="text-xs text-red-600 max-w-[220px] text-right">{error}</span>}
    </div>
  );
}