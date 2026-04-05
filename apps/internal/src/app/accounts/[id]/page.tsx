"use client";
import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAccount } from "@/lib/hooks/use-accounts";
import { Button, Badge, Card, CardContent, CardHeader, CardTitle } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

export default function AccountDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { data, isLoading, mutate } = useAccount(id as string);
  const [employees, setEmployees] = useState<any[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState("");
  const [assigning, setAssigning] = useState(false);

  useEffect(() => {
    apiFetch("/employees?limit=100").then((res: any) => setEmployees(res.data || []));
  }, []);

  if (isLoading) return <div>Loading...</div>;
  const account = (data as any)?.data;
  if (!account) return <div>Account not found</div>;

  const activeAssignments = account.assignments?.filter((a: any) => !a.unassignedAt) || [];
  const pastAssignments = account.assignments?.filter((a: any) => a.unassignedAt) || [];

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

  const statusColor: Record<string, "success" | "warning" | "secondary"> = {
    ACTIVE: "success", PAUSED: "warning", ARCHIVED: "secondary",
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold">{account.displayName}</h2>
          <p className="text-muted-foreground">{account.handle} on {account.platform?.name}</p>
          <div className="flex gap-2 mt-2">
            <Badge variant={statusColor[account.status]}>{account.status}</Badge>
            <Badge variant="secondary">{account.followerCount?.toLocaleString()} followers</Badge>
          </div>
        </div>
        <Button variant="outline" onClick={() => router.push("/accounts")}>Back</Button>
      </div>

      {account.clientName && (
        <Card>
          <CardContent className="p-6">
            <span className="text-sm text-muted-foreground">Client:</span>{" "}
            <span className="font-medium">{account.clientName}</span>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Active Assignments ({activeAssignments.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {activeAssignments.map((a: any) => (
            <div key={a.id} className="flex items-center justify-between border-b pb-2 last:border-0">
              <div>
                <span className="font-medium text-sm">{a.employee?.name}</span>
                <span className="text-xs text-muted-foreground ml-2">since {new Date(a.assignedAt).toLocaleDateString()}</span>
                {a.reason && <p className="text-xs text-muted-foreground">{a.reason}</p>}
              </div>
              <Button variant="outline" size="sm" onClick={() => handleUnassign(a.employee.id)}>Remove</Button>
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <select
              className="flex-1 h-10 rounded-md border border-border bg-white px-3 text-sm"
              value={selectedEmployee}
              onChange={(e) => setSelectedEmployee(e.target.value)}
            >
              <option value="">Select employee to assign</option>
              {employees
                .filter((emp: any) => !activeAssignments.some((a: any) => a.employee?.id === emp.id))
                .map((emp: any) => (
                  <option key={emp.id} value={emp.id}>{emp.name}</option>
                ))}
            </select>
            <Button onClick={handleAssign} disabled={!selectedEmployee || assigning}>
              {assigning ? "..." : "Assign"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {pastAssignments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Assignment History</CardTitle>
          </CardHeader>
          <CardContent>
            {pastAssignments.map((a: any) => (
              <div key={a.id} className="text-sm border-b pb-2 mb-2 last:border-0">
                <span className="font-medium">{a.employee?.name}</span>
                <span className="text-muted-foreground ml-2">
                  {new Date(a.assignedAt).toLocaleDateString()} &mdash; {new Date(a.unassignedAt).toLocaleDateString()}
                </span>
                {a.assigner && <span className="text-xs text-muted-foreground ml-2">by {a.assigner.name}</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
