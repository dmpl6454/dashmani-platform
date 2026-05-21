"use client";
import { useState } from "react";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import Link from "next/link";
import { useEmployees } from "@/lib/hooks/use-employees";
import { Plus, Search, BarChart3, Users } from "lucide-react";
import { API_BASE } from "@/lib/api";
import { getRoleColor } from "@/lib/role-colors";
import { toTitleCase } from "@dashmani/shared";

const STATUS_CONFIG: Record<string, { dot: string; badge: string; label: string }> = {
  ACTIVE:     { dot: "bg-success",    badge: "bg-success-bg text-success",     label: "Active" },
  ONBOARDING: { dot: "bg-attention",  badge: "bg-attention-bg text-attention", label: "Onboarding" },
  INACTIVE:   { dot: "bg-ink-4",      badge: "bg-neutral-bg text-neutral",     label: "Inactive" },
};

function monogram(name: string) {
  return (name || "?").charAt(0).toUpperCase();
}
function avatarBg(name: string) {
  const colors = ["#EDEDFD","#EEF4ED","#FDF0EC","#FFF3C4","#FDECEA"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
}
function avatarText(name: string) {
  const colors = ["#5D5FEF","#4A7C52","#E07A5F","#C05826","#B83728"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return colors[Math.abs(h) % colors.length];
}

type ViewTab = "active" | "archived";

export default function EmployeesPage() {
  usePageTitle("Employees");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [viewTab, setViewTab] = useState<ViewTab>("active");

  const { data, isLoading } = useEmployees(
    viewTab === "archived"
      ? { search, includeDeleted: true, limit: 500 }
      : { search, limit: 500 }
  );
  const allEmployees = (data as any)?.data || [];
  const totalCount: number = (data as any)?.meta?.total ?? allEmployees.length;

  const employees = viewTab === "archived" || statusFilter === "ALL"
    ? allEmployees
    : allEmployees.filter((emp: any) => emp.status === statusFilter);

  const statusCounts: Record<string, number> = { ALL: totalCount };
  allEmployees.forEach((emp: any) => {
    statusCounts[emp.status] = (statusCounts[emp.status] || 0) + 1;
  });

  const filterPills = [
    { key: "ALL",       label: "All" },
    { key: "ACTIVE",    label: "Active" },
    { key: "ONBOARDING",label: "Onboarding" },
    { key: "INACTIVE",  label: "Inactive" },
  ];

  return (
    <div className="space-y-5 pop-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink">Employees</h1>
          {!isLoading && (
            <p className="text-sm text-ink-4 mt-0.5 flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              {totalCount} {viewTab === "archived" ? "archived" : "total"}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Link href="/employees/add-admin">
            <button className="h-9 px-4 rounded-full border-2 border-ink/15 text-sm font-semibold text-ink-3 hover:bg-muted transition-colors flex items-center gap-1.5">
              <Plus className="h-4 w-4" /> Add Admin
            </button>
          </Link>
          <Link href="/employees/new">
            <button className="h-9 px-4 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors flex items-center gap-1.5">
              <Plus className="h-4 w-4" /> Add Employee
            </button>
          </Link>
        </div>
      </div>

      {/* View tabs: Active / Archived */}
      <div className="flex gap-1 p-1 bg-muted rounded-xl w-fit fade-up d2">
        {(["active", "archived"] as ViewTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => { setViewTab(tab); setStatusFilter("ALL"); }}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
              viewTab === tab
                ? "bg-white shadow text-ink"
                : "text-ink-4 hover:text-ink"
            }`}
          >
            {tab === "active" ? "Active" : "Archived"}
          </button>
        ))}
      </div>

      {/* Search + Filters */}
      <div className="space-y-3 fade-up d3">
        <div className="relative max-w-md">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-4" />
          <input
            placeholder="Search by name, email, or role…"
            className="w-full pl-10 pr-4 h-10 bg-surface border-2 border-ink/15 rounded-xl text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:border-indigo transition-colors"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {viewTab === "active" && (
          <div className="flex gap-2 flex-wrap">
            {filterPills.map((pill) => (
              <button
                key={pill.key}
                onClick={() => setStatusFilter(pill.key)}
                className={`h-8 px-4 rounded-full text-xs font-bold transition-all border-2 ${
                  statusFilter === pill.key
                    ? "bg-ink text-white border-ink"
                    : "bg-surface text-ink-3 border-ink/12 hover:border-ink/25 hover:text-ink"
                }`}
              >
                {pill.label}
                {statusCounts[pill.key] !== undefined && (
                  <span className={`ml-1.5 ${statusFilter === pill.key ? "opacity-60" : "text-ink-4"}`}>
                    {statusCounts[pill.key] || 0}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="v3-card overflow-hidden fade-up d3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b-2 border-ink/8 bg-muted/40">
                <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider">Name</th>
                <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider hidden md:table-cell">Email</th>
                <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider">Roles</th>
                <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider hidden lg:table-cell">Team</th>
                <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider">Status</th>
                <th className="text-center px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider">Perf.</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {isLoading ? (
                <tr><td colSpan={6} className="py-14 text-center">
                  <div className="h-6 w-6 rounded-full border-[3px] border-ink/10 border-t-indigo mx-auto" style={{ animation: "spin 0.7s linear infinite" }} />
                </td></tr>
              ) : employees.length === 0 ? (
                <tr><td colSpan={6} className="py-14 text-center text-ink-4">
                  <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">No employees found</p>
                </td></tr>
              ) : (
                employees.map((emp: any, i: number) => {
                  const statusCfg = STATUS_CONFIG[emp.status] || STATUS_CONFIG.INACTIVE;
                  return (
                    <tr key={emp.id} className="v3-row" style={{ animationDelay: `${i * 0.03}s` }}>
                      <td className="px-5 py-3">
                        <Link href={`/employees/${emp.id}`} className="flex items-center gap-3">
                          {emp.profileImageUrl ? (
                            <img
                              src={emp.profileImageUrl.startsWith("http") ? emp.profileImageUrl : `${API_BASE}${emp.profileImageUrl}`}
                              alt={emp.name}
                              className="h-8 w-8 rounded-full object-cover border-2 border-ink shrink-0"
                            />
                          ) : (
                            <div
                              className="h-8 w-8 rounded-full border-2 border-ink flex items-center justify-center text-xs font-bold shrink-0"
                              style={{ background: avatarBg(emp.name || ""), color: avatarText(emp.name || "") }}
                            >
                              {monogram(emp.name || "")}
                            </div>
                          )}
                          <span className="font-semibold text-ink hover:text-indigo transition-colors">{toTitleCase(emp.name)}</span>
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-ink-3 hidden md:table-cell">{emp.email}</td>
                      <td className="px-5 py-3">
                        <div className="flex gap-1 flex-wrap">
                          {emp.roles?.map((r: any) => (
                            <span key={r.id} className={`rounded-full px-2.5 py-0.5 text-xs font-semibold border ${getRoleColor(r.name)}`}>{r.name}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-ink-3 hidden lg:table-cell">{emp.orgUnit?.name || "—"}</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border border-current/15 ${statusCfg.badge}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${statusCfg.dot}`} />
                          {statusCfg.label}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-center">
                        <Link
                          href={`/employees/${emp.id}`}
                          className="inline-flex items-center gap-1 text-xs font-bold text-ink hover:text-indigo bg-muted hover:bg-indigo-soft px-3 py-1.5 rounded-full transition-colors"
                        >
                          <BarChart3 className="h-3 w-3" /> View
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
