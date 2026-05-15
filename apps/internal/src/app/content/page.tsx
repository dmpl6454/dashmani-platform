"use client";
import { useState } from "react";
import Link from "next/link";
import { useContentPosts } from "@/lib/hooks/use-content";
import { useProjects } from "@/lib/hooks/use-projects";
import { Plus, Search, FileEdit } from "lucide-react";

const STATUS_OPTIONS = ["", "DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "PUBLISHED", "FAILED", "REJECTED"];
const STATUS_LABELS: Record<string, string> = {
  DRAFT:            "Draft",
  PENDING_APPROVAL: "Needs Review",
  APPROVED:         "Approved",
  SCHEDULED:        "Scheduled",
  PUBLISHED:        "Published",
  FAILED:           "Failed",
  REJECTED:         "Rejected",
};
const STATUS_BADGE: Record<string, string> = {
  DRAFT:            "bg-neutral-bg text-neutral border-neutral/20",
  PENDING_APPROVAL: "bg-attention-bg text-attention border-attention/20",
  APPROVED:         "bg-success-bg text-success border-success/20",
  SCHEDULED:        "bg-indigo-soft text-indigo border-indigo/20",
  PUBLISHED:        "bg-success-bg text-success border-success/20",
  FAILED:           "bg-danger-bg text-danger border-danger/20",
  REJECTED:         "bg-danger-bg text-danger border-danger/20",
};

const selectCls = "h-10 rounded-xl border-2 border-ink/15 bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:border-indigo transition-colors";

export default function ContentListPage() {
  const [search,    setSearch]    = useState("");
  const [status,    setStatus]    = useState("");
  const [projectId, setProjectId] = useState("");
  const { data, isLoading }     = useContentPosts({ search, status, projectId });
  const { data: projectsData }  = useProjects();
  const posts    = (data as any)?.data || [];
  const projects = (projectsData as any)?.data || [];

  return (
    <div className="space-y-5 pop-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink">Content</h1>
          {!isLoading && <p className="text-sm text-ink-4 mt-0.5">{posts.length} post{posts.length !== 1 ? "s" : ""}</p>}
        </div>
        <div className="flex gap-2">
          <Link href="/content/calendar">
            <button className="h-9 px-4 rounded-full border-2 border-ink/15 text-sm font-semibold text-ink-3 hover:bg-muted transition-colors">
              Calendar
            </button>
          </Link>
          <Link href="/content/new">
            <button className="h-9 px-4 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors flex items-center gap-1.5">
              <Plus className="h-4 w-4" /> New Content
            </button>
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 items-center flex-wrap fade-up d2">
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-4" />
          <input
            placeholder="Search content…"
            className="pl-10 pr-4 h-10 w-56 bg-surface border-2 border-ink/15 rounded-xl text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:border-indigo transition-colors"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All Statuses</option>
          {STATUS_OPTIONS.filter(Boolean).map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
        <select className={selectCls} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All Projects</option>
          {projects.map((p: any) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="v3-card overflow-hidden fade-up d3">
        {isLoading ? (
          <div className="py-14 flex items-center justify-center">
            <div className="h-6 w-6 rounded-full border-[3px] border-ink/10 border-t-indigo" style={{ animation: "spin 0.7s linear infinite" }} />
          </div>
        ) : posts.length === 0 ? (
          <div className="py-14 text-center text-ink-4">
            <FileEdit className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No content posts found</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-ink/8 bg-muted/40">
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider">Title</th>
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider hidden md:table-cell">Project</th>
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider hidden lg:table-cell">Account</th>
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider">Status</th>
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider hidden xl:table-cell">Scheduled</th>
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider hidden xl:table-cell">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {posts.map((post: any, i: number) => (
                  <tr key={post.id} className="v3-row" style={{ animationDelay: `${i * 0.02}s` }}>
                    <td className="px-5 py-3">
                      <Link href={`/content/${post.id}`} className="font-semibold text-ink hover:text-indigo transition-colors">
                        {post.title}
                      </Link>
                      {post.mediaUrls?.length > 0 && (
                        <span className="ml-2 text-[10px] font-medium text-ink-4 bg-muted px-1.5 py-0.5 rounded">{post.mediaUrls.length} media</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-ink-3 hidden md:table-cell">{post.project?.name || "—"}</td>
                    <td className="px-5 py-3 text-ink-3 hidden lg:table-cell">
                      {post.account ? `${post.account.platform?.name}: ${post.account.handle}` : "—"}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold border ${STATUS_BADGE[post.status] || "bg-neutral-bg text-neutral border-neutral/20"}`}>
                        {STATUS_LABELS[post.status] || post.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-ink-3 hidden xl:table-cell">
                      {post.scheduledAt ? new Date(post.scheduledAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—"}
                    </td>
                    <td className="px-5 py-3 text-ink-3 hidden xl:table-cell">{post.createdBy?.name || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
