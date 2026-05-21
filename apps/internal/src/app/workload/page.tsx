"use client";
import { useWorkload } from "@/lib/hooks/use-accounts";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { PlatformIcon } from "@/lib/platform-icon";

export default function WorkloadPage() {
  usePageTitle("Workload");
  const { data, isLoading } = useWorkload();
  const employees = (data as any)?.data || [];

  return (
    <div className="space-y-6 crx-animate-fade">
      <div>
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Workload Matrix</h1>
        <p className="text-[#7A7A7A] mt-1">Employee account assignments and open task load at a glance.</p>
      </div>

      {isLoading ? (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] divide-y divide-[#F0EAD8]">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-4 animate-pulse">
              <div className="h-7 w-7 rounded-full bg-[#F0EAD8] shrink-0" />
              <div className="h-4 w-28 rounded bg-[#F0EAD8]" />
              <div className="h-4 w-16 rounded bg-[#F0EAD8] ml-4" />
              <div className="ml-auto flex gap-3">
                <div className="h-4 w-8 rounded bg-[#F0EAD8]" />
                <div className="h-4 w-8 rounded bg-[#F0EAD8]" />
                <div className="h-4 w-8 rounded bg-[#F0EAD8]" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-1">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F0EAD8]">
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Employee</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Team</th>
                  <th className="text-center p-4 text-[#7A7A7A] text-xs font-medium">Accounts</th>
                  <th className="text-center p-4 text-[#7A7A7A] text-xs font-medium">Open Tasks</th>
                  <th className="text-center p-4 text-[#7A7A7A] text-xs font-medium">Critical</th>
                  <th className="text-center p-4 text-[#7A7A7A] text-xs font-medium">High</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Assigned Accounts</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((emp: any) => {
                  const load = emp.accountCount + emp.openTaskCount;
                  const loadColor = load > 15 ? "text-[#E74C3C] font-semibold" : load > 8 ? "text-[#F5A623]" : "text-[#6BCB77]";
                  return (
                    <tr key={emp.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-7 w-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
                            style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
                          >
                            {emp.name?.[0]?.toUpperCase()}
                          </div>
                          <span className="font-medium text-[#1A1A1A]">{emp.name}</span>
                        </div>
                      </td>
                      <td className="p-4 text-[#7A7A7A]">{emp.team?.name || "\u2014"}</td>
                      <td className={`p-4 text-center ${loadColor}`}>{emp.accountCount}</td>
                      <td className="p-4 text-center text-[#1A1A1A]">{emp.openTaskCount}</td>
                      <td className="p-4 text-center">
                        {emp.tasksByPriority.critical > 0
                          ? <span className="rounded-full px-3 py-1 text-xs font-medium bg-[rgba(231,76,60,0.1)] text-[#E74C3C]">{emp.tasksByPriority.critical}</span>
                          : <span className="text-sm text-[#B0B0B0]">—</span>}
                      </td>
                      <td className="p-4 text-center">
                        {emp.tasksByPriority.high > 0
                          ? <span className="rounded-full px-3 py-1 text-xs font-medium bg-[rgba(245,166,35,0.12)] text-[#F5A623]">{emp.tasksByPriority.high}</span>
                          : <span className="text-sm text-[#B0B0B0]">—</span>}
                      </td>
                      <td className="p-4">
                        <div className="flex flex-wrap gap-1">
                          {emp.accounts?.slice(0, 5).map((acc: any) => (
                            <span key={acc.id} title={acc.platform?.name} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium bg-[#FFF3C4] text-[#1A1A1A]">
                              <PlatformIcon slug={acc.platform?.slug} className="h-3 w-3 shrink-0" />
                              {acc.handle}
                            </span>
                          ))}
                          {emp.accounts?.length > 5 && (
                            <span className="rounded-full px-3 py-1 text-xs font-medium bg-[#FFF3C4] text-[#1A1A1A]">+{emp.accounts.length - 5}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
