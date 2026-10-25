"use client";
// Employees — premium dark redesign ("ds"), built to the Employees.dc.html mockup.
// UI only: same endpoint (/employees), same filters, same links as before.
import { useState } from "react";
import Link from "next/link";
import { Users, CheckSquare, UserPlus, Clock, Search, BarChart3, Plus } from "lucide-react";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { useEmployees } from "@/lib/hooks/use-employees";
import { API_BASE } from "@/lib/api";
import { toTitleCase } from "@dashmani/shared";

type ViewTab = "active" | "archived";
type StatusKey = "ALL" | "ACTIVE" | "ONBOARDING" | "INACTIVE";

const STATUS: Record<string, { label: string; color: string }> = {
  ACTIVE: { label: "Active", color: "var(--hx-00D7A0)" },
  ONBOARDING: { label: "Onboarding", color: "var(--hx-FBBF24)" },
  INACTIVE: { label: "Inactive", color: "var(--hx-738395)" },
};
// Role chip colours (mockup palette, mapped onto the portal's real roles).
const ROLE_COLOR: Record<string, string> = {
  "Super Admin": "var(--hx-E9BD62)", Admin: "var(--hx-E9BD62)", "Team Lead": "var(--hx-9B7EDE)",
  "Senior Employee": "var(--hx-00D7A0)", Employee: "var(--hx-238BFF)", HR: "var(--hx-FB7185)", Designer: "var(--hx-EC42B7)", Editor: "var(--hx-00D7A0)",
};
const ROLE_FALLBACK = ["var(--hx-238BFF)", "var(--hx-00D7A0)", "var(--hx-9B7EDE)", "var(--hx-EC42B7)", "var(--hx-FB7185)"];
const AV_BG = ["var(--hx-10222E)", "var(--hx-0E2A22)", "var(--hx-1B1630)", "var(--hx-2A2410)", "var(--hx-2A1116)"];
const AV_FG = ["var(--hx-238BFF)", "var(--hx-34D399)", "var(--hx-9B7EDE)", "var(--hx-E9BD62)", "var(--hx-FB7185)"];

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h); return Math.abs(h); };
const rgba = (hex: string, a: number) => { if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const roleColor = (name: string) => ROLE_COLOR[name] ?? ROLE_FALLBACK[hash(name) % ROLE_FALLBACK.length];

const GRID = "grid [grid-template-columns:minmax(200px,1.6fr)_minmax(180px,1.4fr)_minmax(150px,1.2fr)_minmax(120px,1fr)_110px_80px] gap-3";

export default function EmployeesPage() {
  usePageTitle("Employees");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusKey>("ALL");
  const [viewTab, setViewTab] = useState<ViewTab>("active");

  const { data, isLoading, error } = useEmployees(
    viewTab === "archived" ? { search, includeDeleted: true, limit: 500 } : { search, limit: 500 },
  );
  // KPI cards always describe the active (non-archived) roster, independent of the search box.
  const { data: rosterData } = useEmployees({ limit: 500 });

  const allEmployees: any[] = (data as any)?.data || [];
  const totalCount: number = (data as any)?.meta?.total ?? allEmployees.length;
  const roster: any[] = (rosterData as any)?.data || [];
  const rosterTotal: number = (rosterData as any)?.meta?.total ?? roster.length;

  const employees = viewTab === "archived" || statusFilter === "ALL"
    ? allEmployees
    : allEmployees.filter((e) => e.status === statusFilter);

  const counts: Record<string, number> = { ALL: totalCount, ACTIVE: 0, ONBOARDING: 0, INACTIVE: 0 };
  allEmployees.forEach((e) => { counts[e.status] = (counts[e.status] || 0) + 1; });
  const rosterCount = (k: StatusKey) => (k === "ALL" ? rosterTotal : roster.filter((e) => e.status === k).length);

  const kpis: { key: StatusKey; label: string; icon: any; color: string; note: string }[] = [
    { key: "ALL", label: "Total Employees", icon: Users, color: "var(--hx-238BFF)", note: "on the portal" },
    { key: "ACTIVE", label: "Active", icon: CheckSquare, color: "var(--hx-00D7A0)", note: "can sign in" },
    { key: "ONBOARDING", label: "Onboarding", icon: UserPlus, color: "var(--hx-FBBF24)", note: "not yet active" },
    { key: "INACTIVE", label: "Inactive", icon: Clock, color: "var(--hx-A7B3C2)", note: "deactivated" },
  ];

  return (
    <div className="pb-6">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[26px] pb-5">
        <div>
          <h1 className="m-0 text-[26px] font-semibold tracking-[-.02em] text-ds-text">Employees</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">
            {isLoading ? "Loading…" : `${totalCount} ${viewTab === "archived" ? "archived" : "total"} · manage roles, teams and profiles`}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href="/employees/add-admin" className="inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-[6px] border border-ds-line2 bg-ds-card text-ds-t5 text-[12px] font-semibold whitespace-nowrap transition-colors hover:border-ds-line4 hover:text-ds-text">
            <Plus className="h-3.5 w-3.5" /> Add Admin
          </Link>
          <Link href="/employees/new" className="inline-flex items-center gap-1.5 h-[34px] px-4 rounded-[6px] border border-ds-gold bg-ds-gold/[.14] text-ds-gold text-[12px] font-semibold whitespace-nowrap transition-colors hover:bg-ds-gold/[.22] hover:text-ds-gold2">
            <Plus className="h-3.5 w-3.5" /> Add Employee
          </Link>
        </div>
      </section>

      {/* KPI cards — click to filter */}
      <section className="grid gap-2.5 sm:gap-3.5 grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => {
          const Icon = k.icon;
          const sel = viewTab === "active" && statusFilter === k.key;
          return (
            <button
              key={k.key}
              type="button"
              aria-pressed={sel}
              onClick={() => { setViewTab("active"); setStatusFilter(k.key); }}
              className="flex flex-col min-[480px]:flex-row gap-2.5 min-[480px]:gap-3.5 min-[480px]:items-center p-3 sm:p-4 rounded-[8px] border text-left text-ds-text transition-colors hover:border-ds-line3"
              style={{ background: sel ? "var(--hx-0A1621)" : "var(--hx-08131C)", borderColor: sel ? rgba(k.color, 0.5) : "var(--hx-182C39)" }}
            >
              <span className="h-10 w-10 rounded-[10px] grid place-items-center shrink-0" style={{ background: rgba(k.color, 0.13), color: k.color }}>
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] text-ds-t5">{k.label}</span>
                <span className="flex items-baseline gap-2 mt-1.5 whitespace-nowrap">
                  <span className="text-[26px] font-semibold tracking-[-.02em] leading-none">{rosterData ? rosterCount(k.key) : "—"}</span>
                  <span className="text-[11px] text-ds-t3 truncate">{k.note}</span>
                </span>
              </span>
            </button>
          );
        })}
      </section>

      {/* Table card */}
      <section className="mt-3.5 rounded-[8px] bg-ds-card border border-ds-line overflow-hidden">
        <div className="flex items-center gap-3 flex-wrap px-5 py-3.5 border-b border-ds-line">
          <div className="flex gap-0.5 p-0.5 rounded-[15px] bg-ds-inset border border-ds-line" role="group" aria-label="View">
            {(["active", "archived"] as ViewTab[]).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={viewTab === t}
                onClick={() => { setViewTab(t); setStatusFilter("ALL"); }}
                className={`h-[26px] px-3.5 rounded-[13px] text-[11px] font-semibold whitespace-nowrap transition-colors ${viewTab === t ? "bg-ds-blue text-white" : "text-ds-t2 hover:text-ds-text"}`}
              >
                {t === "active" ? "Active" : "Archived"}
              </button>
            ))}
          </div>

          {viewTab === "active" && (
            <div className="flex flex-wrap gap-1.5">
              {(["ALL", "ACTIVE", "ONBOARDING", "INACTIVE"] as StatusKey[]).map((k) => {
                const sel = statusFilter === k;
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={sel}
                    onClick={() => setStatusFilter(k)}
                    className={`inline-flex items-center gap-1.5 h-[26px] px-[11px] rounded-[13px] border text-[11px] font-semibold whitespace-nowrap transition-colors ${sel ? "border-ds-gold/55 bg-ds-gold/[.14] text-ds-text" : "border-ds-line2 bg-ds-inset text-ds-t2 hover:text-ds-text"}`}
                  >
                    {k === "ALL" ? "All" : STATUS[k].label}
                    <span className="text-ds-t3 font-medium">{isLoading ? "" : counts[k] ?? 0}</span>
                  </button>
                );
              })}
            </div>
          )}

          <label className="ml-auto flex items-center gap-2 h-8 px-3 rounded-[16px] bg-ds-inset border border-ds-line2 text-ds-t3 flex-[0_1_300px] min-w-[180px] w-full sm:w-auto">
            <Search className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email, or role…"
              aria-label="Search employees"
              className="flex-1 min-w-0 bg-transparent border-0 outline-none text-ds-text text-[12px] placeholder:text-ds-t3"
            />
          </label>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[820px]" role="table" aria-label="Employees">
            <div role="row" className={`${GRID} px-5 py-2.5 text-[10px] tracking-[.12em] uppercase text-ds-t3 font-semibold border-b border-ds-line bg-[color:var(--hx-0A1620)]`}>
              <span role="columnheader">Name</span><span role="columnheader">Email</span><span role="columnheader">Roles</span>
              <span role="columnheader">Team</span><span role="columnheader">Status</span><span role="columnheader" className="text-center">Perf.</span>
            </div>

            {isLoading ? (
              <div className="divide-y divide-ds-grid" aria-hidden="true">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className={`${GRID} items-center px-5 py-[11px]`}>
                    <span className="flex items-center gap-2.5"><span className="h-8 w-8 rounded-full bg-ds-hover motion-safe:animate-pulse" /><span className="h-3 w-28 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" /></span>
                    <span className="h-3 w-40 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                    <span className="h-5 w-20 rounded-full bg-ds-hover motion-safe:animate-pulse" />
                    <span className="h-3 w-24 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                    <span className="h-5 w-16 rounded-full bg-ds-hover motion-safe:animate-pulse" />
                    <span />
                  </div>
                ))}
              </div>
            ) : error && allEmployees.length === 0 ? (
              <div role="alert" className="px-5 py-12 text-center text-[12.5px] text-ds-t2">Couldn&apos;t load employees. Refresh the page to try again.</div>
            ) : employees.length === 0 ? (
              <div className="px-5 py-12 text-center text-[12.5px] text-ds-t3">No employees found</div>
            ) : (
              employees.map((emp) => {
                const st = STATUS[emp.status] ?? STATUS.INACTIVE;
                const h = hash(emp.name || "");
                const img = emp.profileImageUrl
                  ? (String(emp.profileImageUrl).startsWith("http") ? emp.profileImageUrl : `${API_BASE}${emp.profileImageUrl}`)
                  : null;
                return (
                  <div key={emp.id} role="row" className={`${GRID} items-center px-5 py-[11px] border-b border-ds-grid text-[12.5px] transition-colors hover:bg-[color:var(--hx-0B1824)]`}>
                    <Link href={`/employees/${emp.id}`} role="cell" className="flex items-center gap-2.5 min-w-0 text-ds-text hover:text-ds-gold">
                      {img ? (
                        <img src={img} alt="" className="h-8 w-8 rounded-full object-cover border border-ds-line2 shrink-0" />
                      ) : (
                        <span className="h-8 w-8 rounded-full border border-ds-line2 grid place-items-center text-[12px] font-bold shrink-0" style={{ background: AV_BG[h % 5], color: AV_FG[h % 5] }}>
                          {(emp.name || "?").charAt(0).toUpperCase()}
                        </span>
                      )}
                      <span className="font-semibold truncate">{toTitleCase(emp.name)}</span>
                    </Link>
                    <span role="cell" className="text-ds-t2 truncate" title={emp.email}>{emp.email}</span>
                    <span role="cell" className="flex flex-wrap gap-1">
                      {(emp.roles ?? []).map((r: any) => {
                        const c = roleColor(r.name);
                        return (
                          <span key={r.id} className="h-5 px-2 rounded-[10px] border text-[10.5px] font-semibold inline-flex items-center whitespace-nowrap" style={{ color: c, background: rgba(c, 0.1), borderColor: rgba(c, 0.3) }}>
                            {r.name}
                          </span>
                        );
                      })}
                    </span>
                    <span role="cell" className="text-ds-t2 truncate" title={emp.orgUnit?.name || undefined}>{emp.orgUnit?.name || "—"}</span>
                    <span role="cell">
                      <span className="inline-flex items-center gap-1.5 h-[22px] px-2.5 rounded-[11px] border text-[10.5px] font-semibold whitespace-nowrap" style={{ color: st.color, background: rgba(st.color, 0.1), borderColor: rgba(st.color, 0.28) }}>
                        <i className="h-1.5 w-1.5 rounded-full" style={{ background: st.color }} />
                        {st.label}
                      </span>
                    </span>
                    <span role="cell" className="text-center">
                      <Link href={`/employees/${emp.id}`} className="inline-flex items-center gap-[5px] h-[26px] px-2.5 rounded-[6px] bg-ds-hover border border-ds-line2 text-ds-t5 text-[11px] font-semibold transition-colors hover:border-ds-gold/55 hover:text-ds-gold">
                        <BarChart3 className="h-[11px] w-[11px]" strokeWidth={2} /> View
                      </Link>
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <div className="flex justify-between items-center px-5 py-3 text-[11px] text-ds-t3">
          <span>{isLoading ? "" : `Showing ${employees.length} of ${totalCount}`}</span>
          <span>Sorted by name</span>
        </div>
      </section>
    </div>
  );
}
