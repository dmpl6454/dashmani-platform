"use client";
import { useState } from "react";
import Link from "next/link";
import { useEmployees } from "@/lib/hooks/use-employees";
import { Button, Input } from "@dashmani/ui";
import { Plus, Search, BarChart3, Users } from "lucide-react";
import { API_BASE } from "@/lib/api";
import { getRoleColor } from "@/lib/role-colors";

const STATUS_CONFIG: Record<string, { dot: string; badge: string; label: string }> = {
  ACTIVE: { dot: "bg-emerald-500", badge: "bg-emerald-50 text-emerald-700", label: "Active" },
  ONBOARDING: { dot: "bg-amber-500", badge: "bg-amber-50 text-amber-700", label: "Onboarding" },
  INACTIVE: { dot: "bg-gray-400", badge: "bg-gray-50 text-gray-500", label: "Inactive" },
};

const AVATAR_GRADIENTS = [
  "linear-gradient(135deg, #667eea, #764ba2)",
  "linear-gradient(135deg, #f093fb, #f5576c)",
  "linear-gradient(135deg, #4facfe, #00f2fe)",
  "linear-gradient(135deg, #43e97b, #38f9d7)",
  "linear-gradient(135deg, #fa709a, #fee140)",
  "linear-gradient(135deg, #a18cd1, #fbc2eb)",
  "linear-gradient(135deg, #fccb90, #d57eeb)",
  "linear-gradient(135deg, #e0c3fc, #8ec5fc)",
];

function getAvatarGradient(name: string) {
  let hash = 0;
  for (let i = 0; i < (name || "").length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

export default function EmployeesPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const { data, isLoading } = useEmployees({ search });
  const allEmployees = (data as any)?.data || [];

  const employees = statusFilter === "ALL"
    ? allEmployees
    : allEmployees.filter((emp: any) => emp.status === statusFilter);

  const statusCounts: Record<string, number> = { ALL: allEmployees.length };
  allEmployees.forEach((emp: any) => {
    statusCounts[emp.status] = (statusCounts[emp.status] || 0) + 1;
  });

  const filterPills = [
    { key: "ALL", label: "All" },
    { key: "ACTIVE", label: "Active" },
    { key: "ONBOARDING", label: "Onboarding" },
    { key: "INACTIVE", label: "Inactive" },
  ];

  return (
    <div className="space-y-6 crx-animate-fade">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Employees</h1>
          {!isLoading && (
            <p className="text-sm text-[#7A7A7A] mt-1 flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              {allEmployees.length} employee{allEmployees.length !== 1 ? "s" : ""} total
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Link href="/employees/add-admin">
            <Button variant="outline" className="rounded-full border-[#F0EAD8] text-[#7A7A7A] hover:border-[#E8D8B4] hover:text-[#1A1A1A] transition-all">
              <Plus className="h-4 w-4 mr-2" /> Add Admin
            </Button>
          </Link>
          <Link href="/employees/new">
            <Button className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B] shadow-md hover:shadow-lg transition-all">
              <Plus className="h-4 w-4 mr-2" /> Add Employee
            </Button>
          </Link>
        </div>
      </div>

      {/* Search + Filters */}
      <div className="space-y-3 crx-animate-slide crx-delay-1">
        <div className="relative max-w-md">
          <div className="absolute left-4 top-1/2 -translate-y-1/2 h-8 w-8 rounded-lg bg-[#FFF8E1] flex items-center justify-center">
            <Search className="h-4 w-4 text-[#B0B0B0]" />
          </div>
          <Input
            placeholder="Search by name, email, or role..."
            className="pl-14 h-12 bg-white/70 backdrop-blur-sm border border-[#E8E0D0] rounded-xl focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] shadow-[0_2px_8px_rgba(0,0,0,0.03)] text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {filterPills.map((pill) => (
            <button
              key={pill.key}
              onClick={() => setStatusFilter(pill.key)}
              className={`px-4 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 border ${
                statusFilter === pill.key
                  ? "bg-[#1A1A1A] text-white border-[#1A1A1A] shadow-md"
                  : "bg-white text-[#7A7A7A] border-[#E8E0D0] hover:border-[#B0B0B0] hover:text-[#1A1A1A]"
              }`}
            >
              {pill.label}
              {statusCounts[pill.key] !== undefined && (
                <span className={`ml-1.5 ${statusFilter === pill.key ? "text-white/70" : "text-[#B0B0B0]"}`}>
                  {statusCounts[pill.key] || 0}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-2">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0EAD8]">
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Name</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Email</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Roles</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Team</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
                <th className="text-center p-4 text-[#7A7A7A] text-xs font-medium">Performance</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="p-8 text-center text-[#7A7A7A]">
                  <div className="flex items-center justify-center gap-2">
                    <svg className="animate-spin h-4 w-4 text-[#F5D547]" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                    Loading employees...
                  </div>
                </td></tr>
              ) : employees.length === 0 ? (
                <tr><td colSpan={6} className="p-8 text-center text-[#7A7A7A]">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="h-8 w-8 text-[#E8E0D0]" />
                    <span>No employees found</span>
                  </div>
                </td></tr>
              ) : (
                employees.map((emp: any) => {
                  const statusCfg = STATUS_CONFIG[emp.status] || STATUS_CONFIG.INACTIVE;
                  return (
                    <tr key={emp.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors group">
                      <td className="p-4">
                        <Link href={`/employees/${emp.id}`} className="flex items-center gap-3">
                          {emp.profileImageUrl ? (
                            <img
                              src={emp.profileImageUrl.startsWith("http") ? emp.profileImageUrl : `${API_BASE}${emp.profileImageUrl}`}
                              alt={emp.name}
                              className="h-9 w-9 rounded-full object-cover shrink-0 ring-2 ring-white shadow-sm"
                              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; (e.target as HTMLImageElement).nextElementSibling && ((e.target as HTMLImageElement).nextElementSibling as HTMLElement).style.removeProperty("display"); }}
                            />
                          ) : null}
                          <div
                            className="h-9 w-9 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0 ring-2 ring-white shadow-sm"
                            style={{ background: getAvatarGradient(emp.name), display: emp.profileImageUrl ? "none" : undefined }}
                          >
                            {emp.name?.[0]?.toUpperCase()}
                          </div>
                          <span className="text-[#1A1A1A] group-hover:text-[#F5D547] font-medium transition-colors">{emp.name}</span>
                        </Link>
                      </td>
                      <td className="p-4 text-[#7A7A7A]">{emp.email}</td>
                      <td className="p-4">
                        <div className="flex gap-1 flex-wrap">
                          {emp.roles?.map((r: any) => (
                            <span key={r.id} className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium border ${getRoleColor(r.name)}`}>{r.name}</span>
                          ))}
                        </div>
                      </td>
                      <td className="p-4 text-[#7A7A7A]">{emp.orgUnit?.name || "\u2014"}</td>
                      <td className="p-4">
                        <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${statusCfg.badge}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${statusCfg.dot}`} />
                          {statusCfg.label}
                        </span>
                      </td>
                      <td className="p-4 text-center">
                        <Link
                          href={`/employees/${emp.id}/performance`}
                          className="inline-flex items-center gap-1.5 text-xs font-medium text-[#1A1A1A] hover:text-[#F5D547] bg-[#FFF8E1] hover:bg-[#FFF3C4] px-3 py-1.5 rounded-full transition-all hover:shadow-sm"
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
