"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useClientContentPost } from "@/lib/hooks/use-content";
import { Button, Badge, Card, CardContent, CardHeader, CardTitle } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

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

export default function ClientContentDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { data, isLoading, mutate } = useClientContentPost(id as string);
  const [responding, setResponding] = useState(false);

  if (isLoading) return <div className="py-8 text-center text-muted-foreground">Loading...</div>;
  const post = (data as any)?.data;
  if (!post) return <div className="py-8 text-center text-muted-foreground">Content not found</div>;

  async function handleRespond(status: "APPROVED" | "REJECTED") {
    setResponding(true);
    try {
      await apiFetch(`/client/content/${id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      });
      mutate();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setResponding(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold">{post.title}</h2>
          <div className="flex gap-2 mt-2">
            <Badge variant={STATUS_COLOR[post.status] || "secondary"}>
              {STATUS_LABELS[post.status] || post.status}
            </Badge>
          </div>
        </div>
        <Button variant="outline" onClick={() => router.push("/content")}>Back</Button>
      </div>

      <Card>
        <CardContent className="p-6 space-y-4">
          {post.caption && (
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-1">Caption</h4>
              <p className="text-sm whitespace-pre-wrap">{post.caption}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Project:</span> {post.project?.name}
            </div>
            <div>
              <span className="text-muted-foreground">Account:</span>{" "}
              {post.account ? `${post.account.platform?.name}: ${post.account.handle}` : "--"}
            </div>
            <div>
              <span className="text-muted-foreground">Scheduled:</span>{" "}
              {post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : "--"}
            </div>
            <div>
              <span className="text-muted-foreground">Created by:</span> {post.createdBy?.name}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Media */}
      {post.mediaUrls?.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Media ({post.mediaUrls.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {post.mediaUrls.map((url: string, i: number) => (
                <div key={i} className="border rounded-md overflow-hidden">
                  <img
                    src={url}
                    alt={`Media ${i + 1}`}
                    className="w-full h-40 object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                      (e.target as HTMLImageElement).parentElement!.innerHTML = `<div class="flex items-center justify-center h-40 bg-gray-100 text-xs text-muted-foreground p-2 break-all">${url}</div>`;
                    }}
                  />
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-2 text-xs text-brand-blue hover:underline truncate"
                  >
                    {url}
                  </a>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Approve / Reject */}
      {post.status === "PENDING_APPROVAL" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your Review</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              This content is waiting for your approval before it can be scheduled for publishing.
            </p>
            <div className="flex gap-3">
              <Button onClick={() => handleRespond("APPROVED")} disabled={responding}>
                {responding ? "..." : "Approve"}
              </Button>
              <Button variant="outline" onClick={() => handleRespond("REJECTED")} disabled={responding}>
                {responding ? "..." : "Reject"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
