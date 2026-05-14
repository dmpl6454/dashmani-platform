"use client";
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Topstrip } from "@/components/portal-topstrip";
import { Empty, Skeleton, PageError } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { useClientAnalytics } from "@/lib/hooks/use-analytics";

const STATUS_COLOR: Record<string, string> = {
  REJECTED: "#ef4444",
  PUBLISHED: "#22c55e",
  APPROVED: "#22c55e",
  SCHEDULED: "#f59e0b",
  DRAFT: "#94a3b8",
  PENDING_APPROVAL: "#f59e0b",
};
function statusColor(key: string) {
  return STATUS_COLOR[key] ?? "#94a3b8";
}

function healthColor(score: number | null) {
  if (score == null) return "bg-neutral";
  if (score < 60) return "bg-attention";
  if (score < 85) return "bg-action-deep";
  return "bg-success";
}

export default function ClientAnalyticsPage() {
  const { data, isLoading, error } = useClientAnalytics();

  if (isLoading) {
    return (
      <>
        <Topstrip title="Analytics" />
        <div className="p-6 flex-1 flex flex-col gap-6">
          {/* stat cards skeleton */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
          {/* charts skeleton */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
          {/* table skeleton */}
          <Skeleton className="h-48" />
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <Topstrip title="Analytics" />
        <div className="p-6 flex-1 grid place-items-center">
          <PageError message={error?.message ?? "Failed to load analytics."} />
        </div>
      </>
    );
  }

  if (data && data.totalPosts === 0) {
    return (
      <>
        <Topstrip title="Analytics" />
        <div className="p-6 flex-1 grid place-items-center">
          <Empty
            icon={<Icon.Chart size={22} />}
            title="No data yet"
            hint="Analytics will appear once your projects have content."
          />
        </div>
      </>
    );
  }

  const {
    totalPosts = 0,
    postsByStatus = {},
    postsByFormat = {},
    approvalTurnaround = 0,
    scheduledThisWeek = 0,
    liveThisWeek = 0,
    projectSummaries = [],
  } = data ?? {};

  const pieData = Object.entries(postsByStatus).map(([name, value]) => ({
    name,
    value,
  }));

  const barData = Object.entries(postsByFormat).map(([name, value]) => ({
    name,
    value,
  }));

  const stats = [
    { label: "Posts live this week", value: String(liveThisWeek) },
    { label: "Scheduled this week", value: String(scheduledThisWeek) },
    { label: "Avg approval time", value: `${approvalTurnaround}h` },
    { label: "Total posts", value: String(totalPosts) },
  ];

  return (
    <>
      <Topstrip title="Analytics" />
      <div className="p-6 flex-1 flex flex-col gap-6 overflow-y-auto">

        {/* ── Stat cards ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {stats.map((s) => (
            <div
              key={s.label}
              className="bg-surface border border-border rounded-lg p-4 flex flex-col gap-1"
            >
              <span className="text-xs text-ink-3">{s.label}</span>
              <span className="text-2xl font-semibold text-ink">{s.value}</span>
            </div>
          ))}
        </div>

        {/* ── Charts ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

          {/* Posts by status — Pie */}
          <div className="bg-surface border border-border rounded-lg p-4">
            <h2 className="text-sm font-semibold text-ink mb-4">Posts by Status</h2>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={55}
                  outerRadius={90}
                  paddingAngle={2}
                  dataKey="value"
                  label={({ name, percent }: { name?: string; percent?: number }) =>
                    `${name ?? ""} ${((percent ?? 0) * 100).toFixed(0)}%`
                  }
                  labelLine={false}
                >
                  {pieData.map((entry, index) => (
                    <Cell key={index} fill={statusColor(entry.name)} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: "var(--color-surface, #fff)",
                    border: "1px solid var(--color-border, #e5e7eb)",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Posts by format — Bar */}
          <div className="bg-surface border border-border rounded-lg p-4">
            <h2 className="text-sm font-semibold text-ink mb-4">Posts by Format</h2>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={barData} barCategoryGap="30%">
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 11, fill: "currentColor" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "currentColor" }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-surface, #fff)",
                    border: "1px solid var(--color-border, #e5e7eb)",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="value" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* ── Project summaries table ── */}
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-rule">
            <h2 className="text-sm font-semibold text-ink">Projects</h2>
          </div>
          {projectSummaries.length === 0 ? (
            <div className="px-4 py-6 text-sm text-ink-3 text-center">No projects yet.</div>
          ) : (
            <div>
              {/* Header */}
              <div className="grid grid-cols-[1fr_64px_72px_160px] gap-3 px-4 py-2 border-b border-rule text-xs text-ink-3 font-medium">
                <span>Project</span>
                <span className="text-right">Posts</span>
                <span className="text-right">Pending</span>
                <span>Health</span>
              </div>
              {/* Rows */}
              {projectSummaries.map((p) => (
                <div
                  key={p.projectId}
                  className="grid grid-cols-[1fr_64px_72px_160px] gap-3 px-4 py-3 border-b border-rule last:border-b-0 items-center"
                >
                  <span className="text-sm text-ink truncate">{p.name}</span>
                  <span className="text-sm text-ink text-right">{p.postCount}</span>
                  <span className="text-sm text-ink-3 text-right">{p.pendingCount}</span>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full ${healthColor(p.healthScore)} rounded-full`}
                        style={{ width: `${p.healthScore ?? 0}%` }}
                      />
                    </div>
                    <span className="text-xs text-ink-3 w-8 text-right shrink-0">
                      {p.healthScore != null ? `${p.healthScore}%` : "—"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </>
  );
}
