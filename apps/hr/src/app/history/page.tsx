"use client";
import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { useMyReports } from "@/lib/hooks/use-reports";

const PLATFORM_COLORS: Record<string, string> = {
  facebook: "bg-blue-500",
  instagram: "bg-pink-500",
  youtube: "bg-red-500",
  x: "bg-gray-800",
  twitter: "bg-gray-800",
  snapchat: "bg-yellow-400",
  linkedin: "bg-blue-700",
};

function getPlatformColor(platform: string) {
  return PLATFORM_COLORS[platform?.toLowerCase()] || "bg-gray-400";
}

type RangeKey = "7d" | "30d" | "all";

const RANGE_OPTIONS: { label: string; key: RangeKey }[] = [
  { label: "Last 7 Days", key: "7d" },
  { label: "Last 30 Days", key: "30d" },
  { label: "All Time", key: "all" },
];

function getDateRange(key: RangeKey): { startDate?: string; endDate?: string } {
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  if (key === "7d") {
    const start = new Date(now);
    start.setDate(now.getDate() - 7);
    return { startDate: fmt(start), endDate: fmt(now) };
  }
  if (key === "30d") {
    const start = new Date(now);
    start.setDate(now.getDate() - 30);
    return { startDate: fmt(start), endDate: fmt(now) };
  }
  return {};
}

function ReportCard({ report }: { report: any }) {
  const [expanded, setExpanded] = useState(false);
  const links = report.links || [];
  const submittedAt = report.submittedAt || report.createdAt;

  return (
    <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-5 flex items-center justify-between hover:bg-[#FEFCF7] transition-colors"
      >
        <div className="flex items-center gap-4">
          <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center text-sm font-bold text-[#1A1A1A]">
            {links.length}
          </div>
          <div>
            <p className="font-semibold text-[#1A1A1A]">
              {new Date(report.date).toLocaleDateString("en-IN", {
                weekday: "short",
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </p>
            <p className="text-xs text-[#B0B0B0] mt-0.5">
              {links.length} link{links.length !== 1 ? "s" : ""}
              {submittedAt && (
                <> &middot; Submitted {new Date(submittedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</>
              )}
            </p>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-[#B0B0B0]" />
        ) : (
          <ChevronDown className="h-4 w-4 text-[#B0B0B0]" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-[#E8E0D0] p-5 space-y-3">
          {links.length === 0 ? (
            <p className="text-sm text-[#B0B0B0]">No links in this report.</p>
          ) : (
            links.map((link: any, i: number) => (
              <div key={i} className="flex items-start gap-3 p-3 bg-[#FEFCF7] rounded-xl border border-[#E8E0D0]">
                <div className="flex-shrink-0 mt-0.5">
                  <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs text-white font-medium ${getPlatformColor(link.account?.platform)}`}>
                    {link.account?.platform || "—"}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#1A1A1A]">{link.account?.handle || link.account?.name || "—"}</p>
                  <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-xs text-[#7A7A7A] hover:text-[#1A1A1A] flex items-center gap-1 mt-0.5 truncate">
                    {link.url}
                    <ExternalLink className="h-3 w-3 flex-shrink-0" />
                  </a>
                  {link.engagement && Object.values(link.engagement).some(Boolean) && (
                    <div className="flex gap-3 mt-1.5 text-xs text-[#7A7A7A]">
                      {link.engagement.likes != null && <span>{link.engagement.likes} likes</span>}
                      {link.engagement.comments != null && <span>{link.engagement.comments} comments</span>}
                      {link.engagement.shares != null && <span>{link.engagement.shares} shares</span>}
                      {link.engagement.views != null && <span>{link.engagement.views} views</span>}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}

          {report.notes && (
            <div className="mt-3 p-3 bg-[#FFF3C4]/50 border border-[#FAE89E] rounded-xl">
              <p className="text-xs font-medium text-[#7A7A7A]">Notes</p>
              <p className="text-sm text-[#1A1A1A] mt-1">{report.notes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function HistoryPage() {
  const [range, setRange] = useState<RangeKey>("7d");
  const { startDate, endDate } = getDateRange(range);
  const { data, isLoading } = useMyReports(startDate, endDate);
  const reports = data?.data || [];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-light text-[#1A1A1A] font-serif">Report History</h1>
          <p className="text-[#7A7A7A] mt-1">View your past daily reports</p>
        </div>
        <div className="flex gap-2">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => setRange(opt.key)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                range === opt.key
                  ? "bg-[#1A1A1A] text-white shadow-md"
                  : "bg-white border border-[#E8E0D0] text-[#7A7A7A] hover:border-[#F5D547]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" />
        </div>
      ) : reports.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#E8E0D0] p-12 text-center shadow-[0_2px_16px_rgba(0,0,0,0.06)]">
          <p className="text-[#B0B0B0]">No reports found for this period.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {reports.map((report: any) => (
            <ReportCard key={report.id} report={report} />
          ))}
        </div>
      )}
    </div>
  );
}
