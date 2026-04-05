"use client";
import { useWorkload } from "@/lib/hooks/use-accounts";
import { Badge, Card } from "@dashmani/ui";

export default function WorkloadPage() {
  const { data, isLoading } = useWorkload();
  const employees = (data as any)?.data || [];

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Workload Matrix</h2>
      <p className="text-muted-foreground">Employee account assignments and open task load at a glance.</p>

      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left p-4 font-medium">Employee</th>
                  <th className="text-left p-4 font-medium">Team</th>
                  <th className="text-center p-4 font-medium">Accounts</th>
                  <th className="text-center p-4 font-medium">Open Tasks</th>
                  <th className="text-center p-4 font-medium">Critical</th>
                  <th className="text-center p-4 font-medium">High</th>
                  <th className="text-left p-4 font-medium">Assigned Accounts</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((emp: any) => {
                  const load = emp.accountCount + emp.openTaskCount;
                  const loadColor = load > 15 ? "text-red-600 font-semibold" : load > 8 ? "text-yellow-600" : "text-green-600";
                  return (
                    <tr key={emp.id} className="border-b hover:bg-gray-50">
                      <td className="p-4 font-medium">{emp.name}</td>
                      <td className="p-4 text-muted-foreground">{emp.team?.name || "\u2014"}</td>
                      <td className={`p-4 text-center ${loadColor}`}>{emp.accountCount}</td>
                      <td className="p-4 text-center">{emp.openTaskCount}</td>
                      <td className="p-4 text-center">
                        {emp.tasksByPriority.critical > 0 && (
                          <Badge variant="danger">{emp.tasksByPriority.critical}</Badge>
                        )}
                      </td>
                      <td className="p-4 text-center">
                        {emp.tasksByPriority.high > 0 && (
                          <Badge variant="warning">{emp.tasksByPriority.high}</Badge>
                        )}
                      </td>
                      <td className="p-4">
                        <div className="flex flex-wrap gap-1">
                          {emp.accounts?.slice(0, 5).map((acc: any) => (
                            <Badge key={acc.id} variant="secondary" className="text-[10px]">
                              {acc.platform?.name?.slice(0, 2)}: {acc.handle}
                            </Badge>
                          ))}
                          {emp.accounts?.length > 5 && (
                            <Badge variant="secondary" className="text-[10px]">+{emp.accounts.length - 5}</Badge>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
