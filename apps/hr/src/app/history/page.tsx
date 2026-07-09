"use client";
import { useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, Clock, Link2 } from "lucide-react";
import { useMyReports, useTodayReport } from "@/lib/hooks/use-reports";
import { Topstrip } from "@/components/portal-shell";
import { Check } from "lucide-react";

const PLATFORM_CFG: Record<string, { bg: string; text: string }> = {
  instagram: { bg: "bg-pink-50",  text: "text-pink-700"  },
  linkedin:  { bg: "bg-blue-50",  text: "text-blue-700"  },
  twitter:   { bg: "bg-sky-50",   text: "text-sky-600"   },
  x:         { bg: "bg-sky-50",   text: "text-sky-600"   },
  youtube:   { bg: "bg-red-50",   text: "text-red-600"   },
  facebook:  { bg: "bg-blue-50",  text: "text-blue-600"  },
  snapchat:  { bg: "bg-yellow-50",text: "text-yellow-700"},
};
function platCfg(p: string) { return PLATFORM_CFG[p?.toLowerCase()] ?? { bg: "bg-muted", text: "text-ink-3" }; }

type RangeKey = "7d" | "30d" | "all";
// `short` is used on mobile where the header row is tight; `label` on sm+ screens.
const RANGES: { label: string; short: string; key: RangeKey }[] = [
  { label: "7 Days", short: "7d", key: "7d" }, { label: "30 Days", short: "30d", key: "30d" }, { label: "All Time", short: "All", key: "all" },
];

function localDateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getDateRange(key: RangeKey) {
  const now = new Date();
  if (key === "7d")  { const s = new Date(now); s.setDate(now.getDate() - 7);  return { startDate: localDateStr(s), endDate: localDateStr(now) }; }
  if (key === "30d") { const s = new Date(now); s.setDate(now.getDate() - 30); return { startDate: localDateStr(s), endDate: localDateStr(now) }; }
  return {};
}

function ReportCard({ report }: { report: any }) {
  const [expanded, setExpanded] = useState(false);
  const links = report.links ?? [];
  return (
    <div className="v3-card overflow-hidden">
      <button onClick={() => setExpanded(v => !v)} className="w-full px-5 h-14 flex items-center justify-between v3-row text-left">
        <div className="flex items-center gap-3">
          <span className="h-8 w-8 rounded-xl bg-success-bg text-success grid place-items-center shrink-0">
            <Check size={14} strokeWidth={2.5} />
          </span>
          <div>
            <p className="text-[13.5px] font-bold text-ink">
              {new Date(report.date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
            </p>
            <p className="text-[11px] text-ink-3 font-medium">
              {links.length} link{links.length !== 1 ? "s" : ""}
              {report.submittedAt && <> · {new Date(report.submittedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</>}
            </p>
          </div>
        </div>
        {expanded ? <ChevronUp size={14} className="text-ink-4" /> : <ChevronDown size={14} className="text-ink-4" />}
      </button>
      {expanded && (
        <div style={{ borderTop: "1px solid rgba(26,26,26,0.07)" }}>
          {links.length === 0 ? (
            <div className="px-5 py-4 text-[12.5px] text-ink-3 font-medium">No links in this report.</div>
          ) : (
            <ul>
              {links.map((lk: any, i: number) => {
                const platformSlug = (lk.platformSlug || lk.platform || "").toLowerCase();
                const accountLabel = lk.accountHandle || lk.accountName || "—";
                const pc = platCfg(platformSlug);
                return (
                  <li key={lk.id ?? i} style={i < links.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.05)" } : {}}>
                    <div className="px-5 py-3 flex items-center gap-3">
                      <span className={`h-5 px-2 rounded-full text-[10px] font-bold inline-flex items-center shrink-0 ${pc.bg} ${pc.text}`}>
                        {platformSlug || "—"}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[12.5px] font-semibold text-ink truncate">{accountLabel}</p>
                        {lk.url && (
                          <a href={lk.url} target="_blank" rel="noopener noreferrer"
                            className="text-[11.5px] text-indigo font-medium hover:underline truncate flex items-center gap-1">
                            {lk.url} <ExternalLink size={10} />
                          </a>
                        )}
                      </div>
                      {(lk.likes != null || lk.comments != null) && (
                        <div className="flex gap-3 text-[10.5px] text-ink-4 font-medium shrink-0">
                          {lk.likes != null && <span>{lk.likes} likes</span>}
                          {lk.comments != null && <span>{lk.comments} comments</span>}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {report.notes && (
            <div className="px-5 py-3 bg-muted/30" style={{ borderTop: "1px solid rgba(26,26,26,0.06)" }}>
              <p className="text-[12px] text-ink-3 font-medium italic">"{report.notes}"</p>
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
  const { data: todayData } = useTodayReport();
  const reports = data?.data ?? [];

  const todayReport = todayData?.data ?? null;
  const linksTodayCount: number = todayReport?.links?.length ?? 0;
  const todayDateStr = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" });

  return (
    <>
      <Topstrip title="Link History" sub={`${reports.length} reports`} right={
        <div className="flex gap-1 shrink-0">
          {RANGES.map(r => (
            <button key={r.key} onClick={() => setRange(r.key)}
              className={`h-8 px-2.5 sm:px-3 rounded-full text-[12px] font-semibold border-2 whitespace-nowrap shrink-0 transition-all ${range === r.key ? "bg-ink text-white border-ink" : "bg-surface text-ink-2 border-ink/12 hover:border-ink/25"}`}>
              <span className="sm:hidden">{r.short}</span>
              <span className="hidden sm:inline">{r.label}</span>
            </button>
          ))}
        </div>
      } />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[800px]">
        {/* Today's links stat */}
        <div className="v3-card px-5 py-4 mb-4 flex items-center gap-3 anim-fade-up d1">
          <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${linksTodayCount > 0 ? "bg-success-bg" : "bg-attention-bg"}`}>
            <Link2 size={16} className={linksTodayCount > 0 ? "text-success" : "text-attention"} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-bold text-ink leading-tight">
              {linksTodayCount > 0
                ? `${linksTodayCount} link${linksTodayCount !== 1 ? "s" : ""} submitted today`
                : "No links submitted today yet"}
            </p>
            <p className="text-[11px] text-ink-3 font-medium mt-0.5">{todayDateStr}</p>
          </div>
          {linksTodayCount > 0 && (
            <span className="shrink-0 h-8 min-w-[2rem] rounded-xl bg-success-bg text-success text-[13px] font-bold grid place-items-center px-2">
              {linksTodayCount}
            </span>
          )}
        </div>

        <div className="space-y-3 anim-fade-up d2">
          {isLoading ? (
            <div className="v3-card px-5 py-10 text-center"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo mx-auto" /></div>
          ) : reports.length === 0 ? (
            <div className="v3-card px-5 py-10 text-center"><Clock size={24} className="mx-auto mb-3 text-ink-4" /><p className="text-[13px] text-ink-3 font-medium">No reports found for this period</p></div>
          ) : (
            reports.map((r: any) => <ReportCard key={r.id} report={r} />)
          )}
        </div>
      </div>
    </>
  );
}
