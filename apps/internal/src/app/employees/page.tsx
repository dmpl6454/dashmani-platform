"use client";
import { useState } from "react";
import Link from "next/link";
import { useEmployees } from "@/lib/hooks/use-employees";
import { Button, Badge, Card, Input } from "@dashmani/ui";
import { Plus, Search } from "lucide-react";

export default function EmployeesPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useEmployees({ search });
  const employees = (data as any)?.data || [];

  const statusColor: Record<string, "success" | "warning" | "secondary"> = {
    ACTIVE: "success",
    ONBOARDING: "warning",
    INACTIVE: "secondary",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Employees</h2>
        <Link href="/employees/new">
          <Button><Plus className="h-4 w-4 mr-2" /> Add Employee</Button>
        </Link>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search employees..."
          className="pl-10"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left p-4 font-medium">Name</th>
                <th className="text-left p-4 font-medium">Email</th>
                <th className="text-left p-4 font-medium">Roles</th>
                <th className="text-left p-4 font-medium">Team</th>
                <th className="text-left p-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">Loading...</td></tr>
              ) : employees.length === 0 ? (
                <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">No employees found</td></tr>
              ) : (
                employees.map((emp: any) => (
                  <tr key={emp.id} className="border-b hover:bg-gray-50">
                    <td className="p-4">
                      <Link href={`/employees/${emp.id}`} className="text-brand-blue hover:underline font-medium">
                        {emp.name}
                      </Link>
                    </td>
                    <td className="p-4 text-muted-foreground">{emp.email}</td>
                    <td className="p-4">
                      <div className="flex gap-1">
                        {emp.roles?.map((r: any) => (
                          <Badge key={r.id}>{r.name}</Badge>
                        ))}
                      </div>
                    </td>
                    <td className="p-4 text-muted-foreground">{emp.orgUnit?.name || "—"}</td>
                    <td className="p-4"><Badge variant={statusColor[emp.status] || "secondary"}>{emp.status}</Badge></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
