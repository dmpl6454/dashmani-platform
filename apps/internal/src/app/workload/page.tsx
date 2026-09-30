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
        <h1 className="font-serif text-4xl font-light text-ink">Workload Matrix</h1>
        <p className="text-ink-3 mt-1">Employee account assignments and open task load at a glance.</p>
      </div>

      {isLoading ? (
        <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border divide-y divide-[#F0EAD8]">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 p-4 animate-pulse">
              <div className="h-7 w-7 rounded-full bg-muted shrink-0" />
              <div className="h-4 w-28 rounded bg-muted" />
              <div className="h-4 w-16 rounded bg-muted ml-4" />
              <div className="ml-auto flex gap-3">
                <div className="h-4 w-8 rounded bg-muted" />
                <div className="h-4 w-8 rounded bg-muted" />
                <div className="h-4 w-8 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border crx-animate-slide crx-delay-1">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left p-4 text-ink-3 text-xs font-medium">Employee</th>
                  <th className="text-left p-4 text-ink-3 text-xs font-medium">Team</th>
                  <th className="text-center p-4 text-ink-3 text-xs font-medium">Accounts</th>
                  <th className="text-center p-4 text-ink-3 text-xs font-medium">Open Tasks</th>
                  <th className="text-center p-4 text-ink-3 text-xs font-medium">Critical</th>
                  <th className="text-center p-4 text-ink-3 text-xs font-medium">High</th>
                  <th className="text-left p-4 text-ink-3 text-xs font-medium">Assigned Accounts</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((emp: any) => {
                  const load = emp.accountCount + emp.openTaskCount;
                  const loadColor = load > 15 ? "text-danger font-semibold" : load > 8 ? "text-gold" : "text-success";
                  return (
                    <tr key={emp.id} className="border-b border-border last:border-0 hover:bg-action/[0.06] transition-colors">
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-7 w-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
                            style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
                          >
                            {emp.name?.[0]?.toUpperCase()}
                          </div>
                          <span className="font-medium text-ink">{emp.name}</span>
                        </div>
                      </td>
                      <td className="p-4 text-ink-3">{emp.team?.name || "\u2014"}</td>
                      <td className={`p-4 text-center ${loadColor}`}>{emp.accountCount}</td>
                      <td className="p-4 text-center text-ink">{emp.openTaskCount}</td>
                      <td className="p-4 text-center">
                        {(emp.tasksByPriority?.critical ?? 0) > 0
                          ? <span className="rounded-full px-3 py-1 text-xs font-medium bg-[rgba(231,76,60,0.1)] text-danger">{emp.tasksByPriority.critical}</span>
                          : <span className="text-sm text-ink-4">—</span>}
                      </td>
                      <td className="p-4 text-center">
                        {(emp.tasksByPriority?.high ?? 0) > 0
                          ? <span className="rounded-full px-3 py-1 text-xs font-medium bg-[rgba(245,166,35,0.12)] text-gold">{emp.tasksByPriority.high}</span>
                          : <span className="text-sm text-ink-4">—</span>}
                      </td>
                      <td className="p-4">
                        <div className="flex flex-wrap gap-1">
                          {emp.accounts?.slice(0, 5).map((acc: any) => (
                            <span key={acc.id} title={acc.platform?.name} className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium bg-action-soft text-ink">
                              <PlatformIcon slug={acc.platform?.slug} className="h-3 w-3 shrink-0" />
                              {acc.handle}
                            </span>
                          ))}
                          {emp.accounts?.length > 5 && (
                            <span className="rounded-full px-3 py-1 text-xs font-medium bg-action-soft text-ink">+{emp.accounts.length - 5}</span>
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
