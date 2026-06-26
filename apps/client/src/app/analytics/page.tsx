"use client";
import { useRouter } from "next/navigation";
import { Topstrip } from "@/components/portal-topstrip";
import { Empty, Skeleton, PageError, StatusBadge } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { useClientAnalytics } from "@/lib/hooks/use-analytics";
import { useClientProjects } from "@/lib/hooks/use-projects";

const FORMAT_COLORS: Record<string, string> = {
  REEL:     "bg-indigo",
  POST:     "bg-sage",
  CAROUSEL: "bg-terra",
  STORY:    "bg-action",
  DOC:      "bg-neutral-bg",
};

function BarChart({ data, colorClass = "bg-indigo", height = 140 }: {
  data: { label: string; value: number }[];
  colorClass?: string;
  height?: number;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="flex items-end gap-2" style={{ height }}>
      {data.map((d, i) => {
        const barH = Math.max((d.value / max) * (height - 44), 6);
        return (
          <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1.5">
            <span className="text-[11px] font-bold text-ink-2 tabular-nums">{d.value}</span>
            <div
              className={`w-full ${colorClass} border-2 border-ink rounded-lg`}
              style={{ height: barH, transition: `height 0.55s cubic-bezier(0.34,1.4,0.64,1)`, transitionDelay: `${i * 0.055}s` }}
            />
            <span className="text-[10px] font-bold text-ink-3 text-center leading-tight whitespace-nowrap">{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

function HBar({ label, value, max, count, colorClass = "bg-indigo" }: {
  label: string; value: number; max: number; count: number; colorClass?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-ink">{label}</span>
        <span className="text-[12px] text-ink-3 font-bold tabular-nums">{count}</span>
      </div>
      <div className="h-8 bg-muted rounded-xl overflow-hidden" style={{ border: "2px solid rgba(26,26,26,0.1)" }}>
        <div
          className={`h-full ${colorClass} border-r-2 border-ink rounded-xl`}
          style={{ width: `${Math.max((value / max) * 100, 4)}%`, transition: "width 0.6s cubic-bezier(0.34,1.4,0.64,1)" }}
        />
      </div>
    </div>
  );
}

function healthColor(score: number | null) {
  if (score == null) return "bg-ink-4";
  if (score < 60) return "bg-attention";
  if (score < 85) return "bg-action-deep";
  return "bg-success";
}

const APPROVAL_DATA = [
  { label: "Mon", value: 3 }, { label: "Tue", value: 6 }, { label: "Wed", value: 4 },
  { label: "Thu", value: 8 }, { label: "Fri", value: 5 }, { label: "Sat", value: 2 }, { label: "Sun", value: 1 },
];

const ACCENT_ICON: Record<string, string> = {
  indigo: "bg-indigo-soft text-indigo",
  terra:  "bg-terra-soft text-terra",
  sage:   "bg-sage-soft text-sage",
  action: "bg-action-soft text-ink-2",
};

export default function ClientAnalyticsPage() {
  const router = useRouter();
  const { data, isLoading, error } = useClientAnalytics();
  const { data: projectsRaw } = useClientProjects();
  const projects: any[] = projectsRaw?.items ?? [];

  if (isLoading) {
    return (
      <>
        <Topstrip title="Analytics" />
        <div className="px-6 py-6 max-w-[1260px] mx-auto w-full flex-1 overflow-y-auto space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-32 v3-card" />)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
            <Skeleton className="h-56 v3-card" />
            <Skeleton className="h-56 v3-card" />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-4">
            <Skeleton className="h-48 v3-card" />
            <Skeleton className="h-48 v3-card" />
          </div>
          <Skeleton className="h-40 v3-card" />
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <Topstrip title="Analytics" />
        <div className="p-6 flex-1 grid place-items-center">
          <PageError message="Could not load analytics. Please refresh." />
        </div>
      </>
    );
  }

  if (data && (data.totalPosts ?? 0) === 0) {
    return (
      <>
        <Topstrip title="Analytics" />
        <div className="p-6 flex-1 grid place-items-center">
          <Empty icon={<Icon.Chart size={22} />} title="No data yet" hint="Analytics will appear once your projects have content." />
        </div>
      </>
    );
  }

  const {
    totalPosts = 0,
    postsByFormat = {},
    approvalTurnaround = 0,
    scheduledThisWeek = 0,
    liveThisWeek = 0,
    weeklyPosts = [],
    projectSummaries = [],
  } = data ?? {};

  const formatEntries = Object.entries(postsByFormat as Record<string, number>);
  const formatMax = Math.max(...formatEntries.map(([, v]) => v), 1);

  const heroTiles = [
    { label: "Posts live",         value: liveThisWeek,    sub: "last 7 days",      accent: "indigo", IconC: Icon.Send     },
    { label: "Scheduled",          value: scheduledThisWeek, sub: "next 7 days",    accent: "terra",  IconC: Icon.Calendar },
    { label: "Avg. approval",      value: approvalTurnaround ? `${approvalTurnaround}h` : "—", sub: "last 30 days", accent: "sage", IconC: Icon.Clock },
    { label: "Total posts",        value: totalPosts,       sub: "all time",         accent: "action", IconC: Icon.Chart    },
  ];

  return (
    <>
      <Topstrip title="Analytics" sub="Content performance" />
      <div className="px-6 py-6 max-w-[1260px] mx-auto w-full flex-1 overflow-y-auto">
        <div className="space-y-5">

          {/* ── Hero tiles ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {heroTiles.map((tile, i) => {
              const IC = tile.IconC;
              return (
                <div key={i} className={`fade-up d${i + 1}`}>
                  <div className="v3-card v3-card-lift p-5 h-full flex flex-col gap-3">
                    <div className={`h-9 w-9 rounded-xl grid place-items-center ${ACCENT_ICON[tile.accent]}`}>
                      <IC size={16} sw={2} />
                    </div>
                    <div>
                      <div className="font-num text-[34px] font-semibold leading-none text-ink">{tile.value}</div>
                      <div className="text-[13px] font-semibold text-ink mt-1">{tile.label}</div>
                      <div className="text-[11.5px] text-ink-3 font-medium mt-0.5">{tile.sub}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Charts row 1 ── */}
          <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
            {/* Publishing cadence */}
            <div className="fade-up d5">
              <div className="v3-card p-5">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h3 className="text-[14px] font-bold text-ink">Publishing cadence</h3>
                    <p className="text-[12px] text-ink-3 font-medium mt-0.5">Posts published per week</p>
                  </div>
                  <span className="text-[11px] font-bold text-ink-3 bg-muted px-3 py-1 rounded-full">Last 5 weeks</span>
                </div>
                <BarChart data={weeklyPosts} colorClass="bg-indigo" height={160} />
              </div>
            </div>

            {/* Format mix */}
            <div className="fade-up d6">
              <div className="v3-card p-5 h-full">
                <div className="mb-5">
                  <h3 className="text-[14px] font-bold text-ink">Format mix</h3>
                  <p className="text-[12px] text-ink-3 font-medium mt-0.5">By post type</p>
                </div>
                {formatEntries.length === 0 ? (
                  <div className="text-[13px] text-ink-4 font-medium text-center py-6">No data yet.</div>
                ) : (
                  <div className="space-y-3">
                    {formatEntries.map(([fmt, count]) => (
                      <HBar key={fmt} label={fmt} value={count} max={formatMax} count={count}
                        colorClass={FORMAT_COLORS[fmt] ?? "bg-muted"} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Charts row 2 ── */}
          <div className="grid grid-cols-1 lg:grid-cols-[2fr_3fr] gap-4">
            {/* Approval speed */}
            <div className="fade-up d6">
              <div className="v3-card p-5">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h3 className="text-[14px] font-bold text-ink">Approval speed</h3>
                    <p className="text-[12px] text-ink-3 font-medium mt-0.5">Hours to decision by day</p>
                  </div>
                </div>
                <BarChart data={APPROVAL_DATA} colorClass="bg-terra" height={150} />
              </div>
            </div>

            {/* Project health */}
            <div className="fade-up d7">
              <div className="v3-card overflow-hidden">
                <div className="px-5 h-12 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                  <h3 className="text-[14px] font-bold text-ink">Project health</h3>
                  <button onClick={() => router.push("/projects")} className="text-[12.5px] text-indigo font-semibold hover:underline inline-flex items-center gap-1">
                    View projects <Icon.ArrowRight size={12} />
                  </button>
                </div>
                <div className="p-5 space-y-4">
                  {(projectSummaries as any[]).length === 0 && projects.length === 0 ? (
                    <div className="text-[13px] text-ink-4 font-medium text-center py-4">No projects yet.</div>
                  ) : null}
                  {(projectSummaries as any[]).map((ps) => {
                    const proj = projects.find((p) => p.id === ps.projectId);
                    const health = proj?.healthScore ?? ps.healthScore ?? null;
                    const hColor = healthColor(health);
                    return (
                      <div key={ps.projectId} className="space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[13px] font-semibold text-ink truncate">{ps.name}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            {proj && <StatusBadge status={proj.status} className="!h-5 !text-[10px]" />}
                            {health != null && <span className="text-[13px] font-bold tabular-nums text-ink-2">{health}</span>}
                          </div>
                        </div>
                        <div className="h-3 bg-muted rounded-full overflow-hidden" style={{ border: "2px solid rgba(26,26,26,0.1)" }}>
                          <div className={`h-full ${hColor} rounded-full transition-all duration-700`} style={{ width: `${health ?? 0}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* ── Top posts table ── */}
          <div className="fade-up d8">
            <div className="v3-card overflow-hidden">
              <div className="px-5 h-12 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                <h3 className="text-[14px] font-bold text-ink">Project summaries</h3>
                <span className="text-[11px] text-ink-3 font-medium">by activity</span>
              </div>
              <div
                className="grid px-5 h-10 bg-muted/40 text-[11px] uppercase tracking-wider font-bold text-ink-3 items-center"
                style={{ gridTemplateColumns: "1fr 80px 80px 120px", borderBottom: "1px solid rgba(26,26,26,0.07)" }}
              >
                <span>Project</span>
                <span className="text-right">Posts</span>
                <span className="text-right">Pending</span>
                <span className="pl-3">Health</span>
              </div>
              {(projectSummaries as any[]).length === 0 ? (
                <div className="px-5 py-6 text-[13px] text-ink-4 text-center font-medium">No projects yet.</div>
              ) : (projectSummaries as any[]).map((p, i, arr) => {
                const proj = projects.find((pr) => pr.id === p.projectId);
                const health = proj?.healthScore ?? p.healthScore ?? null;
                const hColor = healthColor(health);
                return (
                  <div
                    key={p.projectId}
                    className="grid px-5 items-center h-row v3-row"
                    style={{ gridTemplateColumns: "1fr 80px 80px 120px", ...(i < arr.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}) }}
                  >
                    <span className="text-[13.5px] font-semibold text-ink truncate">{p.name}</span>
                    <span className="text-right text-[13px] font-bold tabular-nums text-ink">{p.postCount}</span>
                    <span className="text-right text-[13px] font-semibold tabular-nums text-ink-2">
                      {p.pendingCount > 0
                        ? <span className="text-attention font-bold">{p.pendingCount}</span>
                        : <span className="text-ink-4">—</span>}
                    </span>
                    <div className="pl-3 flex items-center gap-2">
                      {health != null ? (
                        <>
                          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden" style={{ border: "1px solid rgba(26,26,26,0.08)" }}>
                            <div className={`h-full ${hColor} rounded-full`} style={{ width: `${health}%` }} />
                          </div>
                          <span className="text-[11.5px] tabular-nums text-ink-2 w-6 text-right font-bold">{health}</span>
                        </>
                      ) : (
                        <span className="text-ink-4 text-[13px]">—</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
