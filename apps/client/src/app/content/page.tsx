"use client";
import { useState } from "react";
import Link from "next/link";
import { useClientContent } from "@/lib/hooks/use-content";
import { Card, CardContent, Badge, Input } from "@dashmani/ui";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending Your Approval",
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

const STATUS_FILTERS = ["", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "PUBLISHED", "REJECTED"];

export default function ClientContentPage() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const { data, isLoading } = useClientContent({ status, search });
  const posts = (data as any)?.data || [];

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-bold">Content</h2>

      <div className="flex gap-3 items-center flex-wrap">
        <div className="relative max-w-xs">
          <Input placeholder="Search content..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-2">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1 rounded-full text-sm ${
                status === s ? "bg-brand-blue text-white" : "bg-gray-100 text-gray-600"
              }`}
            >
              {s ? STATUS_LABELS[s] || s : "All"}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading...</p>
      ) : posts.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No content found.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {posts.map((post: any) => (
            <Link key={post.id} href={`/content/${post.id}`}>
              <Card className="hover:border-brand-blue transition-colors cursor-pointer">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="font-medium">{post.title}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">{post.project?.name}</p>
                      {post.caption && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{post.caption}</p>
                      )}
                      <div className="flex gap-3 mt-2 text-xs text-muted-foreground">
                        {post.account && (
                          <span>{post.account.platform?.name}: {post.account.handle}</span>
                        )}
                        {post.scheduledAt && (
                          <span>Scheduled: {new Date(post.scheduledAt).toLocaleString()}</span>
                        )}
                        {post.mediaUrls?.length > 0 && (
                          <span>{post.mediaUrls.length} media file(s)</span>
                        )}
                      </div>
                    </div>
                    <Badge variant={STATUS_COLOR[post.status] || "secondary"}>
                      {STATUS_LABELS[post.status] || post.status}
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
