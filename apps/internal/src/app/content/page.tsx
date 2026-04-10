"use client";
import { useState } from "react";
import Link from "next/link";
import { useContentPosts } from "@/lib/hooks/use-content";
import { useProjects } from "@/lib/hooks/use-projects";
import { Button, Input } from "@dashmani/ui";

const STATUS_OPTIONS = ["", "DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "PUBLISHED", "FAILED", "REJECTED"];
const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending Approval",
  APPROVED: "Approved",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  FAILED: "Failed",
  REJECTED: "Rejected",
};
const STATUS_BADGE: Record<string, string> = {
  DRAFT: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
  PENDING_APPROVAL: "bg-[#FFF3C4] text-[#1A1A1A]",
  APPROVED: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  SCHEDULED: "bg-[rgba(52,152,219,0.12)] text-[#3498DB]",
  PUBLISHED: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  FAILED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
  REJECTED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
};

export default function ContentListPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const { data, isLoading } = useContentPosts({ search, status, projectId });
  const { data: projectsData } = useProjects();
  const posts = (data as any)?.data || [];
  const projects = (projectsData as any)?.data || [];

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Content</h1>
        <div className="flex items-center gap-2">
          <Link href="/content/calendar">
            <Button variant="outline" className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">Calendar View</Button>
          </Link>
          <Link href="/content/new">
            <Button className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">+ New Content</Button>
          </Link>
        </div>
      </div>

      <div className="flex gap-3 items-center flex-wrap crx-animate-slide crx-delay-1">
        <div className="relative max-w-xs">
          <Input placeholder="Search content..." value={search} onChange={(e) => setSearch(e.target.value)} className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
        </div>
        <select
          className="h-10 rounded-lg border border-[#E8E0D0] bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All Statuses</option>
          {STATUS_OPTIONS.filter(Boolean).map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
        <select
          className="h-10 rounded-lg border border-[#E8E0D0] bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">All Projects</option>
          {projects.map((p: any) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="text-center text-[#7A7A7A] py-8">Loading content...</div>
      ) : posts.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] py-8 text-center text-[#7A7A7A]">
          No content posts found.
        </div>
      ) : (
        <div className="bg-white border border-[#E8E0D0] rounded-2xl overflow-x-auto shadow-[0_2px_16px_rgba(0,0,0,0.05)] crx-animate-slide crx-delay-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0EAD8]">
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Title</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Project</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Account</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Scheduled</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Created By</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post: any) => (
                <tr key={post.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                  <td className="p-4">
                    <Link href={`/content/${post.id}`} className="text-[#1A1A1A] hover:text-[#F5D547] font-medium">
                      {post.title}
                    </Link>
                    {post.mediaUrls?.length > 0 && (
                      <span className="ml-2 text-xs text-[#B0B0B0]">({post.mediaUrls.length} media)</span>
                    )}
                  </td>
                  <td className="p-4 text-[#7A7A7A]">{post.project?.name}</td>
                  <td className="p-4 text-[#7A7A7A]">
                    {post.account ? `${post.account.platform?.name}: ${post.account.handle}` : "--"}
                  </td>
                  <td className="p-4">
                    <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_BADGE[post.status] || "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>
                      {STATUS_LABELS[post.status] || post.status}
                    </span>
                  </td>
                  <td className="p-4 text-[#7A7A7A]">
                    {post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : "--"}
                  </td>
                  <td className="p-4 text-[#7A7A7A]">{post.createdBy?.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
