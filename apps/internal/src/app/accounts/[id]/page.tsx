"use client";
import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAccount, useAccountLinkStats } from "@/lib/hooks/use-accounts";
import { useAccountGrowth } from "@/lib/hooks/use-growth";
import { apiFetch } from "@/lib/api";
import { Pencil, Trash2, Search, BarChart2, ChevronDown, X, Users, Link2, TrendingUp, TrendingDown } from "lucide-react";
import Link from "next/link";
import { BoxesLoader } from "@/components/boxes-loader";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from "recharts";

function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
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
    <div className="bg-ds-inset border border-ds-line2 text-ds-t5 text-[11px] rounded-[6px] px-3 py-2 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
      <p className="font-semibold text-ds-text mb-0.5">{label}</p>
      <p>{payload[0].value} links</p>
    </div>
  );
}

function FollowerTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-ds-inset border border-ds-line2 text-ds-t5 text-[11px] rounded-[6px] px-3 py-2 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
      <p className="font-semibold text-ds-text mb-0.5">{label}</p>
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

  if (isLoading) return <div className="flex items-center justify-center h-64"><BoxesLoader /></div>;
  const account = (data as any)?.data;
  if (!account) return <div className="text-[12.5px] text-ds-t3 text-center py-12">Account not found</div>;

  const activeAssignments = account.assignments?.filter((a: any) => !a.unassignedAt) || [];
  const pastAssignments = account.assignments?.filter((a: any) => a.unassignedAt) || [];

  const statusBadge: Record<string, string> = {
    ACTIVE: "bg-ds-teal/10 border-ds-teal/30 text-ds-teal",
    PAUSED: "bg-ds-gold/10 border-ds-gold/30 text-ds-gold",
    ARCHIVED: "bg-ds-t3/10 border-ds-t3/30 text-ds-t3",
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
    <div className="max-w-3xl space-y-3.5 pb-6 crx-animate-fade">
      {/* Header */}
      <section className="flex items-start justify-between gap-4 flex-wrap pt-[26px] pb-1.5">
        <div className="min-w-0">
          <h1 className="m-0 text-[26px] font-semibold tracking-[-.02em] text-ds-text">{account.displayName}</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">{account.handle} on {account.platform?.name}</p>
          <div className="flex gap-2 mt-3">
            <span className={`inline-flex items-center h-[22px] px-2.5 rounded-[11px] border text-[10.5px] font-semibold ${statusBadge[account.status] || "bg-ds-t3/10 border-ds-t3/30 text-ds-t3"}`}>{account.status}</span>
            <span className="inline-flex items-center h-[22px] px-2.5 rounded-[11px] border text-[10.5px] font-semibold bg-ds-blue/10 border-ds-blue/30 text-ds-blue">{account.followerCount?.toLocaleString()} followers</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => router.push(`/accounts/${id}/edit`)}
            className="h-[34px] px-3.5 rounded-[6px] border border-ds-line2 bg-ds-card text-ds-t5 text-[12px] font-semibold inline-flex items-center gap-1.5 whitespace-nowrap transition-colors hover:border-ds-gold/55 hover:text-ds-gold"
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="h-[34px] px-3.5 rounded-[6px] border border-ds-line2 bg-ds-card text-ds-t5 text-[12px] font-semibold inline-flex items-center gap-1.5 whitespace-nowrap transition-colors hover:border-ds-red/50 hover:text-ds-redsoft"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
          <button onClick={() => router.push("/accounts")} className="h-[34px] px-3.5 rounded-[6px] border border-ds-line2 bg-ds-card text-ds-t5 text-[12px] font-semibold inline-flex items-center gap-1.5 whitespace-nowrap transition-colors hover:border-ds-line4 hover:text-ds-text">Back</button>
        </div>
      </section>

      {account.clientName && (
        <div className="rounded-[10px] bg-ds-card border border-ds-line px-5 py-4 crx-animate-slide crx-delay-1">
          <span className="text-[12.5px] text-ds-t3">Client:</span>{" "}
          <span className="text-[12.5px] font-semibold text-ds-text">{account.clientName}</span>
        </div>
      )}

      {/* Active assignments */}
      <div className="rounded-[10px] bg-ds-card border border-ds-line crx-animate-slide crx-delay-2">
        <div className="px-5 py-3.5 border-b border-ds-line">
          <h3 className="text-[14px] font-semibold text-ds-text">Active Assignments ({activeAssignments.length})</h3>
        </div>
        <div className="px-5 py-4 space-y-3">
          {activeAssignments.map((a: any) => (
            <div key={a.id} className="flex items-center justify-between gap-3 border-b border-ds-grid pb-3 last:border-0">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-full border border-ds-line2 bg-[color:var(--hx-10222E)] text-ds-blue grid place-items-center text-[12px] font-bold shrink-0">
                  {a.employee?.name?.[0]?.toUpperCase()}
                </div>
                <div>
                  <span className="font-semibold text-[12.5px] text-ds-text">{a.employee?.name}</span>
                  <span className="text-[11px] text-ds-t3 ml-2">since {new Date(a.assignedAt).toLocaleDateString()}</span>
                  {a.reason && <p className="text-[11.5px] text-ds-t2">{a.reason}</p>}
                </div>
              </div>
              <button onClick={() => handleUnassign(a.employee.id)} className="h-[26px] px-2.5 rounded-[6px] bg-ds-hover border border-ds-line2 text-ds-t5 text-[11px] font-semibold transition-colors hover:border-ds-red/50 hover:text-ds-redsoft shrink-0">Remove</button>
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-ds-t3 pointer-events-none" />
              <input
                type="text"
                value={empOpen ? empSearch : (employees.find((e: any) => e.id === selectedEmployee)?.name || empSearch)}
                onChange={(e) => { setEmpSearch(e.target.value); setEmpOpen(true); if (selectedEmployee) setSelectedEmployee(""); }}
                onFocus={() => { setEmpOpen(true); setEmpSearch(""); }}
                onBlur={() => setTimeout(() => setEmpOpen(false), 150)}
                placeholder={`Search ${employees.length} employees…`}
                className="w-full h-9 rounded-[6px] border border-ds-line2 bg-ds-inset pl-9 pr-3 text-ds-text text-[16px] sm:text-[12.5px] placeholder:text-ds-t4 outline-none transition-colors focus:border-ds-gold"
                autoComplete="off"
              />
              {empOpen && (() => {
                const available = employees.filter((emp: any) => !activeAssignments.some((a: any) => a.employee?.id === emp.id));
                const q = empSearch.trim().toLowerCase();
                const filtered = q ? available.filter((e: any) => (e.name || "").toLowerCase().includes(q) || (e.email || "").toLowerCase().includes(q)) : available;
                return (
                  <div className="absolute z-10 mt-1 w-full max-h-60 overflow-y-auto bg-ds-card border border-ds-line2 rounded-[8px] shadow-[0_14px_36px_rgba(0,0,0,.5)]">
                    {filtered.length === 0 ? (
                      <div className="px-4 py-3 text-[12.5px] text-ds-t3">{q ? `No employees match "${empSearch}"` : "All employees are already assigned"}</div>
                    ) : (
                      filtered.map((e: any) => (
                        <button
                          key={e.id}
                          type="button"
                          onMouseDown={(ev) => { ev.preventDefault(); setSelectedEmployee(e.id); setEmpSearch(""); setEmpOpen(false); }}
                          className={`w-full text-left px-4 py-2 text-[12.5px] hover:bg-ds-hover transition-colors flex items-center justify-between ${selectedEmployee === e.id ? "bg-ds-gold/[.14]" : ""}`}
                        >
                          <span className="text-ds-text">{e.name}</span>
                          {e.email && <span className="text-[11px] text-ds-t3 ml-2 truncate">{e.email}</span>}
                        </button>
                      ))
                    )}
                  </div>
                );
              })()}
            </div>
            <button onClick={handleAssign} disabled={!selectedEmployee || assigning} className="h-9 px-[18px] rounded-[6px] bg-ds-gold text-ds-bg text-[12px] font-bold inline-flex items-center gap-1.5 transition-colors hover:bg-ds-gold2 disabled:opacity-50">
              {assigning ? "..." : "Assign"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Link Statistics ─────────────────────────────────────────────────── */}
      <div className="rounded-[10px] bg-ds-card border border-ds-line p-5 space-y-4">
        {/* Section header + date range controls */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-ds-gold" />
            <p className="text-[14px] font-semibold text-ds-text">Link Statistics</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Preset chips */}
            <div className="flex gap-0.5 p-0.5 rounded-[15px] bg-ds-inset border border-ds-line">
              {DATE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => {
                    setStatsStartDate(new Date(today.getTime() - p.days * 86400000).toISOString().slice(0, 10));
                    setStatsEndDate(todayStr);
                  }}
                  className={`h-[26px] px-3 rounded-[13px] text-[11px] font-semibold whitespace-nowrap transition-colors ${
                    activePreset === p.label
                      ? "bg-ds-blue text-white"
                      : "text-ds-t2 hover:text-ds-text"
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
              className="h-[30px] rounded-[6px] border border-ds-line2 bg-ds-inset text-ds-text text-[12px] px-2 outline-none transition-colors focus:border-ds-gold [color-scheme:dark]"
            />
            <span className="text-[12px] text-ds-t3">→</span>
            <input
              type="date"
              value={statsEndDate}
              onChange={(e) => setStatsEndDate(e.target.value)}
              className="h-[30px] rounded-[6px] border border-ds-line2 bg-ds-inset text-ds-text text-[12px] px-2 outline-none transition-colors focus:border-ds-gold [color-scheme:dark]"
            />
          </div>
        </div>

        {statsLoading ? (
          <p className="text-xs text-ds-t3 py-4 text-center">Loading…</p>
        ) : !stats || stats.totalLinks === 0 ? (
          <div className="text-center py-6 space-y-1">
            <p className="text-sm text-ds-t3">No links submitted for this account in the selected range</p>
            <p className="text-xs text-ds-t3">Try a wider date range</p>
          </div>
        ) : (
          <>
            {/* KPI strip */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="rounded-[8px] bg-ds-inset border border-ds-line p-3 space-y-0.5">
                <div className="h-6 w-6 rounded-[6px] bg-ds-gold/[.13] flex items-center justify-center mb-1">
                  <Link2 className="h-3 w-3 text-ds-gold" />
                </div>
                <p className="text-xl font-semibold text-ds-text leading-none">{stats.totalLinks}</p>
                <p className="text-[10px] text-ds-t3">Total Links</p>
              </div>
              <div className="rounded-[8px] bg-ds-inset border border-ds-line p-3 space-y-0.5">
                <div className="h-6 w-6 rounded-[6px] bg-ds-blue/[.13] flex items-center justify-center mb-1">
                  <Users className="h-3 w-3 text-ds-blue" />
                </div>
                <p className="text-xl font-semibold text-ds-text leading-none">{employeeBreakdown.length}</p>
                <p className="text-[10px] text-ds-t3">Contributors</p>
              </div>
              <div className="rounded-[8px] bg-ds-inset border border-ds-line p-3 space-y-0.5">
                <div className="h-6 w-6 rounded-[6px] bg-ds-teal/[.13] flex items-center justify-center mb-1">
                  <BarChart2 className="h-3 w-3 text-ds-teal" />
                </div>
                <p className="text-xl font-semibold text-ds-text leading-none">
                  {dailyTrend.filter((d: any) => d.links > 0).length}
                </p>
                <p className="text-[10px] text-ds-t3">Active Days</p>
              </div>
            </div>

            {/* Daily trend chart */}
            <div>
              <p className="text-xs font-medium text-ds-t3 mb-2">Daily submission trend</p>
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyTrend} barSize={Math.max(4, Math.floor(320 / dailyTrend.length) - 2)} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--hx-14273A)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 9, fill: "var(--hx-738395)" }}
                      axisLine={false}
                      tickLine={false}
                      interval={Math.floor(dailyTrend.length / 6)}
                    />
                    <YAxis tick={{ fontSize: 9, fill: "var(--hx-738395)" }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip content={<BarTip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                    <Bar dataKey="links" fill="var(--hx-238BFF)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Per-employee breakdown */}
            <div>
              <p className="text-xs font-medium text-ds-t3 mb-2">Submitted by employee</p>
              <div className="space-y-2.5">
                {employeeBreakdown.map((emp: any) => (
                  <div key={emp.employeeId} className="flex items-center gap-3">
                    <div className="h-7 w-7 rounded-full border border-ds-line2 bg-[color:var(--hx-10222E)] text-ds-blue grid place-items-center text-[10px] font-bold shrink-0">
                      {emp.name?.[0]?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <Link
                          href={`/reports/${emp.employeeId}`}
                          className="text-[12px] font-semibold text-ds-text hover:text-ds-gold transition-colors truncate"
                        >
                          {emp.name}
                        </Link>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          <span className="text-[10px] text-ds-t3">{emp.reportCount} day{emp.reportCount !== 1 ? "s" : ""}</span>
                          <span className="text-[12px] font-semibold text-ds-text">{emp.totalLinks}</span>
                          <span className="text-[10px] text-ds-t3 w-8 text-right">{emp.pct}%</span>
                        </div>
                      </div>
                      <div className="h-1.5 rounded-full bg-ds-hover overflow-hidden">
                        <div
                          className="h-full rounded-full bg-ds-blue transition-all duration-500"
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
      <div className="rounded-[10px] bg-ds-card border border-ds-line p-5 space-y-4">
        {/* Section header + window pills */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-ds-gold" />
            <p className="text-[14px] font-semibold text-ds-text">Follower Growth</p>
          </div>
          <div className="flex items-center gap-1.5">
            {GROWTH_WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setGrowthDays(w)}
                className={`h-[26px] px-[11px] rounded-[13px] border text-[11px] font-semibold whitespace-nowrap transition-colors ${
                  growthDays === w
                    ? "border-ds-gold/55 bg-ds-gold/[.14] text-ds-text"
                    : "border-ds-line2 bg-ds-inset text-ds-t2 hover:text-ds-text"
                }`}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>

        {growthLoading ? (
          <p className="text-xs text-ds-t3 py-4 text-center">Loading…</p>
        ) : growthSnapshots.length < 2 ? (
          <div className="text-center py-6 space-y-1">
            <p className="text-sm text-ds-t3">Not enough data yet — growth appears after a couple of daily syncs.</p>
          </div>
        ) : (
          <>
            {/* Current count + window delta */}
            <div className="flex items-end gap-4 flex-wrap">
              <div>
                <p className="text-[26px] font-semibold tracking-[-.02em] text-ds-text leading-none">{fmtCompact(growthLast)}</p>
                <p className="text-[10px] text-ds-t3 mt-1">current followers</p>
              </div>
              <span className={`inline-flex items-center gap-1 text-sm font-semibold pb-0.5 ${growthUp ? "text-ds-teal" : growthDown ? "text-ds-redsoft" : "text-ds-t3"}`}>
                {growthUp && <TrendingUp className="h-4 w-4 shrink-0" />}
                {growthDown && <TrendingDown className="h-4 w-4 shrink-0" />}
                {(growthDelta ?? 0) > 0 ? "+" : ""}{fmtCompact(growthDelta)}
                {growthPct != null && (
                  <span className="text-ds-t3 font-normal">({(growthDelta ?? 0) > 0 ? "+" : ""}{growthPct}%) · {growthDays}d</span>
                )}
              </span>
            </div>

            {/* Follower trend chart */}
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={growthChart} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                  <defs>
                    <linearGradient id="followerGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--hx-E9BD62)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--hx-E9BD62)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--hx-14273A)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 9, fill: "var(--hx-738395)" }}
                    axisLine={false}
                    tickLine={false}
                    interval={Math.max(0, Math.ceil(growthChart.length / 8) - 1)}
                  />
                  <YAxis tick={{ fontSize: 9, fill: "var(--hx-738395)" }} axisLine={false} tickLine={false} allowDecimals={false} domain={["auto", "auto"]} />
                  <Tooltip content={<FollowerTip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                  <Area type="monotone" dataKey="followers" name="Followers" stroke="var(--hx-E9BD62)" fill="url(#followerGrad)" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(2,6,10,.7)]" onClick={() => !deleting && setShowDeleteConfirm(false)}>
          <div role="dialog" aria-modal="true" aria-label="Delete account" className="w-full max-w-[400px] rounded-[10px] border border-ds-line2 bg-ds-card p-[22px] shadow-[0_20px_50px_rgba(0,0,0,.6)]" onClick={(e) => e.stopPropagation()}>
            <div>
              <div className="flex items-start gap-3.5">
                <span className="h-10 w-10 rounded-[10px] grid place-items-center shrink-0 bg-ds-red/[.14] text-ds-redsoft">
                  <Trash2 className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-ds-text">Delete account?</p>
                  <p className="text-[12px] text-ds-t2 mt-1.5 leading-relaxed">
                    This will permanently delete <strong className="text-ds-text">{account.displayName}</strong> ({account.handle}). If the account has tasks, posts, or report links, you'll need to archive it instead.
                  </p>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="h-[34px] px-3.5 rounded-[6px] border border-ds-line2 bg-transparent text-ds-t2 text-[12px] font-semibold transition-colors hover:border-ds-line4 hover:text-ds-text disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="h-[34px] px-4 rounded-[6px] bg-ds-red text-white text-[12px] font-bold transition-colors hover:bg-ds-red/90 disabled:opacity-50"
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Past assignments */}
      {pastAssignments.length > 0 && (
        <div className="rounded-[10px] bg-ds-card border border-ds-line crx-animate-slide crx-delay-3">
          <div className="px-5 py-3.5 border-b border-ds-line">
            <h3 className="text-[14px] font-semibold text-ds-text">Assignment History</h3>
          </div>
          <div className="px-5 py-4">
            {pastAssignments.map((a: any) => (
              <div key={a.id} className="text-[12.5px] border-b border-ds-grid pb-2 mb-2 last:border-0 last:mb-0 last:pb-0">
                <span className="font-semibold text-ds-text">{a.employee?.name}</span>
                <span className="text-ds-t2 ml-2">
                  {new Date(a.assignedAt).toLocaleDateString()} &mdash; {new Date(a.unassignedAt).toLocaleDateString()}
                </span>
                {a.assigner && <span className="text-[11px] text-ds-t3 ml-2">by {a.assigner.name}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
