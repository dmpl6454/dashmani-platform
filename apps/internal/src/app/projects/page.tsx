"use client";
import { useState } from "react";
import Link from "next/link";
import { useProjects } from "@/lib/hooks/use-projects";
import { Button, Input } from "@dashmani/ui";
import { Plus, Search, FolderOpen } from "lucide-react";

export default function ProjectsPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useProjects({ search });
  const projects = (data as any)?.data || [];

  const statusBadge: Record<string, string> = {
    ACTIVE: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
    PAUSED: "bg-[#FFF3C4] text-[#1A1A1A]",
    COMPLETED: "bg-[rgba(52,152,219,0.12)] text-[#3498DB]",
    ARCHIVED: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
  };

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Projects</h1>
        <Link href="/projects/new"><Button className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]"><Plus className="h-4 w-4 mr-2" /> New Project</Button></Link>
      </div>
      <div className="relative max-w-sm crx-animate-slide crx-delay-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#B0B0B0]" />
        <Input placeholder="Search projects..." className="pl-10 border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {isLoading ? <p className="text-[#7A7A7A]">Loading...</p> : (
        <div className="grid gap-3">
          {projects.map((p: any, i: number) => (
            <Link key={p.id} href={`/projects/${p.id}`}>
              <div className={`bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] p-4 flex items-center justify-between transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] cursor-pointer crx-animate-slide crx-delay-${Math.min(i + 2, 6)}`}>
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
                    <FolderOpen className="h-5 w-5 text-[#1A1A1A]" />
                  </div>
                  <div>
                    <p className="font-medium text-[#1A1A1A]">{p.name}</p>
                    <p className="text-xs text-[#7A7A7A]">{p.client?.companyName} · {p._count?.tasks || 0} tasks</p>
                  </div>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge[p.status] || "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>
                  {p.status}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
