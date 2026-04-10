"use client";
import { useState } from "react";
import Link from "next/link";
import { useClientProjects } from "@/lib/hooks/use-projects";
import { Search, FolderOpen, ArrowRight } from "lucide-react";

const STATUS_STYLES: Record<string, { badge: string; accent: string }> = {
  ACTIVE: {
    badge: "bg-green-50 text-green-700 border border-green-200",
    accent: "border-l-green-400",
  },
  PAUSED: {
    badge: "bg-amber-50 text-amber-700 border border-amber-200",
    accent: "border-l-amber-400",
  },
  COMPLETED: {
    badge: "bg-blue-50 text-blue-700 border border-blue-200",
    accent: "border-l-blue-400",
  },
  ARCHIVED: {
    badge: "bg-gray-50 text-gray-500 border border-gray-200",
    accent: "border-l-gray-300",
  },
};

const DEFAULT_STYLE = {
  badge: "bg-gray-50 text-gray-500 border border-gray-200",
  accent: "border-l-gray-300",
};

export default function ProjectsPage() {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useClientProjects({ search });
  const projects = (data as any)?.data || [];

  return (
    <div className="space-y-6 crx-animate-fade">
      {/* Header */}
      <div className="crx-animate-slide crx-delay-1 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h2 className="font-serif text-4xl font-light text-[#1A1A1A]">Projects</h2>
          <p className="text-[#7A7A7A] mt-1">
            {isLoading
              ? "Loading..."
              : `${projects.length} project${projects.length !== 1 ? "s" : ""}`}
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="crx-animate-slide crx-delay-2 relative max-w-md">
        <div className="crx-glass rounded-full border border-[#E8E0D0] flex items-center px-4 py-2.5 focus-within:border-[#F5D547] focus-within:shadow-[0_0_0_3px_rgba(245,213,71,0.12)] transition-all duration-300">
          <Search className="h-4 w-4 text-[#B0B0B0] mr-3 flex-shrink-0" />
          <input
            placeholder="Search projects..."
            className="w-full text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] bg-transparent outline-none"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 border-2 border-[#E8E0D0] border-b-2 border-b-[#F5D547] rounded-full animate-spin" />
        </div>
      ) : projects.length === 0 ? (
        <div className="crx-animate-slide crx-delay-3 bg-white rounded-2xl border border-[#E8E0D0] py-16 text-center">
          <div className="h-12 w-12 rounded-xl bg-[#FFF3C4] flex items-center justify-center mx-auto mb-3">
            <FolderOpen className="h-6 w-6 text-[#B8960C]" />
          </div>
          <p className="text-[#7A7A7A] font-medium">No projects found</p>
          <p className="text-sm text-[#B0B0B0] mt-1">Try adjusting your search</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {projects.map((p: any, idx: number) => {
            const style = STATUS_STYLES[p.status] || DEFAULT_STYLE;
            return (
              <Link key={p.id} href={`/projects/${p.id}`} className="group block">
                <div
                  className={`crx-animate-slide crx-delay-${Math.min(idx + 3, 6)} bg-white rounded-2xl border border-[#E8E0D0] border-l-[3px] ${style.accent} p-5 hover:border-[#F5D547]/50 hover:shadow-[0_8px_32px_rgba(0,0,0,0.06)] transition-all duration-300`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div className="h-11 w-11 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
                      <FolderOpen className="h-5 w-5 text-[#B8960C]" />
                    </div>
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase ${style.badge}`}
                    >
                      {p.status}
                    </span>
                  </div>
                  <h3 className="font-semibold text-[#1A1A1A] text-base mb-1">{p.name}</h3>
                  <p className="text-xs text-[#7A7A7A]">
                    {p._count?.tasks || 0} tasks · {p._count?.files || 0} files · {p._count?.approvals || 0} approvals
                  </p>
                  <div className="flex items-center gap-1 mt-3 text-xs font-medium text-[#B0B0B0] group-hover:text-[#B8960C] transition-colors">
                    View project <ArrowRight className="h-3 w-3" />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
