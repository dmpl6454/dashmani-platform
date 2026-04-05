"use client";
import { useState } from "react";
import Link from "next/link";
import { useAccounts, usePlatforms } from "@/lib/hooks/use-accounts";
import { Button, Badge, Card, Input } from "@dashmani/ui";

export default function AccountsPage() {
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");
  const { data, isLoading } = useAccounts({ search, platformId: platformFilter });
  const { data: platformData } = usePlatforms();
  const accounts = (data as any)?.data || [];
  const platforms = (platformData as any)?.data || [];

  const statusColor: Record<string, "success" | "warning" | "secondary"> = {
    ACTIVE: "success", PAUSED: "warning", ARCHIVED: "secondary",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Social Accounts</h2>
        <Link href="/accounts/new">
          <Button>+ Add Account</Button>
        </Link>
      </div>

      <div className="flex gap-3">
        <div className="relative max-w-sm">
          <Input placeholder="Search accounts..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select
          className="h-10 rounded-md border border-border bg-white px-3 text-sm"
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
        >
          <option value="">All Platforms</option>
          {platforms.map((p: any) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left p-4 font-medium">Account</th>
                <th className="text-left p-4 font-medium">Platform</th>
                <th className="text-left p-4 font-medium">Client</th>
                <th className="text-left p-4 font-medium">Assigned To</th>
                <th className="text-left p-4 font-medium">Followers</th>
                <th className="text-left p-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">Loading...</td></tr>
              ) : accounts.length === 0 ? (
                <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">No accounts found</td></tr>
              ) : (
                accounts.map((acc: any) => (
                  <tr key={acc.id} className="border-b hover:bg-gray-50">
                    <td className="p-4">
                      <Link href={`/accounts/${acc.id}`} className="text-brand-blue hover:underline font-medium">
                        {acc.displayName}
                      </Link>
                      <p className="text-xs text-muted-foreground">{acc.handle}</p>
                    </td>
                    <td className="p-4"><Badge>{acc.platform?.name}</Badge></td>
                    <td className="p-4 text-muted-foreground">{acc.clientName || "\u2014"}</td>
                    <td className="p-4">
                      <div className="flex flex-col gap-0.5">
                        {acc.assignments?.length > 0 ? acc.assignments.map((a: any) => (
                          <span key={a.id} className="text-xs">{a.employee?.name}</span>
                        )) : <span className="text-xs text-orange-500">Unassigned</span>}
                      </div>
                    </td>
                    <td className="p-4 text-muted-foreground">{acc.followerCount?.toLocaleString()}</td>
                    <td className="p-4"><Badge variant={statusColor[acc.status]}>{acc.status}</Badge></td>
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
