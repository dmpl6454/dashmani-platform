"use client";
import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAccount, useAccountLinkStats } from "@/lib/hooks/use-accounts";
import { useAccountGrowth } from "@/lib/hooks/use-growth";
import { Button } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";
import { Pencil, Trash2, Search, BarChart2, ChevronDown, X, Users, Link2, TrendingUp, TrendingDown } from "lucide-react";
import Link from "next/link";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from "recharts";

function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const GROWTH_WINDOWS = [7, 30, 90];

function fmtDate(d: string) {
  try { return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
  catch { return d; }
}

function BarTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-ink text-white text-xs rounded-lg px-3 py-2 shadow-lg">
      <p className="font-semibold mb-0.5">{label}</p>
      <p>{payload[0].value} links</p>
    </div>
  );
}

function FollowerTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-ink text-white text-xs rounded-lg px-3 py-2 shadow-lg">
      <p className="font-semibold mb-0.5">{label}</p>
      <p>{Number(payload[0].value).toLocaleString()} followers</p>
    </div>
  );
}

const DATE_PRESETS = [
  { label: "30d", days: 29 },
  { label: "90d", days: 89 },
  { label: "Year", days: 364 },
];

export default function AccountDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { data, isLoading, mutate } = useAccount(id as string);
  const [employees, setEmployees] = useState<any[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [empSearch, setEmpSearch] = useState("");
  const [empOpen, setEmpOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Link stats date range
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const [statsStartDate, setStatsStartDate] = useState(
    new Date(today.getTime() - 29 * 86400000).toISOString().slice(0, 10)
  );
  const [statsEndDate, setStatsEndDate] = useState(todayStr);
  const activePreset = DATE_PRESETS.find(
    (p) => statsStartDate === new Date(today.getTime() - p.days * 86400000).toISOString().slice(0, 10) && statsEndDate === todayStr
  )?.label ?? null;

  const { data: statsData, isLoading: statsLoading } = useAccountLinkStats(id as string, statsStartDate, statsEndDate);
  const stats = (statsData as any)?.data;

  // Follower growth (section-scoped window pills)
  const [growthDays, setGrowthDays] = useState(30);
  const { data: growthData, isLoading: growthLoading } = useAccountGrowth(id as string, growthDays);
  const growth = (growthData as any)?.data;
  const growthSnapshots: any[] = growth?.snapshots ?? [];
  const growthChart = growthSnapshots.map((s: any) => ({
    date: fmtDate(s.date),
    followers: s.followerCount,
  }));
  const growthFirst: number | null = growthSnapshots.length ? growthSnapshots[0].followerCount : null;
  const growthLast: number | null = growthSnapshots.length ? growthSnapshots[growthSnapshots.length - 1].followerCount : null;
  const growthDelta = growthFirst != null && growthLast != null ? growthLast - growthFirst : null;
  const growthPct = growthFirst != null && growthFirst > 0 && growthDelta != null
    ? Math.round((growthDelta / growthFirst) * 100)
    : null;
  const growthUp = (growthDelta ?? 0) > 0;
  const growthDown = (growthDelta ?? 0) < 0;

  const dailyTrend = (stats?.dailyTrend ?? []).map((x: any) => ({
    date: fmtDate(x.date),
    links: x.count,
  }));
  const employeeBreakdown: any[] = stats?.employeeBreakdown ?? [];

  useEffect(() => {
    apiFetch("/employees?status=ACTIVE&limit=500").then((res: any) => {
      const list = (res.data || []).slice().sort((a: any, b: any) =>
        (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
      );
      setEmployees(list);
    });
  }, []);

  if (isLoading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" /></div>;
  const account = (data as any)?.data;
  if (!account) return <div className="text-[#7A7A7A] text-center py-8">Account not found</div>;

  const activeAssignments = account.assignments?.filter((a: any) => !a.unassignedAt) || [];
  const pastAssignments = account.assignments?.filter((a: any) => a.unassignedAt) || [];

  const statusBadge: Record<string, string> = {
    ACTIVE: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
    PAUSED: "bg-[#FFF3C4] text-[#1A1A1A]",
    ARCHIVED: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
  };

  async function handleAssign() {
    if (!selectedEmployee) return;
    setAssigning(true);
    try {
      await apiFetch(`/accounts/${id}/assign`, { method: "POST", body: JSON.stringify({ employeeId: selectedEmployee }) });
      setSelectedEmployee("");
      mutate();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setAssigning(false);
    }
  }

  async function handleUnassign(employeeId: string) {
    try {
      await apiFetch(`/accounts/${id}/assign/${employeeId}`, { method: "DELETE" });
      mutate();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiFetch(`/accounts/${id}`, { method: "DELETE" });
      router.push("/accounts");
    } catch (err: any) {
      alert(err.message || "Failed to delete account");
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6 crx-animate-fade">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">{account.displayName}</h1>
          <p className="text-[#7A7A7A] mt-1">{account.handle} on {account.platform?.name}</p>
          <div className="flex gap-2 mt-3">
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge[account.status] || "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>{account.status}</span>
            <span className="rounded-full px-3 py-1 text-xs font-medium bg-[#FFF3C4] text-[#1A1A1A]">{account.followerCount?.toLocaleString()} followers</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => router.push(`/accounts/${id}/edit`)}
            className="flex items-center gap-1.5 border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[#F0EEFF] hover:border-[#5B4BF5]/30 hover:text-[#5B4BF5] px-4 py-2 text-sm font-medium transition-colors"
          >
            <Pencil className="h-4 w-4" /> Edit
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="flex items-center gap-1.5 border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-red-50 hover:border-red-200 hover:text-red-600 px-4 py-2 text-sm font-medium transition-colors"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
          <Button variant="outline" onClick={() => router.push("/accounts")} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">Back</Button>
        </div>
      </div>

      {account.clientName && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-6 crx-animate-slide crx-delay-1">
          <span className="text-sm text-[#7A7A7A]">Client:</span>{" "}
          <span className="font-medium text-[#1A1A1A]">{account.clientName}</span>
        </div>
      )}

      {/* Active assignments */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-2">
        <div className="px-6 py-4 border-b border-[#F0EAD8]">
          <h3 className="text-base font-serif text-[#1A1A1A] font-medium">Active Assignments ({activeAssignments.length})</h3>
        </div>
        <div className="p-6 space-y-3">
          {activeAssignments.map((a: any) => (
            <div key={a.id} className="flex items-center justify-between border-b border-[#F0EAD8] pb-2 last:border-0">
              <div className="flex items-center gap-3">
                <div
                  className="h-7 w-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
                  style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
                >
                  {a.employee?.name?.[0]?.toUpperCase()}
                </div>
                <div>
                  <span className="font-medium text-sm text-[#1A1A1A]">{a.employee?.name}</span>
                  <span className="text-xs text-[#B0B0B0] ml-2">since {new Date(a.assignedAt).toLocaleDateString()}</span>
                  {a.reason && <p className="text-xs text-[#7A7A7A]">{a.reason}</p>}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={() => handleUnassign(a.employee.id)} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">Remove</Button>
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#B0B0B0] pointer-events-none" />
              <input
                type="text"
                value={empOpen ? empSearch : (employees.find((e: any) => e.id === selectedEmployee)?.name || empSearch)}
                onChange={(e) => { setEmpSearch(e.target.value); setEmpOpen(true); if (selectedEmployee) setSelectedEmployee(""); }}
                onFocus={() => { setEmpOpen(true); setEmpSearch(""); }}
                onBlur={() => setTimeout(() => setEmpOpen(false), 150)}
                placeholder={`Search ${employees.length} employees…`}
                className="w-full h-10 rounded-lg border border-[#E8E0D0] bg-white pl-9 pr-3 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
                autoComplete="off"
              />
              {empOpen && (() => {
                const available = employees.filter((emp: any) => !activeAssignments.some((a: any) => a.employee?.id === emp.id));
                const q = empSearch.trim().toLowerCase();
                const filtered = q ? available.filter((e: any) => (e.name || "").toLowerCase().includes(q) || (e.email || "").toLowerCase().includes(q)) : available;
                return (
                  <div className="absolute z-10 mt-1 w-full max-h-60 overflow-y-auto bg-white border border-[#E8E0D0] rounded-lg shadow-lg">
                    {filtered.length === 0 ? (
                      <div className="px-4 py-3 text-sm text-[#7A7A7A]">{q ? `No employees match "${empSearch}"` : "All employees are already assigned"}</div>
                    ) : (
                      filtered.map((e: any) => (
                        <button
                          key={e.id}
                          type="button"
                          onMouseDown={(ev) => { ev.preventDefault(); setSelectedEmployee(e.id); setEmpSearch(""); setEmpOpen(false); }}
                          className={`w-full text-left px-4 py-2 text-sm hover:bg-[rgba(255,248,225,0.5)] transition-colors flex items-center justify-between ${selectedEmployee === e.id ? "bg-[#FFF3C4]" : ""}`}
                        >
                          <span className="text-[#1A1A1A]">{e.name}</span>
                          {e.email && <span className="text-xs text-[#B0B0B0] ml-2 truncate">{e.email}</span>}
                        </button>
                      ))
                    )}
                  </div>
                );
              })()}
            </div>
            <Button onClick={handleAssign} disabled={!selectedEmployee || assigning} className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">
              {assigning ? "..." : "Assign"}
            </Button>
          </div>
        </div>
      </div>

      {/* ── Link Statistics ─────────────────────────────────────────────────── */}
      <div className="v3-card p-5 space-y-4">
        {/* Section header + date range controls */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-indigo" />
            <p className="font-semibold text-ink">Link Statistics</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Preset chips */}
            <div className="flex items-center gap-1 bg-ink/5 rounded-xl p-1">
              {DATE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => {
                    setStatsStartDate(new Date(today.getTime() - p.days * 86400000).toISOString().slice(0, 10));
                    setStatsEndDate(todayStr);
                  }}
                  className={`h-6 px-2.5 rounded-lg text-xs font-medium transition-colors ${
                    activePreset === p.label
                      ? "bg-surface text-ink shadow-sm"
                      : "text-ink-4 hover:text-ink"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input
              type="date"
              value={statsStartDate}
              onChange={(e) => setStatsStartDate(e.target.value)}
              className="h-8 rounded-xl border-2 border-ink/15 bg-surface text-xs px-2 focus:outline-none focus:border-indigo"
            />
            <span className="text-xs text-ink-4">→</span>
            <input
              type="date"
              value={statsEndDate}
              onChange={(e) => setStatsEndDate(e.target.value)}
              className="h-8 rounded-xl border-2 border-ink/15 bg-surface text-xs px-2 focus:outline-none focus:border-indigo"
            />
          </div>
        </div>

        {statsLoading ? (
          <p className="text-xs text-ink-4 py-4 text-center">Loading…</p>
        ) : !stats || stats.totalLinks === 0 ? (
          <div className="text-center py-6 space-y-1">
            <p className="text-sm text-ink-4">No links submitted for this account in the selected range</p>
            <p className="text-xs text-ink-4">Try a wider date range</p>
          </div>
        ) : (
          <>
            {/* KPI strip */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="v3-card-sm p-3 space-y-0.5">
                <div className="h-6 w-6 rounded-lg bg-terra-soft flex items-center justify-center mb-1">
                  <Link2 className="h-3 w-3 text-terra" />
                </div>
                <p className="font-display text-xl font-semibold text-ink leading-none">{stats.totalLinks}</p>
                <p className="text-[10px] text-ink-4">Total Links</p>
              </div>
              <div className="v3-card-sm p-3 space-y-0.5">
                <div className="h-6 w-6 rounded-lg bg-indigo-soft flex items-center justify-center mb-1">
                  <Users className="h-3 w-3 text-indigo" />
                </div>
                <p className="font-display text-xl font-semibold text-ink leading-none">{employeeBreakdown.length}</p>
                <p className="text-[10px] text-ink-4">Contributors</p>
              </div>
              <div className="v3-card-sm p-3 space-y-0.5">
                <div className="h-6 w-6 rounded-lg bg-sage-soft flex items-center justify-center mb-1">
                  <BarChart2 className="h-3 w-3 text-sage" />
                </div>
                <p className="font-display text-xl font-semibold text-ink leading-none">
                  {dailyTrend.filter((d: any) => d.links > 0).length}
                </p>
                <p className="text-[10px] text-ink-4">Active Days</p>
              </div>
            </div>

            {/* Daily trend chart */}
            <div>
              <p className="text-xs font-medium text-ink-4 mb-2">Daily submission trend</p>
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyTrend} barSize={Math.max(4, Math.floor(320 / dailyTrend.length) - 2)} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 9, fill: "var(--color-ink-4,#888)" }}
                      axisLine={false}
                      tickLine={false}
                      interval={Math.floor(dailyTrend.length / 6)}
                    />
                    <YAxis tick={{ fontSize: 9, fill: "var(--color-ink-4,#888)" }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip content={<BarTip />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                    <Bar dataKey="links" fill="var(--color-terra,#c97c3a)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Per-employee breakdown */}
            <div>
              <p className="text-xs font-medium text-ink-4 mb-2">Submitted by employee</p>
              <div className="space-y-2.5">
                {employeeBreakdown.map((emp: any) => (
                  <div key={emp.employeeId} className="flex items-center gap-3">
                    <div
                      className="h-7 w-7 rounded-full flex items-center justify-center text-white text-[10px] font-semibold shrink-0"
                      style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
                    >
                      {emp.name?.[0]?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <Link
                          href={`/reports/${emp.employeeId}`}
                          className="text-xs font-medium text-ink hover:text-indigo transition-colors truncate"
                        >
                          {emp.name}
                        </Link>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          <span className="text-[10px] text-ink-4">{emp.reportCount} day{emp.reportCount !== 1 ? "s" : ""}</span>
                          <span className="text-xs font-semibold text-ink">{emp.totalLinks}</span>
                          <span className="text-[10px] text-ink-4 w-8 text-right">{emp.pct}%</span>
                        </div>
                      </div>
                      <div className="h-1.5 rounded-full bg-ink/8 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-indigo transition-all duration-500"
                          style={{ width: `${emp.pct}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Follower Growth ─────────────────────────────────────────────────── */}
      <div className="v3-card p-5 space-y-4">
        {/* Section header + window pills */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-indigo" />
            <p className="font-semibold text-ink">Follower Growth</p>
          </div>
          <div className="flex items-center gap-1.5">
            {GROWTH_WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setGrowthDays(w)}
                className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${
                  growthDays === w
                    ? "bg-[#1A1A1A] text-white border-[#1A1A1A]"
                    : "text-[#7A7A7A] border-[#E8E0D0] hover:border-[#1A1A1A]"
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>

        {growthLoading ? (
          <p className="text-xs text-ink-4 py-4 text-center">Loading…</p>
        ) : growthSnapshots.length < 2 ? (
          <div className="text-center py-6 space-y-1">
            <p className="text-sm text-ink-4">Not enough data yet — growth appears after a couple of daily syncs.</p>
          </div>
        ) : (
          <>
            {/* Current count + window delta */}
            <div className="flex items-end gap-4 flex-wrap">
              <div>
                <p className="font-display text-2xl font-semibold text-ink leading-none">{fmtCompact(growthLast)}</p>
                <p className="text-[10px] text-ink-4 mt-1">current followers</p>
              </div>
              <span className={`inline-flex items-center gap-1 text-sm font-semibold pb-0.5 ${growthUp ? "text-[#3E9B4F]" : growthDown ? "text-[#D14343]" : "text-ink-4"}`}>
                {growthUp && <TrendingUp className="h-4 w-4 shrink-0" />}
                {growthDown && <TrendingDown className="h-4 w-4 shrink-0" />}
                {(growthDelta ?? 0) > 0 ? "+" : ""}{fmtCompact(growthDelta)}
                {growthPct != null && (
                  <span className="text-ink-4 font-normal">({(growthDelta ?? 0) > 0 ? "+" : ""}{growthPct}%) · {growthDays}d</span>
                )}
              </span>
            </div>

            {/* Follower trend chart */}
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={growthChart} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                  <defs>
                    <linearGradient id="followerGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--color-indigo, #5b4bf5)" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="var(--color-indigo, #5b4bf5)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 9, fill: "var(--color-ink-4,#888)" }}
                    axisLine={false}
                    tickLine={false}
                    interval={Math.max(0, Math.ceil(growthChart.length / 8) - 1)}
                  />
                  <YAxis tick={{ fontSize: 9, fill: "var(--color-ink-4,#888)" }} axisLine={false} tickLine={false} allowDecimals={false} domain={["auto", "auto"]} />
                  <Tooltip content={<FollowerTip />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                  <Area type="monotone" dataKey="followers" name="Followers" stroke="var(--color-indigo,#5b4bf5)" fill="url(#followerGrad)" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => !deleting && setShowDeleteConfirm(false)}>
          <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_8px_40px_rgba(0,0,0,0.12)] w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5">
              <div className="flex items-start gap-4">
                <div className="h-10 w-10 rounded-xl bg-red-50 flex items-center justify-center shrink-0">
                  <Trash2 className="h-5 w-5 text-red-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-medium text-[#1A1A1A]">Delete account?</h3>
                  <p className="text-sm text-[#7A7A7A] mt-1">
                    This will permanently delete <strong>{account.displayName}</strong> ({account.handle}). If the account has tasks, posts, or report links, you'll need to archive it instead.
                  </p>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-[#F0EAD8] flex items-center justify-end gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="px-4 py-2 text-sm text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="px-4 py-2 bg-red-600 text-white rounded-full text-sm font-medium hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Past assignments */}
      {pastAssignments.length > 0 && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-3">
          <div className="px-6 py-4 border-b border-[#F0EAD8]">
            <h3 className="text-base font-serif text-[#1A1A1A] font-medium">Assignment History</h3>
          </div>
          <div className="p-6">
            {pastAssignments.map((a: any) => (
              <div key={a.id} className="text-sm border-b border-[#F0EAD8] pb-2 mb-2 last:border-0">
                <span className="font-medium text-[#1A1A1A]">{a.employee?.name}</span>
                <span className="text-[#7A7A7A] ml-2">
                  {new Date(a.assignedAt).toLocaleDateString()} &mdash; {new Date(a.unassignedAt).toLocaleDateString()}
                </span>
                {a.assigner && <span className="text-xs text-[#B0B0B0] ml-2">by {a.assigner.name}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
