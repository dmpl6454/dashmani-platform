"use client";
import { useState } from "react";
import Link from "next/link";
import { useAccounts, usePlatforms } from "@/lib/hooks/use-accounts";
import { Button, Input } from "@dashmani/ui";

export default function AccountsPage() {
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState("");
  const { data, isLoading } = useAccounts({ search, platformId: platformFilter });
  const { data: platformData } = usePlatforms();
  const accounts = (data as any)?.data || [];
  const platforms = (platformData as any)?.data || [];

  const statusBadge: Record<string, string> = {
    ACTIVE: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
    PAUSED: "bg-[#FFF3C4] text-[#1A1A1A]",
    ARCHIVED: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
  };

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Social Accounts</h1>
        <Link href="/accounts/new">
          <Button className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">+ Add Account</Button>
        </Link>
      </div>

      <div className="flex gap-3 crx-animate-slide crx-delay-1">
        <div className="relative max-w-sm">
          <Input placeholder="Search accounts..." value={search} onChange={(e) => setSearch(e.target.value)} className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
        </div>
        <select
          className="h-10 rounded-lg border border-[#E8E0D0] bg-white px-3 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
          value={platformFilter}
          onChange={(e) => setPlatformFilter(e.target.value)}
        >
          <option value="">All Platforms</option>
          {platforms.map((p: any) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-2">
        <div className="overflow-x-auto max-h-[calc(100vh-220px)] overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0EAD8] sticky top-0 bg-white z-10">
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Account</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Platform</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Client</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Assigned To</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Followers</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="p-4 text-center text-[#7A7A7A]">Loading...</td></tr>
              ) : accounts.length === 0 ? (
                <tr><td colSpan={6} className="p-4 text-center text-[#7A7A7A]">No accounts found</td></tr>
              ) : (
                accounts.map((acc: any) => (
                  <tr key={acc.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                    <td className="p-4">
                      <Link href={`/accounts/${acc.id}`} className="text-[#1A1A1A] hover:text-[#F5D547] font-medium">
                        {acc.displayName}
                      </Link>
                      <p className="text-xs text-[#7A7A7A]">{acc.handle}</p>
                    </td>
                    <td className="p-4"><span className="rounded-full px-3 py-1 text-xs font-medium bg-[#FFF3C4] text-[#1A1A1A]">{acc.platform?.name}</span></td>
                    <td className="p-4 text-[#7A7A7A]">{acc.clientName || "\u2014"}</td>
                    <td className="p-4">
                      <div className="flex flex-col gap-0.5">
                        {acc.assignments?.length > 0 ? acc.assignments.map((a: any) => (
                          <span key={a.id} className="text-xs text-[#1A1A1A]">{a.employee?.name}</span>
                        )) : <span className="text-xs text-[#F5A623]">Unassigned</span>}
                      </div>
                    </td>
                    <td className="p-4 text-[#7A7A7A]">{acc.followerCount?.toLocaleString()}</td>
                    <td className="p-4">
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge[acc.status] || "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>
                        {acc.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
