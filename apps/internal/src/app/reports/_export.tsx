"use client";
import { useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import { apiFetchBlob, downloadBlob } from "@/lib/api";

/**
 * Two export buttons for the Reports page — deliberately split because a full
 * per-link ledger cannot fit a styled .xlsx in memory at 90-day/team scale
 * (108k+ rows OOM'd the box, 2026-07-22). So:
 *
 *   • ExportButton      → .xlsx : Channel Summary + Cross-Employee Duplicates
 *                         (the concise view + the exact duplicate links & counts).
 *                         Small, always fits, styled.
 *   • AllLinksCsvButton → .csv  : EVERY submitted link with date + IST time +
 *                         channel + who + engagement. Streamed server-side, so it
 *                         scales to any window/size.
 *
 * Both honor the page's date pills AND employee dropdown — pass the same
 * startDate/endDate/employeeId, and the export scopes to that employee.
 */

type Variant = "light" | "dark";

interface DownloadButtonProps {
  startDate: string;
  endDate: string;
  employeeId?: string;
  variant?: Variant;
}

function skinFor(variant: Variant) {
  return variant === "dark"
    ? "bg-[#1A1A1A] text-white shadow-[0_4px_16px_rgba(0,0,0,0.18)] hover:shadow-[0_6px_24px_rgba(0,0,0,0.22)]"
    : "bg-white border border-[#E8E0D0] text-[#1A1A1A] hover:shadow-[0_4px_12px_rgba(0,0,0,0.08)]";
}

const BASE =
  "inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-shadow disabled:opacity-60 disabled:cursor-not-allowed";

/** Shared download-on-click button (blob + filename from the API). */
function DownloadButton({
  path,
  fallbackName,
  idleLabel,
  busyLabel,
  Icon,
  title,
  variant = "light",
}: {
  path: string;
  fallbackName: string;
  idleLabel: string;
  busyLabel: string;
  Icon: typeof Download;
  title: string;
  variant?: Variant;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (loading) return;
    setError(null);
    setLoading(true);
    try {
      const { blob, filename } = await apiFetchBlob(path);
      downloadBlob(blob, filename || fallbackName);
    } catch (e: any) {
      setError(e?.message || "Export failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        aria-live="polite"
        className={`${BASE} ${skinFor(variant)}`}
        title={title}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Icon className="h-4 w-4 text-emerald-600" />
        )}
        {loading ? busyLabel : idleLabel}
      </button>
      {error && <span className="text-xs text-red-600 max-w-[220px] text-right">{error}</span>}
    </div>
  );
}

function buildQuery({ startDate, endDate, employeeId }: DownloadButtonProps): string {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  if (employeeId) params.set("employeeId", employeeId);
  return params.toString();
}

/** Concise .xlsx: Channel Summary + Cross-Employee Duplicates. */
export function ExportButton(props: DownloadButtonProps) {
  const q = buildQuery(props);
  return (
    <DownloadButton
      path={`/admin/reports/export.xlsx?${q}`}
      fallbackName={`reports-export-${props.startDate}_${props.endDate}.xlsx`}
      idleLabel="Extract to Sheet"
      busyLabel="Extracting…"
      Icon={Download}
      title="Download an Excel summary (channel summary + cross-employee duplicate links) for the selected window — scoped to the selected employee when one is chosen"
      variant={props.variant}
    />
  );
}

/** Full raw ledger: every submitted link with date + time. Streamed CSV — scales. */
export function AllLinksCsvButton(props: DownloadButtonProps) {
  const q = buildQuery(props);
  return (
    <DownloadButton
      path={`/admin/reports/links.csv?${q}`}
      fallbackName={`all-links-${props.startDate}_${props.endDate}.csv`}
      idleLabel="All Links (CSV)"
      busyLabel="Preparing…"
      Icon={FileText}
      title="Download a CSV of EVERY submitted link with its date, posting time, channel, who submitted it and engagement — for the selected window, scoped to the selected employee when one is chosen"
      variant={props.variant}
    />
  );
}
