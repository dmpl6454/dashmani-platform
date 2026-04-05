"use client";
import { useState } from "react";
import Link from "next/link";
import { useContentPosts } from "@/lib/hooks/use-content";
import { useProjects } from "@/lib/hooks/use-projects";
import { Button, Input, Badge, Card, CardContent } from "@dashmani/ui";

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
const STATUS_COLOR: Record<string, "default" | "secondary" | "warning" | "danger"> = {
  DRAFT: "secondary",
  PENDING_APPROVAL: "warning",
  APPROVED: "default",
  SCHEDULED: "default",
  PUBLISHED: "default",
  FAILED: "danger",
  REJECTED: "danger",
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Content</h2>
        <div className="flex items-center gap-2">
          <Link href="/content/calendar">
            <Button variant="outline">Calendar View</Button>
          </Link>
          <Link href="/content/new">
            <Button>+ New Content</Button>
          </Link>
        </div>
      </div>

      <div className="flex gap-3 items-center flex-wrap">
        <div className="relative max-w-xs">
          <Input placeholder="Search content..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select
          className="h-10 rounded-md border border-border bg-white px-3 py-2 text-sm"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All Statuses</option>
          {STATUS_OPTIONS.filter(Boolean).map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
        <select
          className="h-10 rounded-md border border-border bg-white px-3 py-2 text-sm"
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
        <div className="text-center text-muted-foreground py-8">Loading content...</div>
      ) : posts.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No content posts found.
          </CardContent>
        </Card>
      ) : (
        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left p-4 font-medium">Title</th>
                <th className="text-left p-4 font-medium">Project</th>
                <th className="text-left p-4 font-medium">Account</th>
                <th className="text-left p-4 font-medium">Status</th>
                <th className="text-left p-4 font-medium">Scheduled</th>
                <th className="text-left p-4 font-medium">Created By</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post: any) => (
                <tr key={post.id} className="border-b hover:bg-gray-50">
                  <td className="p-4">
                    <Link href={`/content/${post.id}`} className="text-brand-blue hover:underline font-medium">
                      {post.title}
                    </Link>
                    {post.mediaUrls?.length > 0 && (
                      <span className="ml-2 text-xs text-muted-foreground">({post.mediaUrls.length} media)</span>
                    )}
                  </td>
                  <td className="p-4 text-muted-foreground">{post.project?.name}</td>
                  <td className="p-4 text-muted-foreground">
                    {post.account ? `${post.account.platform?.name}: ${post.account.handle}` : "--"}
                  </td>
                  <td className="p-4">
                    <Badge variant={STATUS_COLOR[post.status] || "secondary"}>
                      {STATUS_LABELS[post.status] || post.status}
                    </Badge>
                  </td>
                  <td className="p-4 text-muted-foreground">
                    {post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : "--"}
                  </td>
                  <td className="p-4 text-muted-foreground">{post.createdBy?.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
